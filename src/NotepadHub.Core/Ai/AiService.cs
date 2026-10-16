using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace NotepadHub.Core.Ai;

/// <summary>An error that the page should show as a normal HTTP-style failure (status + message). Never carries note text or keys.</summary>
public sealed class AiHttpException : Exception
{
    public int Status { get; }
    public AiHttpException(int status, string message) : base(message) { Status = status; }
}

public interface IAiSecretStore
{
    string? GetOpenRouterKey();
    void SetOpenRouterKey(string key);
    void ClearOpenRouterKey();
}

/// <summary>OpenRouter key: the OPENROUTER_API_KEY environment variable wins, otherwise a Windows DPAPI-protected file (this user, this PC). The key is never sent to the page.</summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class DpapiSecretStore : IAiSecretStore
{
    private readonly string _path;
    public DpapiSecretStore(string dataRoot) { _path = Path.Combine(dataRoot, "openrouter.key.dpapi"); }

    public string? GetOpenRouterKey()
    {
        var env = Environment.GetEnvironmentVariable("OPENROUTER_API_KEY");
        if (!string.IsNullOrWhiteSpace(env)) return env.Trim();
        try
        {
            if (!File.Exists(_path)) return null;
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(_path), Encoding.UTF8.GetBytes("NotepadHub.OpenRouter"), DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plain);
        }
        catch { return null; }
    }

    public void SetOpenRouterKey(string key)
    {
        key = (key ?? "").Trim();
        if (key.Length < 16 || key.Length > 400 || key.Any(char.IsWhiteSpace)) throw new ArgumentException("Ключ выглядит некорректно.");
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllBytes(_path, ProtectedData.Protect(Encoding.UTF8.GetBytes(key), Encoding.UTF8.GetBytes("NotepadHub.OpenRouter"), DataProtectionScope.CurrentUser));
    }

    public void ClearOpenRouterKey() { try { if (File.Exists(_path)) File.Delete(_path); } catch { } }
}

/// <summary>
/// AI provider router running in the host (not in the page): Ollama on this computer, OpenRouter on explicit consent.
/// Limits: cloud 90 s total; local model 4 min to the first token, then a 60 s stall limit (15 min at most); 24 000 characters in and out, 512/1536 output tokens, 10 cloud requests per minute and 100 per day,
/// one automatic retry only for transient failures before the first byte, hard cost ceiling per request.
/// </summary>
/// <summary>What the user is asked to approve before text leaves the computer.</summary>
public sealed record CloudSendInfo(string Model, double EstimateUsd, int Chars, bool Paid, string Service = "OpenRouter", bool PriceUnknown = false);

public sealed class AiService
{
    private const int RequestTimeoutMs = 90_000;
    // The local model runs on the user's processor: a 1,500-character rewrite takes 30-90 s and loading the model can take longer than the first answer.
    // So the cloud keeps its hard 90 s, while the local request waits for the first token for 4 minutes and then only for a stall of 60 s between tokens (15 minutes at most).
    private const int LocalFirstTokenMs = 240_000;
    private const int LocalStallMs = 60_000;
    private const int LocalTotalMs = 15 * 60_000;
    private const int MaxChars = 24_000;
    private const double HardCostCeilingUsd = 0.25;
    private const int CloudPerMinute = 10, CloudPerDay = 100;
    private const string OpenRouterModelsUrl = "https://openrouter.ai/api/v1/models";
    private const string OpenRouterChatUrl = "https://openrouter.ai/api/v1/chat/completions";

    private readonly HttpClient _http;
    private readonly IAiSecretStore _secrets;
    private readonly Action<string> _log;
    private Uri _ollama;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _active = new();
    private readonly object _rateLock = new();
    private readonly IAiUsageStore _usage;
    private readonly Func<CloudSendInfo, Task<bool>>? _confirmCloud;
    private readonly HashSet<string> _approvedFree = new();
    private readonly CompatServiceStore? _compat;
    private AiUsageData? _data;
    private readonly double _monthlyBudgetUsd;
    private (DateTime Expires, List<OpenRouterModel> Models)? _modelCache;
    private int _localBusy;

