using NotepadHub.Core.Ai;
using Xunit;

namespace NotepadHub.Core.Tests;

public class ModelCatalogTests
{
    // the real list of the owner's machine (2026-10-15): two local chat models, code and base models, an embedding model and six cloud aliases
    private const string Machine = """
    {"models":[
      {"name":"qwen2.5-coder:3b","size":1929912432,"details":{"family":"qwen2","parameter_size":"3.1B"}},
      {"name":"qwen3.5:4b","size":3400000000,"details":{"family":"qwen35","parameter_size":"4.2B"}},
      {"name":"t4-fast-cloud:latest","size":0,"details":{"family":"","parameter_size":""}},
      {"name":"t3-vision:latest","size":0,"details":{"family":"","parameter_size":""}},
      {"name":"t2-code:latest","size":0,"details":{"family":"","parameter_size":""}},
      {"name":"t1-architect:latest","size":0,"details":{"family":"","parameter_size":""}},
      {"name":"t6-local-code:latest","size":1929912432,"details":{"family":"qwen2","parameter_size":"3.1B"}},
      {"name":"t7-autocomplete:latest","size":986000000,"details":{"family":"qwen2","parameter_size":"1.5B"}},
      {"name":"t6-local-plan:latest","size":1900000000,"details":{"family":"qwen35","parameter_size":"1.9B"}},
      {"name":"t7-embed:latest","size":274000000,"details":{"family":"nomic-bert","parameter_size":"137M"}},
      {"name":"gpt-oss:120b-cloud","size":0,"details":{"family":"gptoss","parameter_size":"117B"}},
      {"name":"qwen3.5:2b-q4_K_M","size":1900000000,"details":{"family":"qwen35","parameter_size":"1.9B"}},
      {"name":"qwen2.5-coder:1.5b-base","size":986000000,"details":{"family":"qwen2","parameter_size":"1.5B"}},
      {"name":"nomic-embed-text:latest","size":274000000,"details":{"family":"nomic-bert","parameter_size":"137M"}}
    ]}
    """;

    [Fact]
    public void OnTheOwnersMachineOnlyTheModernGeneralModelRemains()
    {
        var (usable, hidden) = LocalModelCatalog.Classify(LocalModelCatalog.Parse(Machine));
        Assert.Equal(new[] { "qwen3.5:4b" }, usable.Select(m => m.Name).ToArray());
        Assert.Equal(13, hidden.Count);
    }

    [Fact]
    public void CloudAliasesWithoutLocalWeightsAreNeverUsable()
    {
        var (usable, hidden) = LocalModelCatalog.Classify(LocalModelCatalog.Parse(Machine));
        foreach (var alias in new[] { "t1-architect:latest", "t2-code:latest", "t3-vision:latest", "t4-fast-cloud:latest", "gpt-oss:120b-cloud" })
        {
            Assert.DoesNotContain(usable, m => m.Name == alias);
            Assert.Contains(hidden, h => h.Name == alias && h.Reason.StartsWith("облачная"));
        }
    }

    [Fact]
    public void BestModernModelIsTheDefaultAndOldOnesStayOnlyWhenAlone()
    {
        var both = new[]
        {
            new InstalledModel("qwen2.5:7b", 4_000_000_000, "qwen2", 7.6),
            new InstalledModel("qwen3.5:4b", 3_400_000_000, "qwen35", 4.2),
        };
        Assert.Equal(new[] { "qwen3.5:4b" }, LocalModelCatalog.Classify(both).Usable.Select(m => m.Name).ToArray());
        var alone = LocalModelCatalog.Classify(new[] { both[0] }).Usable;
        Assert.Single(alone);
    }

    [Fact]
    public void SmallModelIsKeptWhenItIsTheOnlyChoice()
    {
        var (usable, _) = LocalModelCatalog.Classify(new[] { new InstalledModel("qwen3.5:2b", 1_900_000_000, "qwen35", 1.9) });
        Assert.Single(usable);
    }

