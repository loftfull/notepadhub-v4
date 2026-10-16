using System.Net;
using System.Text;
using System.Text.Json;
using NotepadHub.Core.Ai;

namespace NotepadHub.Core.Tests;

/// <summary>
/// The internet-facing AI client is pinned to public addresses (NetworkGuard), and AiService routes calls:
/// servers on this computer keep the plain client, everything that leaves the computer goes through the guarded one.
/// </summary>
public class NetworkGuardTests
{
    private sealed class FakeHandler : HttpMessageHandler
    {
        public Func<HttpRequestMessage, HttpResponseMessage> Respond { get; set; } = _ => new HttpResponseMessage(HttpStatusCode.NotFound);
        public List<string> Calls { get; } = new();
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls.Add(request.Method + " " + request.RequestUri);
            return Task.FromResult(Respond(request));
        }
    }

    private sealed class MemSecrets : IAiSecretStore
    {
        public string? Key { get; set; } = "sk-or-v1-test-key-0000000000000000";
        public string? GetOpenRouterKey() => Key;
        public void SetOpenRouterKey(string key) => Key = key;
        public void ClearOpenRouterKey() => Key = null;
    }

    private const string Sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Готово\"}}]}\n\ndata: [DONE]\n\n";
    private static HttpResponseMessage Sse200() => new(HttpStatusCode.OK) { Content = new StringContent(Sse, Encoding.UTF8, "text/event-stream") };
    private static HttpResponseMessage Json200(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static async Task<List<string>> Collect(AiService svc, string id, object body)
    {
        var events = new List<string>();
        var done = new TaskCompletionSource();
        await svc.StartStreamAsync(id, JsonSerializer.SerializeToElement(body), e =>
        {
            var el = JsonSerializer.SerializeToElement(e);
            events.Add(el.ToString());
            if (el.TryGetProperty("done", out _) || el.TryGetProperty("error", out _)) done.TrySetResult();
        });
        await Task.WhenAny(done.Task, Task.Delay(5000));
        return events;
    }

    private static object Body(string provider, string model, bool consent = false) =>
        new { provider, model, operation = "proofread", scope = "paragraph", contextText = "текст", noteTitle = "t", remoteConsent = consent, costConfirmed = true };

    private static string TempStore(out string dir)
    {
        dir = Path.Combine(Path.GetTempPath(), "nh4-guard-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        return dir;
    }

    [Fact]
    public async Task The_internet_client_refuses_names_that_resolve_to_this_computer()
    {
        using var http = NetworkGuard.CreatePublicOnlyHttpClient(TimeSpan.FromSeconds(10));
        // "localhost" resolves through the hosts file (no external DNS needed): the guard must refuse before any connection
        await Assert.ThrowsAnyAsync<Exception>(() => http.GetAsync("http://localhost:9/status", CancellationToken.None));
    }

    [Fact]
    public async Task A_non_local_service_is_called_through_the_guarded_client_only()
    {
        TempStore(out var dir);
        try
        {
            var store = new CompatServiceStore(dir);
            // a keyless public host (KeylessHosts): the routing is the same for any non-local address, but no DPAPI is
            // needed to save a key, so the test also runs on the Linux CI job of the core suite
            store.Save("https://text.pollinations.ai/openai", "Тест", null);
            var local = new FakeHandler();
            var remote = new FakeHandler { Respond = _ => Sse200() };
            var svc = new AiService(new HttpClient(local), new MemSecrets(), null, new Uri("http://127.0.0.1:11434"), null, null, null, store, new HttpClient(remote));
            var events = await Collect(svc, "g1", Body("compat", "m", consent: true));
            Assert.Contains(events, e => e.Contains("\"done\""));
            Assert.Contains(remote.Calls, c => c.Contains("text.pollinations.ai/openai/chat/completions"));
            Assert.Empty(local.Calls);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public async Task A_non_local_model_list_also_goes_through_the_guarded_client()
    {
        TempStore(out var dir);
        try
        {
            var store = new CompatServiceStore(dir);
            store.Save("https://api.example.test/v1", "Тест", null);   // no key: the list request must still be routed to the guarded client
            var local = new FakeHandler();
            var remote = new FakeHandler { Respond = _ => Json200("{\"data\":[{\"id\":\"gpt-oss-120b\"}]}") };
            var svc = new AiService(new HttpClient(local), new MemSecrets(), null, new Uri("http://127.0.0.1:11434"), null, null, null, store, new HttpClient(remote));
            var models = JsonSerializer.Serialize(await svc.ModelsAsync("compat", CancellationToken.None));
            Assert.Contains("gpt-oss-120b", models);
            Assert.Contains(remote.Calls, c => c.Contains("api.example.test/v1/models"));
            Assert.Empty(local.Calls);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public async Task A_server_on_this_computer_keeps_using_the_plain_client()
    {
        TempStore(out var dir);
        try
        {
            var store = new CompatServiceStore(dir);
            store.Save("http://127.0.0.1:1234/v1", "Локальный", null);
            var local = new FakeHandler { Respond = _ => Sse200() };
            var remote = new FakeHandler();
            var svc = new AiService(new HttpClient(local), new MemSecrets(), null, new Uri("http://127.0.0.1:11434"), null, null, null, store, new HttpClient(remote));
            var events = await Collect(svc, "g2", Body("compat", "local-model"));
            Assert.Contains(events, e => e.Contains("\"done\""));
            Assert.Contains(local.Calls, c => c.Contains("127.0.0.1:1234/v1/chat/completions"));
            Assert.Empty(remote.Calls);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public async Task OpenRouter_models_and_chat_go_through_the_guarded_client()
    {
        const string catalog = "{\"data\":[{\"id\":\"free/model\",\"name\":\"Free\",\"context_length\":8000,\"architecture\":{\"input_modalities\":[\"text\"],\"output_modalities\":[\"text\"]},\"pricing\":{\"prompt\":\"0\",\"completion\":\"0\"}}]}";
        var local = new FakeHandler();
        var remote = new FakeHandler { Respond = r => r.RequestUri!.AbsolutePath.EndsWith("/models") ? Json200(catalog) : Sse200() };
        var svc = new AiService(new HttpClient(local), new MemSecrets(), null, new Uri("http://127.0.0.1:11434"), null, null, null, null, new HttpClient(remote));
        var events = await Collect(svc, "g3", Body("openrouter", "free/model", consent: true));
        Assert.Contains(events, e => e.Contains("\"done\""));
        Assert.Contains(remote.Calls, c => c.Contains("openrouter.ai/api/v1/models"));
        Assert.Contains(remote.Calls, c => c.Contains("openrouter.ai/api/v1/chat/completions"));
        Assert.Empty(local.Calls);
    }
}
