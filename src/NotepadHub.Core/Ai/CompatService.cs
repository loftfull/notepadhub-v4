using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace NotepadHub.Core.Ai;

/// <summary>
/// One OpenAI-compatible service the owner chose (Groq, Google AI Studio, Mistral, NVIDIA NIM, a server on this computer such as LM Studio or vLLM, ...):
/// its address and name in a small file, its key in a Windows DPAPI-protected file (this user, this PC). The key never goes to the page.
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class CompatServiceStore
{
    public sealed record Config(Uri BaseUrl, string Name)
    {
        /// <summary>A server on this computer: nothing leaves it, so no consent, key or confirmation is needed.</summary>
        public bool Local => BaseUrl.IsLoopback;

        /// <summary>Public services that work without an account: the text still leaves the computer (consent and confirmation stay), but no key is needed.</summary>
        public bool KeyOptional => Local || KeylessHosts.Contains(BaseUrl.Host);

        /// <summary>True when the owner has not chosen anything and the free default is in use.</summary>
        public bool Builtin { get; init; }
    }

    private static readonly HashSet<string> KeylessHosts = new(StringComparer.OrdinalIgnoreCase) { "text.pollinations.ai" };

    /// <summary>The default: a free fast public model without an account (Pollinations, GPT-OSS 20B), used until the owner picks another service.</summary>
    public static Config DefaultService { get; } = new(new Uri("https://text.pollinations.ai/openai"), "Pollinations (бесплатно)") { Builtin = true };

    private readonly string _config;
    private readonly string _key;

    public CompatServiceStore(string dataRoot)
    {
        _config = Path.Combine(dataRoot, "ai-compat.json");
        _key = Path.Combine(dataRoot, "ai-compat.key.dpapi");
    }

    /// <summary>Only https addresses of the public internet and http/https on this computer. No credentials in the address, no query.</summary>
    public static Uri Validate(string url)
    {
        if (!Uri.TryCreate((url ?? "").Trim().TrimEnd('/'), UriKind.Absolute, out var uri)) throw new ArgumentException("Адрес сервиса выглядит некорректно.");
        if (!string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)) throw new ArgumentException("Адрес не должен содержать логин, параметры или якорь.");
        var local = uri.IsLoopback;
        if (uri.Scheme != Uri.UriSchemeHttps && !(local && uri.Scheme == Uri.UriSchemeHttp)) throw new ArgumentException("Нужен адрес https:// (http:// разрешён только для сервера на этом компьютере).");
        if (!local && System.Net.IPAddress.TryParse(uri.Host.Trim('[', ']'), out var ip) && !ImageFetcher.IsPublic(ip)) throw new ArgumentException("Адреса внутренней сети не поддерживаются: укажите публичный сервис или сервер на этом компьютере.");
        return uri;
    }

    public Config? Load()
    {
        try
        {
            if (!File.Exists(_config)) return DefaultService;
            using var doc = JsonDocument.Parse(File.ReadAllText(_config, Encoding.UTF8));
            var url = doc.RootElement.GetProperty("baseUrl").GetString() ?? "";
            var name = doc.RootElement.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
            return new Config(Validate(url), string.IsNullOrWhiteSpace(name) ? Validate(url).Host : name.Trim()[..Math.Min(40, name.Trim().Length)]);
        }
        catch { return DefaultService; }
    }

    public void Save(string baseUrl, string name, string? key)
    {
        var uri = Validate(baseUrl);
        if (key is { Length: > 0 } && (key.Trim().Length < 8 || key.Trim().Length > 400 || key.Trim().Any(char.IsWhiteSpace))) throw new ArgumentException("Ключ выглядит некорректно.");
        name = (name ?? "").Trim();
        if (name.Length > 40) name = name[..40];
        Directory.CreateDirectory(Path.GetDirectoryName(_config)!);
        File.WriteAllText(_config, JsonSerializer.Serialize(new { baseUrl = uri.AbsoluteUri.TrimEnd('/'), name }), new UTF8Encoding(false));
        if (key is { Length: > 0 })
        {
            key = key.Trim();
            if (key.Length < 8 || key.Length > 400 || key.Any(char.IsWhiteSpace)) throw new ArgumentException("Ключ выглядит некорректно.");
            File.WriteAllBytes(_key, ProtectedData.Protect(Encoding.UTF8.GetBytes(key), Encoding.UTF8.GetBytes("NotepadHub.Compat"), DataProtectionScope.CurrentUser));
        }
    }

    public string? GetKey()
    {
        try
        {
            if (!File.Exists(_key)) return null;
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(_key), Encoding.UTF8.GetBytes("NotepadHub.Compat"), DataProtectionScope.CurrentUser));
        }
        catch { return null; }
    }

    public bool HasKey => GetKey() is { Length: > 0 };

    public void Clear()
    {
        try { if (File.Exists(_config)) File.Delete(_config); } catch { /* best effort */ }
        try { if (File.Exists(_key)) File.Delete(_key); } catch { /* best effort */ }
    }

    private static readonly System.Text.RegularExpressions.Regex NotChat = new(@"embed|whisper|tts|speech|transcri|moderation|guard|rerank|dall-?e|image|imagen|vision-preview|audio|realtime|bge-|clip", System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>Model ids from a /models answer ({"data":[{"id":..}]} or {"models":[..]}); models that are not for chat are dropped.</summary>
    public static List<string> ParseModelIds(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var list = new List<string>();
        foreach (var key in new[] { "data", "models" })
        {
            if (!doc.RootElement.TryGetProperty(key, out var arr) || arr.ValueKind != JsonValueKind.Array) continue;
            foreach (var item in arr.EnumerateArray())
            {
                var id = item.ValueKind == JsonValueKind.String ? item.GetString()
                    : item.TryGetProperty("id", out var i) && i.ValueKind == JsonValueKind.String ? i.GetString()
                    : item.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
                if (string.IsNullOrWhiteSpace(id)) continue;
                id = id.StartsWith("models/", StringComparison.Ordinal) ? id[7..] : id;   // Google lists "models/gemini-..."
                if (id.Length <= 200 && !NotChat.IsMatch(id)) list.Add(id);
            }
        }
        return list.Distinct().OrderBy(x => x, StringComparer.OrdinalIgnoreCase).Take(300).ToList();
    }
}