    [Fact]
    public void CodeModelsAreALastResortAndEmbeddingsNever()
    {
        var onlyCode = LocalModelCatalog.Classify(new[]
        {
            new InstalledModel("qwen2.5-coder:3b", 1_900_000_000, "qwen2", 3.1),
            new InstalledModel("nomic-embed-text:latest", 274_000_000, "nomic-bert", 0.137),
        });
        Assert.Equal(new[] { "qwen2.5-coder:3b" }, onlyCode.Usable.Select(m => m.Name).ToArray());
        Assert.Contains(onlyCode.Hidden, h => h.Name == "nomic-embed-text:latest");
    }

    [Fact]
    public void SamplingIsNeutralSoModelfilePenaltiesCannotDistortAnEdit()
    {
        var o = AiLimits.OllamaOptions(0.0, 4096, 400);
        Assert.Equal(0.0, (double)o["presence_penalty"]);
        Assert.Equal(1.0, (double)o["repeat_penalty"]);
        Assert.Equal(4096, (int)o["num_ctx"]);
    }
}

public class ImageFetcherTests
{
    [Theory]
    [InlineData("127.0.0.1", false)]
    [InlineData("10.1.2.3", false)]
    [InlineData("172.16.0.5", false)]
    [InlineData("172.32.0.5", true)]
    [InlineData("192.168.1.1", false)]
    [InlineData("169.254.169.254", false)]
    [InlineData("100.64.0.1", false)]
    [InlineData("0.0.0.0", false)]
    [InlineData("224.0.0.1", false)]
    [InlineData("::1", false)]
    [InlineData("fe80::1", false)]
    [InlineData("fd00::1", false)]
    [InlineData("::ffff:127.0.0.1", false)]
    [InlineData("198.18.0.1", false)]
    [InlineData("192.0.2.5", false)]
    [InlineData("203.0.113.9", false)]
    [InlineData("64:ff9b::7f00:1", false)]
    [InlineData("64:ff9b::5db8:d822", true)]
    [InlineData("2002:7f00:1::1", false)]
    [InlineData("::127.0.0.1", false)]
    [InlineData("93.184.216.34", true)]
    [InlineData("2606:2800:220:1:248:1893:25c8:1946", true)]
    public void OnlyPublicAddressesAreAllowed(string address, bool expected) =>
        Assert.Equal(expected, NotepadHub.Core.ImageFetcher.IsPublic(System.Net.IPAddress.Parse(address)));

    [Theory]
    [InlineData("https://example.com/a.png", true)]
    [InlineData("http://example.com/a.png", true)]
    [InlineData("file:///C:/secret.png", false)]
    [InlineData("ftp://example.com/a.png", false)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("data:image/png;base64,AAAA", false)]
    [InlineData("https://user:pass@example.com/a.png", false)]
    [InlineData("not a url", false)]
    public void OnlyPlainWebAddressesAreAllowed(string url, bool expected) =>
        Assert.Equal(expected, NotepadHub.Core.ImageFetcher.IsAllowedUrl(url, out _));

    [Fact]
    public async Task LoopbackIsRefusedEvenWhenTheNameIsLocalhost()
    {
        using var fetcher = new NotepadHub.Core.ImageFetcher();
        await Assert.ThrowsAnyAsync<Exception>(() => fetcher.FetchAsync("http://localhost:1/x.png", CancellationToken.None));
        await Assert.ThrowsAnyAsync<Exception>(() => fetcher.FetchAsync("http://127.0.0.1:1/x.png", CancellationToken.None));
    }
}

public class PromptTargetTests
{
    private static readonly string Words100 = string.Join(' ', Enumerable.Range(1, 100).Select(i => "слово" + i));

    [Fact]
    public void ShortenAndExpandNameTheTargetSizeSoSmallModelsDoNotEchoTheText()
    {
        var shorten = NotepadHub.Core.Ai.AiPrompts.Build("shorten", Words100, null, null).System;
        Assert.Contains("около 100 слов", shorten);
        Assert.Contains("45–60", shorten);
        var expand = NotepadHub.Core.Ai.AiPrompts.Build("expand", Words100, null, null).System;
        Assert.Contains("140–200", expand);
    }

