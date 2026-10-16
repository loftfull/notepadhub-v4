using System.IO;
using System.ComponentModel;
using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using NotepadHub.Core;
using NotepadHub.Core.Ai;
using NotepadHub.Core.Bridge;

namespace NotepadHub.Host;

public partial class MainWindow : Window
{
    private const string VirtualHost = "app.notepadhub.local";
    private const string AssetHost = "assets.notepadhub.local";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly NoteStore _store;
    private readonly DataPaths _paths;
    private readonly BridgeDispatcher _bridge;
#if DEBUG
    // remote debugging + DevTools exist only in Debug builds (tests); a Release build never opens a debug port
    private readonly bool _debug = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("NOTEPADHUB_DEBUG_PORT"));
#else
    private readonly bool _debug = false;
#endif
    private TaskCompletionSource<(bool Ok, int Failed)>? _flushed;
    private bool _closeApproved;
    private bool _webReady;

    /// <summary>Native confirmation before text goes to a cloud model. The first free request per model and every paid request ask.</summary>
    private Task<bool> ConfirmCloudSend(CloudSendInfo info) => Dispatcher.InvokeAsync(() =>
        MessageBox.Show(this,
            (info.PriceUnknown
                ? $"Отправить текст во внешний сервис «{info.Service}»?\n\nМодель: {info.Model}\nЦена и условия тарифа неизвестны приложению: проверьте их на сайте сервиса. Бесплатные тарифы часто используют присланные тексты для обучения моделей.\n"
                : info.Paid
                    ? $"Отправить текст в облако ({info.Service}) и заплатить за запрос?\n\nМодель: {info.Model}\nМаксимальная стоимость: до ${info.EstimateUsd.ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture)}\n"
                    : $"Отправить текст в облако ({info.Service})?\n\nМодель: {info.Model} (бесплатная)\n")
            + $"Объём: около {info.Chars:N0} знаков.\n\nТекст покинет этот компьютер.",
            "Отправка в облако", MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No) == MessageBoxResult.Yes).Task;

    public MainWindow(NoteStore store, DataPaths paths)
    {
        InitializeComponent();
        _store = store; _paths = paths;
        AiService? ai = null;
        // two clients: a plain one for servers on this computer (Ollama, LM Studio), and a guarded one for the internet
        // (OpenRouter, a non-local OpenAI-compatible service): every connection is pinned to public addresses, no proxy, no cookies.
        // NOTEPADHUB_USE_PROXY=1 opts into the system proxy (corporate networks); the pinning is then off — see NetworkGuard.
        var useSystemProxy = NetworkGuard.SystemProxyRequested;
        try { ai = new AiService(new HttpClient { Timeout = Timeout.InfiniteTimeSpan }, new DpapiSecretStore(paths.Root), m => HostLog.Write(m), null, new FileAiUsageStore(paths.Root, m => HostLog.Write(m)), null, ConfirmCloudSend, new CompatServiceStore(paths.Root), NetworkGuard.CreatePublicOnlyHttpClient(Timeout.InfiniteTimeSpan, allowSystemProxy: useSystemProxy)); }
        catch (Exception ex)
        {
            HostLog.Write("ai: OLLAMA_HOST rejected (" + ex.Message + "); using the local default");
            try { ai = new AiService(new HttpClient { Timeout = Timeout.InfiniteTimeSpan }, new DpapiSecretStore(paths.Root), m => HostLog.Write(m), new Uri("http://127.0.0.1:11434"), new FileAiUsageStore(paths.Root, m => HostLog.Write(m)), null, ConfirmCloudSend, new CompatServiceStore(paths.Root), NetworkGuard.CreatePublicOnlyHttpClient(Timeout.InfiniteTimeSpan, allowSystemProxy: useSystemProxy)); } catch { }
        }
        _bridge = new BridgeDispatcher(store, new HostUi(this), App.Version, ai, Raise);
        RestoreGeometry();
        Loaded += async (_, _) => await InitWebAsync();
    }

    private void RestoreGeometry()
    {
        var s = _store.Settings;
        var area = SystemParameters.WorkArea;
        Width = Math.Min(Math.Max(s.WindowWidth, MinWidth), area.Width);
        Height = Math.Min(Math.Max(s.WindowHeight, MinHeight), area.Height);
        if (!double.IsNaN(s.WindowLeft) && !double.IsNaN(s.WindowTop) && s.WindowLeft > area.Left - Width + 80 && s.WindowLeft < area.Right - 80 && s.WindowTop >= area.Top && s.WindowTop < area.Bottom - 80)
        {
            WindowStartupLocation = WindowStartupLocation.Manual; Left = s.WindowLeft; Top = s.WindowTop;
        }
        if (s.WindowMaximized) WindowState = WindowState.Maximized;
    }

    private void SaveGeometry()
    {
        try
        {
            var s = _store.Settings;
            s.WindowMaximized = WindowState == WindowState.Maximized;
            var b = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
            s.WindowWidth = b.Width; s.WindowHeight = b.Height; s.WindowLeft = b.Left; s.WindowTop = b.Top;
            _store.SaveSettings(s);
        }
        catch (Exception ex) { HostLog.Write("geometry: " + ex.Message); }
    }

    private async Task InitWebAsync()
    {
        try
        {
            var uiDir = Path.Combine(AppContext.BaseDirectory, "ui");
            if (!File.Exists(Path.Combine(uiDir, "index.html"))) throw new FileNotFoundException("Не найден интерфейс приложения (папка ui).");

            var options = new CoreWebView2EnvironmentOptions();
#if DEBUG
            var port = Environment.GetEnvironmentVariable("NOTEPADHUB_DEBUG_PORT");
            if (!string.IsNullOrWhiteSpace(port) && int.TryParse(port, out var p) && p is > 1024 and < 65536)
                options.AdditionalBrowserArguments = $"--remote-debugging-port={p}";
#endif
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_paths.Root, "webview2"), options);
            await Web_EnsureAsync(env);

            var core = Web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = _debug;
            core.Settings.AreBrowserAcceleratorKeysEnabled = _debug;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.SetVirtualHostNameToFolderMapping(VirtualHost, uiDir, CoreWebView2HostResourceAccessKind.Deny);
            Directory.CreateDirectory(_paths.NotesAssets);
            core.SetVirtualHostNameToFolderMapping(AssetHost, _paths.NotesAssets, CoreWebView2HostResourceAccessKind.DenyCors);   // pictures of the notes: the page may show them (img), not read them with fetch

            core.NavigationStarting += (_, e) =>
            {
                if (!IsOwnUri(e.Uri)) { e.Cancel = true; OpenExternal(e.Uri); }
            };
            core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.WebMessageReceived += OnWebMessage;
            core.ProcessFailed += (_, e) => HostLog.Write("webview process failed: " + e.ProcessFailedKind);

            _webReady = true;
            core.Navigate($"https://{VirtualHost}/index.html");
        }
        catch (Exception ex)
        {
            HostLog.Write("web init: " + ex);
            MessageBox.Show("Не удалось запустить встроенный браузер (WebView2).\n\n" + ex.Message, "Notepad Hub 4", MessageBoxButton.OK, MessageBoxImage.Error);
            _closeApproved = true; Close();
        }
    }

    private Task Web_EnsureAsync(CoreWebView2Environment env) => Web.EnsureCoreWebView2Async(env);

    private static bool IsOwnUri(string uri) => Uri.TryCreate(uri, UriKind.Absolute, out var u) && u.Scheme == "https" && string.Equals(u.Host, VirtualHost, StringComparison.OrdinalIgnoreCase);

    private static void OpenExternal(string uri)
    {
        // only plain web links leave the app; file:, javascript:, data: and everything else is dropped
        if (Uri.TryCreate(uri, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp))
        {
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch (Exception ex) { HostLog.Write("open external: " + ex.Message); }
        }
    }

    // ---------------------------------------------------------------- bridge

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!IsOwnUri(e.Source)) return;                       // ignore anything not from our own page
        int id; string type; JsonElement payload = default;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("id", out var idEl) || !root.TryGetProperty("type", out var typeEl)) return;
            id = idEl.GetInt32(); type = typeEl.GetString() ?? "";
            if (root.TryGetProperty("payload", out var pl)) payload = pl.Clone();
        }
        catch { return; }

        if (type == "flushAck")
        {
            var ok = !(payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("ok", out var okEl) && okEl.ValueKind == JsonValueKind.False);
            var failed = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("failed", out var fEl) && fEl.TryGetInt32(out var fv) ? fv : 0;
            _flushed?.TrySetResult((ok, failed));
            Reply(id, true, new { });
            return;
        }

        try
        {
            var result = await _bridge.HandleAsync(type, payload);
            Reply(id, true, result);
        }
        catch (Exception ex)
        {
            var (code, message, status) = Describe(ex);
            if (code == "internal") HostLog.Write($"bridge {type}: {ex}");
            Reply(id, false, null, code, message, status);
        }
    }

    private static (string code, string message, int? status) Describe(Exception ex) => ex switch
    {
        AiHttpException a => ("http", a.Message, a.Status),
        BridgeException b => (b.Code, b.Message, null),
        KeyNotFoundException or ArgumentException or InvalidOperationException or InvalidDataException => ("rejected", ex.Message, null),
        FileNotFoundException => ("rejected", "Файл не найден.", null),
        _ => ("internal", "Внутренняя ошибка. Данные не изменены; подробности записаны в журнал.", null),
    };

    private void Reply(int id, bool ok, object? result, string? code = null, string? message = null, int? status = null)
    {
        var json = ok
            ? JsonSerializer.Serialize(new { id, ok = true, result }, Json)
            : JsonSerializer.Serialize(new { id, ok = false, error = new { code, message, status } }, Json);
        Dispatcher.InvokeAsync(() => { if (_webReady) Web.CoreWebView2.PostWebMessageAsJson(json); });
    }

    private void Raise(string name, object payload)
    {
        var json = JsonSerializer.Serialize(new { @event = name, payload }, Json);
        Dispatcher.InvokeAsync(() => { if (_webReady) Web.CoreWebView2.PostWebMessageAsJson(json); });
    }

    // ---------------------------------------------------------------- activation from another process

    public void ActivateAndOpen(IReadOnlyList<string> files)
    {
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        if (files.Count == 0) return;
        string? last = null;
        foreach (var f in files.Where(File.Exists))
        {
            try { last = _store.OpenInPlace(f, _store.Settings.ActiveProjectId).Id; }
            catch (Exception ex) { HostLog.Write("activate open: " + ex.Message); }
        }
        if (last != null) Raise("libraryChanged", new { select = last });
    }

    // ---------------------------------------------------------------- closing: ask the page to save first

    protected override async void OnClosing(CancelEventArgs e)
    {
        if (_closeApproved || !_webReady) { SaveGeometry(); base.OnClosing(e); return; }
        e.Cancel = true;
        if (_flushed != null) return;                           // already closing
        _flushed = new TaskCompletionSource<(bool Ok, int Failed)>(TaskCreationOptions.RunContinuationsAsynchronously);
        Raise("flush", new { });
        var done = await Task.WhenAny(_flushed.Task, Task.Delay(8000));
        var result = done == _flushed.Task ? _flushed.Task.Result : (Ok: false, Failed: -1);
        if (!result.Ok)
        {
            HostLog.Write("close: final save not confirmed (failed=" + result.Failed + ")");
            var text = result.Failed > 0
                ? $"Не удалось сохранить заметок: {result.Failed}. Если закрыть окно сейчас, их последние правки будут потеряны.\n\nЗакрыть всё равно?"
                : "Интерфейс не подтвердил последнее сохранение. Если закрыть окно сейчас, последние правки могут быть потеряны.\n\nЗакрыть всё равно?";
            if (MessageBox.Show(this, text, "Notepad Hub 4", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No) != MessageBoxResult.Yes)
            {
                _flushed = null;                                // stay open; the user can fix the problem and close again
                return;
            }
        }
        _closeApproved = true;
        Close();
    }
}