    public AiService(HttpClient http, IAiSecretStore secrets, Action<string>? log = null, Uri? ollamaBase = null, IAiUsageStore? usage = null, double? monthlyBudgetUsd = null, Func<CloudSendInfo, Task<bool>>? confirmCloud = null, CompatServiceStore? compat = null)
    {
        _confirmCloud = confirmCloud;
        _compat = compat;
        _http = http; _secrets = secrets; _log = log ?? (_ => { });
        _usage = usage ?? new MemoryAiUsageStore();
        var envBudget = Environment.GetEnvironmentVariable("NOTEPADHUB_AI_MONTHLY_USD");
        _monthlyBudgetUsd = monthlyBudgetUsd ?? (double.TryParse(envBudget, NumberStyles.Float, CultureInfo.InvariantCulture, out var b) && b >= 0 ? b : 5.0);
        var env = Environment.GetEnvironmentVariable("OLLAMA_HOST");
        _ollama = ollamaBase ?? (Uri.TryCreate(string.IsNullOrWhiteSpace(env) ? "http://127.0.0.1:11434" : (env!.Contains("://") ? env : "http://" + env), UriKind.Absolute, out var u) ? u : new Uri("http://127.0.0.1:11434"));
        // OLLAMA_HOST=0.0.0.0 is the address the server listens on, not one a client can call: use the local address
        if (_ollama.Host is "0.0.0.0" or "[::]" or "::") _ollama = new UriBuilder(_ollama) { Host = "127.0.0.1" }.Uri;
        if (!(_ollama.IsLoopback)) throw new InvalidOperationException("Для приватности Ollama должен быть доступен только на этом компьютере.");
    }

    // ---------------------------------------------------------------- status & models

    public async Task<object> StatusAsync(CancellationToken ct)
    {
        var configured = !string.IsNullOrWhiteSpace(_secrets.GetOpenRouterKey());
        var defaultModel = Environment.GetEnvironmentVariable("OLLAMA_MODEL") ?? "qwen3.5:4b";
        try
        {
            var models = await LocalModelsAsync(ct, 2500);
            var preferred = PreferredLocal(models);
            return Status(models.Count > 0, models, preferred, configured);
        }
        catch { return Status(false, new List<string>(), defaultModel, configured); }
    }

    private object Status(bool connected, List<string> models, string defaultModel, bool configured) => new
    {
        provider = "Ollama", connected, models, defaultModel, defaultProvider = Environment.GetEnvironmentVariable("NOTEPADHUB_AI_DEFAULT") is "ollama" or "local" ? "ollama" : "compat", openRouterConfigured = configured, usage = Usage(),
        providers = new { ollama = new { configured = models.Count > 0, models, defaultModel }, openrouter = new { configured, usage = Usage() }, compat = CompatStatus() },
    };

    private object CompatStatus()
    {
        var cfg = _compat?.Load();
        return new { configured = cfg is not null && (cfg.KeyOptional || (_compat?.HasKey ?? false)), name = cfg?.Name ?? "", baseUrl = cfg?.BaseUrl.AbsoluteUri.TrimEnd('/') ?? "", local = cfg?.Local ?? false, hasKey = _compat?.HasKey ?? false, builtin = cfg?.Builtin ?? false, keyOptional = cfg?.KeyOptional ?? false };
    }

    public void SaveCompat(string baseUrl, string name, string? key)
    {
        if (_compat is null) throw new AiHttpException(503, "Хранилище настроек сервиса недоступно.");
        try { _compat.Save(baseUrl, name, key); }
        catch (ArgumentException ex) { throw new AiHttpException(400, ex.Message); }
    }

    public void ClearCompat() => _compat?.Clear();