    [Fact]
    public void ContinueAsksForTheOriginalPlusNewSentences() =>
        Assert.Contains("Верни исходный текст полностью", NotepadHub.Core.Ai.AiPrompts.Build("continue", Words100, null, null).System);

    [Fact]
    public void BlockLabelsAreNotCountedAsWords() =>
        Assert.Equal(3, NotepadHub.Core.Ai.AiPrompts.WordCount("[B1] раз два\n\n[B2] три"));

    [Fact]
    public void ShortTextsKeepTheGenericInstruction() =>
        Assert.DoesNotContain("вдвое", NotepadHub.Core.Ai.AiPrompts.Build("shorten", "коротко", null, null).System);
}

public class CompatServiceTests
{
    [Theory]
    [InlineData("https://api.groq.com/openai/v1", true)]
    [InlineData("https://generativelanguage.googleapis.com/v1beta/openai/", true)]
    [InlineData("http://127.0.0.1:1234/v1", true)]
    [InlineData("http://localhost:11434/v1", true)]
    [InlineData("http://api.example.com/v1", false)]
    [InlineData("https://user:pw@api.example.com/v1", false)]
    [InlineData("https://api.example.com/v1?key=1", false)]
    [InlineData("https://192.168.1.5/v1", false)]
    [InlineData("https://10.0.0.2/v1", false)]
    [InlineData("ftp://x/v1", false)]
    [InlineData("not a url", false)]
    public void OnlyHttpsPublicOrLoopbackServicesAreAccepted(string url, bool ok)
    {
        if (ok) NotepadHub.Core.Ai.CompatServiceStore.Validate(url);
        else Assert.Throws<ArgumentException>(() => NotepadHub.Core.Ai.CompatServiceStore.Validate(url));
    }

    [Fact]
    public void ModelListsAreReadInTheCommonShapesAndNonChatModelsAreDropped()
    {
        var openAi = """{"data":[{"id":"gpt-oss-120b"},{"id":"whisper-large-v3"},{"id":"llama-guard-4"},{"id":"qwen3-32b"}]}""";
        Assert.Equal(new[] { "gpt-oss-120b", "qwen3-32b" }, NotepadHub.Core.Ai.CompatServiceStore.ParseModelIds(openAi));
        var google = """{"data":[{"id":"models/gemini-2.5-flash"},{"id":"models/text-embedding-004"}]}""";
        Assert.Equal(new[] { "gemini-2.5-flash" }, NotepadHub.Core.Ai.CompatServiceStore.ParseModelIds(google));
    }