    private async Task<List<string>> CompatModelsAsync(CancellationToken ct)
    {
        var cfg = _compat?.Load() ?? throw new AiHttpException(503, "Сервис не настроен: укажите адрес и ключ.");
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct); cts.CancelAfter(10_000);
        using var req = new HttpRequestMessage(HttpMethod.Get, cfg.BaseUrl.AbsoluteUri.TrimEnd('/') + "/models");
        if (_compat!.GetKey() is { Length: > 0 } key) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        try
        {
            using var resp = await _http.SendAsync(req, cts.Token);
            if (!resp.IsSuccessStatusCode) throw new AiHttpException(502, $"Сервис не отдал список моделей (HTTP {(int)resp.StatusCode}). Введите название модели вручную.");
            return CompatServiceStore.ParseModelIds(await resp.Content.ReadAsStringAsync(cts.Token));
        }
        catch (AiHttpException) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException or OperationCanceledException)
        { throw new AiHttpException(502, "Список моделей сервиса недоступен. Введите название модели вручную."); }
    }

    public async Task<object> ModelsAsync(string provider, CancellationToken ct)
    {
        if (provider == "openrouter")
        {
            var models = await OpenRouterModelsAsync(ct);
            return new
            {
                models = models.Select(m => new
                {
                    id = m.Id, name = m.Name,
                    contextLength = m.ContextLength, promptPrice = m.PromptPrice, completionPrice = m.CompletionPrice,
                    free = m.PromptPrice == 0 && m.CompletionPrice == 0,
                }).ToList(),
            };
        }
        if (provider == "compat")
        {
            var ids = await CompatModelsAsync(ct);
            return new { models = ids.Select(id => new { id, name = id, free = false }).ToList(), hidden = new List<object>() };
        }
        if (provider == "ollama")
        {
            (List<InstalledModel> Usable, List<HiddenModel> Hidden) cat;
            try { cat = await CatalogAsync(ct, 4000); }
            catch { throw new AiHttpException(503, "Ollama не отвечает; запустите локальный сервис."); }
            var local = cat.Usable.Select(m => m.Name).ToList();
            var preferred = PreferredLocal(local);
            return new
            {
                models = local.OrderByDescending(n => n == preferred).Select(n => new { id = n, name = n, free = true }).ToList(),
                hidden = cat.Hidden.Select(h => new { name = h.Name, reason = h.Reason }).ToList(),
            };
        }
        throw new AiHttpException(400, "Неизвестный AI-провайдер.");
    }

    private static bool IsCloudModel(string name) => Regex.IsMatch(name, @"(?:^|[-/:])cloud(?:$|[-/:])", RegexOptions.IgnoreCase);

    private async Task<(List<InstalledModel> Usable, List<HiddenModel> Hidden)> CatalogAsync(CancellationToken ct, int timeoutMs)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct); cts.CancelAfter(timeoutMs);
        using var resp = await _http.GetAsync(new Uri(_ollama, "/api/tags"), cts.Token);
        resp.EnsureSuccessStatusCode();
        return LocalModelCatalog.Classify(LocalModelCatalog.Parse(await resp.Content.ReadAsStringAsync(cts.Token)));
    }

    /// <summary>Names of the models that may be used for notes, best first. Cloud aliases never appear here.</summary>
    private async Task<List<string>> LocalModelsAsync(CancellationToken ct, int timeoutMs) =>
        (await CatalogAsync(ct, timeoutMs)).Usable.Select(m => m.Name).ToList();

    private static string PreferredLocal(List<string> models)
    {
        var configured = Environment.GetEnvironmentVariable("OLLAMA_MODEL");
        if (!string.IsNullOrWhiteSpace(configured) && models.Contains(configured)) return configured;
        return models.FirstOrDefault() ?? configured ?? "qwen3.5:4b";
    }

    private sealed record OpenRouterModel(string Id, string Name, int? ContextLength, double? PromptPrice, double? CompletionPrice);

    private async Task<List<OpenRouterModel>> OpenRouterModelsAsync(CancellationToken ct)
    {
        if (_modelCache is { } c && c.Expires > DateTime.UtcNow) return c.Models;
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct); cts.CancelAfter(8000);
        HttpResponseMessage resp;
        try { resp = await _http.GetAsync(OpenRouterModelsUrl, cts.Token); }
        catch (Exception) when (!ct.IsCancellationRequested) { throw new AiHttpException(502, "Каталог OpenRouter недоступен."); }
        using (resp)
        {
            if (!resp.IsSuccessStatusCode) throw new AiHttpException(502, $"Каталог OpenRouter ответил HTTP {(int)resp.StatusCode}");
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(cts.Token));
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) throw new AiHttpException(502, "Каталог OpenRouter вернул некорректный ответ");
            var list = new List<OpenRouterModel>();
            foreach (var item in data.EnumerateArray())
            {
                if (!item.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(id.GetString())) continue;
                var name = item.TryGetProperty("name", out var nm) && nm.ValueKind == JsonValueKind.String ? nm.GetString()! : id.GetString()!;
                if (item.TryGetProperty("architecture", out var arch))
                {
                    var input = Modalities(arch, "input_modalities"); var output = Modalities(arch, "output_modalities");
                    if (!input.Contains("text") || !output.Contains("text")) continue;
                }
                else continue;
                int? ctxLen = item.TryGetProperty("context_length", out var cl) && cl.ValueKind == JsonValueKind.Number && cl.TryGetInt32(out var ci) ? ci : null;
                double? pp = null, cp = null;
                if (item.TryGetProperty("pricing", out var pr))
                {
                    pp = Price(pr, "prompt"); cp = Price(pr, "completion");
                }
                list.Add(new OpenRouterModel(id.GetString()!, name, ctxLen, pp, cp));
            }
            _modelCache = (DateTime.UtcNow.AddSeconds(60), list);
            return list;
        }
    }

    private static HashSet<string> Modalities(JsonElement arch, string key) =>
        arch.TryGetProperty(key, out var a) && a.ValueKind == JsonValueKind.Array ? a.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToHashSet() : new HashSet<string>();

    private static double? Price(JsonElement pricing, string key) =>
        pricing.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && d >= 0 ? d : null;

    // ---------------------------------------------------------------- streaming

    public void Cancel(string requestId) { if (_active.TryRemove(requestId, out var cts)) { try { cts.Cancel(); } catch { } } }

    public void SetKey(string key) => _secrets.SetOpenRouterKey(key);
    public void ClearKey() => _secrets.ClearOpenRouterKey();

    /// <summary>
    /// Validates the request and opens the upstream stream. Failures before the first byte throw <see cref="AiHttpException"/>.
    /// On success the answer is pumped in the background through <paramref name="emit"/> as {model, delta} … {model, done:true} or {error}.
    /// </summary>
    public async Task StartStreamAsync(string requestId, JsonElement input, Action<object> emit)
    {
        if (input.ValueKind != JsonValueKind.Object) throw new AiHttpException(400, "Некорректный AI-запрос.");
        string Str(string k) => input.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        bool Flag(string k) => input.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.True;
        var provider = Str("provider"); var model = Str("model"); var operation = Str("operation"); var scope = Str("scope");
        var context = Str("contextText"); var title = Str("noteTitle"); var instruction = Str("instruction");
        var maxOut = AiLimits.OutputTokens(operation, context.Length);

        if (provider is not ("ollama" or "openrouter" or "compat") || string.IsNullOrWhiteSpace(model) || model.Length > 300
            || !AiPrompts.Operations.Contains(operation) || !AiPrompts.Scopes.Contains(scope)
            || (operation == "structure" && scope != "note")
            || (operation == "analyze" && scope is not ("note" or "linked"))
            || (scope == "linked" && operation is not ("analyze" or "summarize" or "custom"))
            || string.IsNullOrWhiteSpace(context) || context.Length > MaxChars || title.Length > 300
            || (operation == "custom" && (string.IsNullOrWhiteSpace(instruction) || instruction.Length > 1000)))
            throw new AiHttpException(400, "Проверьте задачу, область и текст запроса (до 24 000 символов)");

        var (system, user) = AiPrompts.Build(operation, context, instruction, Str("styleGuidance"));
        var compatLocal = provider == "compat" && (_compat?.Load()?.Local ?? false);
        var longWait = provider == "ollama" || compatLocal;
        var cts = new CancellationTokenSource(longWait ? LocalFirstTokenMs : RequestTimeoutMs);
        _active[requestId] = cts;
        var started = DateTime.UtcNow;
        HttpResponseMessage upstream;
        var localSlot = false;
        try
        {
            if (provider == "compat") upstream = await CompatRequestAsync(model, system, user, maxOut, AiLimits.Temperature(operation), Flag("remoteConsent"), cts.Token);
            else if (provider == "openrouter") upstream = await OpenRouterRequestAsync(model, system, user, maxOut, AiLimits.Temperature(operation), Flag("remoteConsent"), Flag("costConfirmed"), context + instruction, cts.Token);
            else
            {
                if (IsCloudModel(model)) throw new AiHttpException(400, "Облачные Ollama-модели запрещены; выберите локальную модель или OpenRouter.");
                if (Interlocked.CompareExchange(ref _localBusy, 1, 0) != 0) throw new AiHttpException(429, "Локальная модель ещё обрабатывает предыдущий запрос.");
                localSlot = true;
                upstream = await OllamaRequestAsync(model, system, user, maxOut, AiLimits.Temperature(operation), cts.Token);
            }
        }
        catch
        {
            if (localSlot) Interlocked.Exchange(ref _localBusy, 0);
            _active.TryRemove(requestId, out _); cts.Dispose();
            throw;
        }

        _ = Task.Run(async () =>
        {
            var status = "ok";
            try
            {
                Action? progress = longWait ? () => cts.CancelAfter((DateTime.UtcNow - started).TotalMilliseconds > LocalTotalMs - LocalStallMs ? Math.Max(1, (int)(LocalTotalMs - (DateTime.UtcNow - started).TotalMilliseconds)) : LocalStallMs) : null;
                await PumpAsync(upstream, provider != "ollama", model, emit, cts.Token, progress);
            }
            catch (Exception ex)
            {
                status = "error";
                emit(new { error = cts.IsCancellationRequested ? (ex is OperationCanceledException && !_active.ContainsKey(requestId) ? "AI-запрос отменён." : "Превышено время ожидания AI-модели (90 секунд).") : SafeMessage(ex) });
            }
            finally
            {
                var reqId = upstream.Headers.TryGetValues("x-request-id", out var rid) ? rid.First() : "-";
                if (localSlot) Interlocked.Exchange(ref _localBusy, 0);
                upstream.Dispose();
                _active.TryRemove(requestId, out _); cts.Dispose();
                _log($"ai provider={provider} model={model} op={operation} result={status} ms={(int)(DateTime.UtcNow - started).TotalMilliseconds} id={reqId}");
            }
        });
    }

    private static string SafeMessage(Exception ex) => ex is AiHttpException a ? a.Message : ex is JsonException or InvalidDataException ? ex.Message : "Ошибка AI-провайдера.";

    private async Task<HttpResponseMessage> OllamaRequestAsync(string model, string system, string user, int maxOut, double temperature, CancellationToken ct)
    {
        List<string> installed;
        try { installed = await LocalModelsAsync(ct, 4000); }
        catch { throw new AiHttpException(503, "Ollama не отвечает; проверьте, что локальный сервис запущен."); }
        if (!installed.Contains(model)) throw new AiHttpException(400, "Выбранная локальная модель не установлена.");
        var body = JsonSerializer.Serialize(new
        {
            model, stream = true, think = false,
            options = AiLimits.OllamaOptions(temperature, AiLimits.NumCtx(system.Length + user.Length, maxOut), maxOut),
            messages = new object[] { new { role = "system", content = system }, new { role = "user", content = user } },
        });
        return await SendWithRetryAsync(() => new HttpRequestMessage(HttpMethod.Post, new Uri(_ollama, "/api/chat")) { Content = new StringContent(body, Encoding.UTF8, "application/json") }, ct);
    }

    /// <summary>
    /// A chat request to the OpenAI-compatible service the owner configured. Same protection as the cloud path: consent, secret scan, rate limits,
    /// and the host's own confirmation (the price of such a service is not known, so it is asked about once per model).
    /// A server on this computer needs none of that.
    /// </summary>
    // ---------------------------------------------------------------- new pictures

    /// <summary>The address of a keyless public picture service (free, no account). Only the prompt leaves the computer.</summary>
    public static string PollinationsUrl(string prompt, int width, int height, int seed) =>
        $"https://image.pollinations.ai/prompt/{Uri.EscapeDataString(prompt)}?width={width}&height={height}&nologo=true&seed={seed}";

    /// <summary>Reads the picture from an images/generations answer: base64 inline or an address to download. Both null when the answer holds neither.</summary>
    public static (byte[]? Bytes, string? Url) ParseImageAnswer(string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("data", out var arr) || arr.ValueKind != JsonValueKind.Array || arr.GetArrayLength() == 0) return (null, null);
        var first = arr[0];
        if (first.TryGetProperty("b64_json", out var b) && b.ValueKind == JsonValueKind.String && b.GetString() is { Length: > 0 } b64) return (Convert.FromBase64String(b64), null);
        if (first.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String) return (null, u.GetString());
        return (null, null);
    }

    /// <summary>
    /// A new picture from a text request. "pollinations" is a free public service without a key, "service" is the OpenAI-compatible service
    /// the owner configured (it must offer /images/generations). The text is checked for secrets, the owner's consent is required,
    /// and the answer is stored like any picture: its real type is decided from its first bytes.
    /// </summary>
    public async Task<byte[]> GenerateImageAsync(string prompt, int width, int height, string via, string model, bool consent, ImageFetcher fetcher, CancellationToken ct)
    {
        prompt = (prompt ?? "").Trim();
        if (prompt.Length < 3 || prompt.Length > 600) throw new AiHttpException(400, "Опишите картинку словами: от 3 до 600 знаков.");
        if (!consent) throw new AiHttpException(403, "Перед отправкой описания во внешний сервис требуется подтверждение.");
        var secrets = SecretScanner.Find(prompt);
        if (secrets.Count > 0) throw new AiHttpException(400, "В описании найдены возможные секреты (" + string.Join(", ", secrets) + "). Уберите их.");
        width = Math.Clamp(width / 64 * 64, 256, 1280); height = Math.Clamp(height / 64 * 64, 256, 1280);
        CheckCloudRate();
        var counted = CommitCloudCall();
        try
        {
            if (via == "pollinations") return await fetcher.FetchAsync(PollinationsUrl(prompt, width, height, Random.Shared.Next(1, 1_000_000)), ct);
            if (via != "service") throw new AiHttpException(400, "Неизвестный источник картинок.");
            var cfg = _compat?.Load() ?? throw new AiHttpException(503, "Сервис не настроен: укажите адрес и ключ в настройках AI.");
            var key = _compat!.GetKey();
            if (!cfg.KeyOptional && string.IsNullOrWhiteSpace(key)) throw new AiHttpException(503, "Для сервиса не сохранён ключ.");
            if (string.IsNullOrWhiteSpace(model) || model.Length > 200) throw new AiHttpException(400, "Укажите модель для картинок (например, dall-e-3 или imagen-4.0-generate-001).");
            var body = JsonSerializer.Serialize(new { model, prompt, n = 1, size = $"{width}x{height}", response_format = "b64_json" });
            using var req = new HttpRequestMessage(HttpMethod.Post, cfg.BaseUrl.AbsoluteUri.TrimEnd('/') + "/images/generations") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            if (!string.IsNullOrWhiteSpace(key)) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            using var resp = await _http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode) throw new AiHttpException(502, $"Сервис не создал картинку (HTTP {(int)resp.StatusCode}). Проверьте, что у него есть создание изображений и название модели верное.");
            var (bytes, url) = ParseImageAnswer(await resp.Content.ReadAsStringAsync(ct));
            if (bytes is not null) return bytes;
            if (url is not null) return await fetcher.FetchAsync(url, ct);
            throw new AiHttpException(502, "Сервис вернул ответ без картинки.");
        }
        catch { RefundCloudCall(counted, 0); throw; }
    }

    private const int ReasoningHeadroom = 1536;
    private static readonly System.Text.RegularExpressions.Regex ReasoningModel = new(@"gpt-oss|deepseek|kimi|glm|qwen3|minimax|nemotron|(^|[-/:])(o1|o3|r1)($|[-/:])|thinking|reason", System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);

    private async Task<HttpResponseMessage> CompatRequestAsync(string model, string system, string user, int maxOut, double temperature, bool consent, CancellationToken ct)
    {
        var cfg = _compat?.Load() ?? throw new AiHttpException(503, "Сервис не настроен: укажите адрес и ключ в настройках AI.");
        var key = _compat!.GetKey();
        var endpoint = cfg.BaseUrl.AbsoluteUri.TrimEnd('/') + "/chat/completions";
        DateTime counted = default;
        // a server on this computer is local only for models that run on it: Ollama relays ":cloud" models to ollama.com, and that text does leave the computer
        var leavesComputer = !cfg.Local || IsCloudModel(model);
        if (leavesComputer)
        {
            if (!cfg.KeyOptional && string.IsNullOrWhiteSpace(key)) throw new AiHttpException(503, "Для сервиса не сохранён ключ.");
            if (!consent) throw new AiHttpException(403, "Перед отправкой текста во внешний сервис требуется подтверждение.");
            var secrets = SecretScanner.Find(system + "\n" + user);
            if (secrets.Count > 0) throw new AiHttpException(400, "В тексте найдены возможные секреты (" + string.Join(", ", secrets) + "). Уберите их или используйте локальную модель.");
            CheckCloudRate();
            var tag = "compat:" + cfg.BaseUrl.Host + ":" + model;
            if (_confirmCloud != null && !_approvedFree.Contains(tag))
            {
                var approved = await _confirmCloud(new CloudSendInfo(model, 0, system.Length + user.Length, false, cfg.Local ? cfg.Name + " → облако Ollama (ollama.com)" : cfg.Name, PriceUnknown: true));
                if (!approved) throw new AiHttpException(403, "Отправка во внешний сервис отменена: запрос не подтверждён.");
                lock (_rateLock) _approvedFree.Add(tag);
            }
            counted = CommitCloudCall();
        }
        // Reasoning models (gpt-oss, deepseek, kimi, glm...) spend part of max_tokens on thinking: with a tight limit the answer comes back empty.
        // They get headroom, and gpt-oss (which every common service accepts it for) is asked to think briefly.
        var reasoning = ReasoningModel.IsMatch(model);
        var payload = new Dictionary<string, object?>
        {
            ["model"] = model, ["stream"] = true, ["max_tokens"] = maxOut + (reasoning ? ReasoningHeadroom : 0), ["temperature"] = temperature,
            ["messages"] = new object[] { new { role = "system", content = system }, new { role = "user", content = user } },
        };
        if (model.Contains("gpt-oss", StringComparison.OrdinalIgnoreCase)) payload["reasoning_effort"] = "low";
        var body = JsonSerializer.Serialize(payload);
        try
        {
            return await SendWithRetryAsync(() =>
            {
                var req = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
                if (!string.IsNullOrWhiteSpace(key)) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
                return req;
            }, ct);
        }
        catch { if (leavesComputer) RefundCloudCall(counted, 0); throw; }
    }

    private async Task<HttpResponseMessage> OpenRouterRequestAsync(string model, string system, string user, int maxOut, double temperature, bool consent, bool costConfirmed, string sendable, CancellationToken ct)
    {
        var key = _secrets.GetOpenRouterKey();
        if (string.IsNullOrWhiteSpace(key)) throw new AiHttpException(503, "OpenRouter не настроен. Сохраните ключ в настройках AI или задайте переменную OPENROUTER_API_KEY.");
        if (!consent) throw new AiHttpException(403, "Перед отправкой текста во внешний сервис требуется подтверждение.");
        var secrets = SecretScanner.Find(system + "\n" + user);
        if (secrets.Count > 0) throw new AiHttpException(400, "В тексте найдены возможные секреты (" + string.Join(", ", secrets) + "). Уберите их или используйте локальную модель: во внешний сервис такой текст не отправляется.");
        CheckCloudRate();
        var models = await OpenRouterModelsAsync(ct);
        var selected = models.FirstOrDefault(m => m.Id == model) ?? throw new AiHttpException(400, "Модель не найдена в текущем каталоге OpenRouter. Обновите список моделей.");
        if (selected.PromptPrice is null || selected.CompletionPrice is null)
            throw new AiHttpException(400, "Для этой модели нет достоверных цен. Запуск заблокирован, чтобы не показывать ложную оценку.");
        if (selected.ContextLength is > 0 && AiLimits.Tokens(system.Length + user.Length) + maxOut > selected.ContextLength)
            throw new AiHttpException(400, $"Текст не помещается в окно модели ({selected.ContextLength} токенов). Сократите область запроса или выберите модель с большим окном.");
        var estimate = Math.Ceiling((system.Length + user.Length) / 2.0) * selected.PromptPrice.Value + maxOut * selected.CompletionPrice.Value;
        if (estimate > HardCostCeilingUsd) throw new AiHttpException(400, $"Оценка стоимости ${estimate.ToString("F4", CultureInfo.InvariantCulture)} выше предела ${HardCostCeilingUsd.ToString("F2", CultureInfo.InvariantCulture)} за один запрос. Выберите модель дешевле или сократите текст.");
        if (estimate > 0 && !costConfirmed) throw new AiHttpException(402, $"Платный запрос требует отдельного подтверждения. Максимальная оценка: ${estimate.ToString("F6", CultureInfo.InvariantCulture)}.");
        // the host asks the person itself: a page can fake its own consent and cost flags, it cannot answer this dialog
        if (_confirmCloud != null && (estimate > 0 || !_approvedFree.Contains(model)))
        {
            var approved = await _confirmCloud(new CloudSendInfo(model, estimate, system.Length + user.Length, estimate > 0));
            if (!approved) throw new AiHttpException(403, "Отправка в облако отменена: запрос не подтверждён.");
            if (estimate == 0) lock (_rateLock) _approvedFree.Add(model);
        }
        var counted = CommitCloudCall();
        ReserveSpend(estimate);
        var body = JsonSerializer.Serialize(new
        {
            model, stream = true, max_tokens = maxOut, temperature = temperature,
            messages = new object[] { new { role = "system", content = system }, new { role = "user", content = user } },
        });
        try
        {
        return await SendWithRetryAsync(() =>
        {
            var req = new HttpRequestMessage(HttpMethod.Post, OpenRouterChatUrl) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            req.Headers.TryAddWithoutValidation("X-Title", "Notepad Hub");
            return req;
        }, ct);
        }
        catch { RefundCloudCall(counted, estimate); throw; }
    }

    private AiUsageData Data()
    {
        _data ??= _usage.Load();
        var month = DateTime.UtcNow.ToString("yyyy-MM", CultureInfo.InvariantCulture);
        if (_data.Month != month) { _data.Month = month; _data.SpentUsd = 0; }
        return _data;
    }

    private void CheckCloudRate()
    {
        lock (_rateLock)
        {
            var now = DateTime.UtcNow;
            var data = Data();
            data.CloudCalls.RemoveAll(t => now - t > TimeSpan.FromDays(1));
            if (data.CloudCalls.Count >= CloudPerDay) throw new AiHttpException(429, "Достигнут суточный лимит облачных AI-запросов (100). Используйте локальную модель или повторите завтра.");
            if (data.CloudCalls.Count(t => now - t < TimeSpan.FromMinutes(1)) >= CloudPerMinute) throw new AiHttpException(429, "Слишком много облачных запросов за минуту. Подождите немного и повторите.");
        }
    }

    /// <summary>Counted only once every check has passed: a refused request (no price, not confirmed, too expensive) does not use up the daily quota.</summary>
    private DateTime CommitCloudCall()
    {
        lock (_rateLock)
        {
            var data = Data();
            var now = DateTime.UtcNow;
            // checked again here: many requests can pass the early check together, only this one is atomic with the count
            if (data.CloudCalls.Count >= CloudPerDay || data.CloudCalls.Count(t => now - t < TimeSpan.FromMinutes(1)) >= CloudPerMinute)
                throw new AiHttpException(429, "Слишком много облачных запросов. Подождите немного и повторите.");
            data.CloudCalls.Add(now);
            _usage.Save(data);
            return now;
        }
    }

    /// <summary>The request never reached the provider (network error, refusal, cancel): give the quota and the reserved money back.</summary>
    private void RefundCloudCall(DateTime stamp, double estimate)
    {
        lock (_rateLock)
        {
            var data = Data();
            data.CloudCalls.Remove(stamp);
            data.SpentUsd = Math.Max(0, data.SpentUsd - Math.Max(0, estimate));
            _usage.Save(data);
        }
    }

    /// <summary>Counts the worst-case price of a paid request against the monthly budget before it is sent.</summary>
    private void ReserveSpend(double estimate)
    {
        if (estimate <= 0) return;
        lock (_rateLock)
        {
            var data = Data();
            if (data.SpentUsd + estimate > _monthlyBudgetUsd)
                throw new AiHttpException(429, $"Месячный бюджет облачного AI исчерпан: израсходовано ≈${data.SpentUsd.ToString("F4", CultureInfo.InvariantCulture)} из ${_monthlyBudgetUsd.ToString("F2", CultureInfo.InvariantCulture)}. Используйте локальную модель или поднимите лимит (NOTEPADHUB_AI_MONTHLY_USD).");
            data.SpentUsd += estimate;
            _usage.Save(data);
        }
    }

    /// <summary>Cloud usage for the status line in the AI panel.</summary>
    public object Usage()
    {
        lock (_rateLock)
        {
            var data = Data();
            var now = DateTime.UtcNow;
            return new { callsToday = data.CloudCalls.Count(t => now - t <= TimeSpan.FromDays(1)), dailyLimit = CloudPerDay, spentMonthUsd = Math.Round(data.SpentUsd, 6), monthlyBudgetUsd = _monthlyBudgetUsd };
        }
    }

    /// <summary>One automatic retry, only for transient failures before the first byte. 4xx are never retried.</summary>
    private async Task<HttpResponseMessage> SendWithRetryAsync(Func<HttpRequestMessage> make, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            HttpResponseMessage? resp = null;
            try
            {
                resp = await _http.SendAsync(make(), HttpCompletionOption.ResponseHeadersRead, ct);
                if (resp.IsSuccessStatusCode) return resp;
                var status = (int)resp.StatusCode;
                var retryAfter = resp.Headers.RetryAfter?.Delta;
                var transient = status >= 500 || (status == 429 && retryAfter is { } d && d <= TimeSpan.FromSeconds(5));
                if (transient && attempt == 0)
                {
                    resp.Dispose();
                    await Task.Delay(retryAfter ?? TimeSpan.FromMilliseconds(600), ct);
                    continue;
                }
                resp.Dispose();
                throw new AiHttpException(status == 429 ? 429 : 502, status == 429
                    ? "Провайдер ограничил частоту запросов или лимит расходов. Подождите и повторите."
                    : $"AI-провайдер вернул HTTP {status}. Проверьте модель и настройки провайдера.");
            }
            catch (HttpRequestException) when (attempt == 0 && !ct.IsCancellationRequested)
            {
                resp?.Dispose();
                await Task.Delay(600, ct);
            }
            catch (HttpRequestException) { throw new AiHttpException(502, "Не удалось связаться с AI-провайдером."); }
        }
    }

    private static async Task PumpAsync(HttpResponseMessage upstream, bool openRouter, string model, Action<object> emit, CancellationToken ct, Action? progress = null)
    {
        await using var stream = await upstream.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var outputChars = 0;
        var truncated = false;
        void Forward(string? text)
        {
            if (string.IsNullOrEmpty(text)) return;
            outputChars += text.Length;
            if (outputChars > MaxChars) throw new InvalidDataException("AI вернул слишком большой ответ (лимит 24 000 символов).");
            emit(new { model, delta = text });
        }
        var sse = new StringBuilder();
        string? line;
        while ((line = await reader.ReadLineAsync(ct)) != null)
        {
            progress?.Invoke();
            if (!openRouter)
            {
                if (line.Length == 0) continue;
                using var doc = ParseOrThrow(line, "Ollama");
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Поток Ollama содержал некорректный объект.");
                if (root.TryGetProperty("error", out _)) throw new InvalidDataException("Локальная модель завершила запрос ошибкой.");
                if (root.TryGetProperty("message", out var msg) && msg.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String) Forward(c.GetString());
                if (root.TryGetProperty("done_reason", out var why) && why.ValueKind == JsonValueKind.String && why.GetString() == "length") truncated = true;
                continue;
            }
            if (line.Length > 0) { if (line.StartsWith("data:", StringComparison.Ordinal)) sse.Append(line.AsSpan(5).TrimStart()).Append('\n'); continue; }
            var data = sse.ToString().TrimEnd('\n'); sse.Clear();
            if (data.Length == 0 || data == "[DONE]") continue;
            using var d = ParseOrThrow(data, "OpenRouter");
            var r = d.RootElement;
            if (r.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Поток OpenRouter содержал некорректный объект.");
            if (r.TryGetProperty("error", out _)) throw new InvalidDataException("OpenRouter завершил запрос ошибкой модели.");
            if (r.TryGetProperty("choices", out var ch) && ch.ValueKind == JsonValueKind.Array && ch.GetArrayLength() > 0
                && ch[0].TryGetProperty("delta", out var delta) && delta.TryGetProperty("content", out var cc) && cc.ValueKind == JsonValueKind.String) Forward(cc.GetString());
            if (r.TryGetProperty("choices", out var ch2) && ch2.ValueKind == JsonValueKind.Array && ch2.GetArrayLength() > 0
                && ch2[0].TryGetProperty("finish_reason", out var fr) && fr.ValueKind == JsonValueKind.String && fr.GetString() == "length") truncated = true;
        }
        if (outputChars == 0) throw new InvalidDataException("AI-провайдер завершил поток без текста.");
        if (truncated) emit(new { model, truncated = true });   // the model hit its output limit: the answer ends in the middle
        emit(new { model, done = true });
    }

    private static JsonDocument ParseOrThrow(string json, string who)
    {
        try { return JsonDocument.Parse(json); }
        catch (JsonException) { throw new InvalidDataException($"Поток {who} содержал некорректный JSON."); }
    }
}