    [Fact]
    public void SettingsAndKeySurviveARestartAndClearRemovesBoth()
    {
        var dir = Path.Combine(Path.GetTempPath(), "nh4-compat-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        try
        {
            var store = new NotepadHub.Core.Ai.CompatServiceStore(dir);
            Assert.True(store.Load()!.Builtin);   // nothing chosen yet: the free default
            Assert.True(store.Load()!.KeyOptional);
            store.Save("https://api.groq.com/openai/v1/", "Groq", "gsk_1234567890abcdef");
            var again = new NotepadHub.Core.Ai.CompatServiceStore(dir);
            Assert.Equal("Groq", again.Load()!.Name);
            Assert.Equal("https://api.groq.com/openai/v1", again.Load()!.BaseUrl.AbsoluteUri.TrimEnd('/'));
            Assert.Equal("gsk_1234567890abcdef", again.GetKey());
            Assert.False(File.ReadAllText(Path.Combine(dir, "ai-compat.key.dpapi"), System.Text.Encoding.Latin1).Contains("gsk_"));
            Assert.False(again.Load()!.KeyOptional);   // a service with a key needs the key
            again.Clear();
            Assert.True(again.Load()!.Builtin);        // clearing returns to the free default
            Assert.Null(again.GetKey());
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void ABadKeyIsRefusedBeforeAnythingIsWritten()
    {
        var dir = Path.Combine(Path.GetTempPath(), "nh4-compat-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        try
        {
            var store = new NotepadHub.Core.Ai.CompatServiceStore(dir);
            Assert.Throws<ArgumentException>(() => store.Save("https://api.groq.com/openai/v1", "Groq", "short"));
        }
        finally { Directory.Delete(dir, true); }
    }
}

public class ImageGenerationTests
{
    [Fact]
    public void ThePublicServiceAddressCarriesOnlyTheEncodedPromptAndSize()
    {
        var url = NotepadHub.Core.Ai.AiService.PollinationsUrl("кот на диване & ?", 768, 512, 7);
        Assert.StartsWith("https://image.pollinations.ai/prompt/", url);
        Assert.DoesNotContain(" ", url);
        Assert.Contains("width=768&height=512", url);
        Assert.True(NotepadHub.Core.ImageFetcher.IsAllowedUrl(url, out _));
    }

    [Fact]
    public void AnImagesAnswerIsReadAsInlineBytesOrAnAddress()
    {
        var inline = NotepadHub.Core.Ai.AiService.ParseImageAnswer("{\"data\":[{\"b64_json\":\"" + Convert.ToBase64String(new byte[] { 1, 2, 3 }) + "\"}]}");
        Assert.Equal(new byte[] { 1, 2, 3 }, inline.Bytes);
        var url = NotepadHub.Core.Ai.AiService.ParseImageAnswer("{\"data\":[{\"url\":\"https://x.test/a.png\"}]}");
        Assert.Equal("https://x.test/a.png", url.Url);
        Assert.Null(NotepadHub.Core.Ai.AiService.ParseImageAnswer("{\"data\":[]}").Bytes);
        Assert.Null(NotepadHub.Core.Ai.AiService.ParseImageAnswer("{\"nodata\":1}").Url);
    }

    [Fact]
    public async Task GenerationNeedsConsentAndRefusesSecretsAndTooShortRequests()
    {
        var svc = new NotepadHub.Core.Ai.AiService(new HttpClient(), new Stub());
        using var fetcher = new NotepadHub.Core.ImageFetcher();
        var e1 = await Assert.ThrowsAsync<NotepadHub.Core.Ai.AiHttpException>(() => svc.GenerateImageAsync("кот на диване", 512, 512, "pollinations", "", false, fetcher, CancellationToken.None));
        Assert.Equal(403, e1.Status);
        var e2 = await Assert.ThrowsAsync<NotepadHub.Core.Ai.AiHttpException>(() => svc.GenerateImageAsync("кот и ключ sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789", 512, 512, "pollinations", "", true, fetcher, CancellationToken.None));
        Assert.Equal(400, e2.Status);
        var e3 = await Assert.ThrowsAsync<NotepadHub.Core.Ai.AiHttpException>(() => svc.GenerateImageAsync("ab", 512, 512, "pollinations", "", true, fetcher, CancellationToken.None));
        Assert.Equal(400, e3.Status);
    }

    private sealed class Stub : NotepadHub.Core.Ai.IAiSecretStore
    {
        public string? GetOpenRouterKey() => null;
        public void SetOpenRouterKey(string key) { }
        public void ClearOpenRouterKey() { }
    }
}

public class DefaultServiceTests
{
    [Fact]
    public void TheFreeDefaultNeedsNoKeyAndIsAPublicKeylessService()
    {
        var d = NotepadHub.Core.Ai.CompatServiceStore.DefaultService;
        Assert.Equal("text.pollinations.ai", d.BaseUrl.Host);
        Assert.True(d.KeyOptional);
        Assert.False(d.Local);
    }

    [Fact]
    public void OtherPublicServicesStillNeedAKey()
    {
        var groq = new NotepadHub.Core.Ai.CompatServiceStore.Config(new Uri("https://api.groq.com/openai/v1"), "Groq");
        Assert.False(groq.KeyOptional);
        var lm = new NotepadHub.Core.Ai.CompatServiceStore.Config(new Uri("http://127.0.0.1:1234/v1"), "LM");
        Assert.True(lm.KeyOptional);
    }
}
