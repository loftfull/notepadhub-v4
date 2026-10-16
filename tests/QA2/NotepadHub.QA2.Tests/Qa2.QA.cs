using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using NotepadHub.Core.Ai;
using NotepadHub.Core.Backup;

namespace NotepadHub.Core.QA2;

/// <summary>Второй независимый проход. Каждый тест утверждает БЕЗОПАСНОЕ поведение: падение = подтверждённый дефект. Пишут только в %TEMP%\nh4-qa2-*.</summary>
public class Qa2
{
    private sealed class Root : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "nh4-qa2-" + Guid.NewGuid().ToString("N"));
        public DataPaths Paths => new(Path);
        public Root() { Directory.CreateDirectory(Path); }
        public NoteStore Open() { var s = new NoteStore(Paths); s.Initialize(); return s; }
        public string Ext(string name) { var d = System.IO.Path.Combine(Path, "external"); Directory.CreateDirectory(d); return System.IO.Path.Combine(d, name); }
        public void FileNote(string id, string sourcePath, string content, string sourceType = "file", string stamp = "")
        {
            var p = Paths; p.Ensure();
            var meta = "{\"Id\":\"" + id + "\",\"Title\":\"legacy\",\"ProjectId\":\"inbox\",\"SourcePath\":" + JsonSerializer.Serialize(sourcePath) + ",\"SourceType\":\"" + sourceType + "\",\"ContentType\":\"text\",\"Tags\":\"\",\"CreatedUtc\":\"2026-10-01T10:00:00.0000000Z\",\"UpdatedUtc\":\"2026-10-01T10:00:00.0000000Z\",\"LastOpenedUtc\":\"\",\"SourceLastWriteUtc\":\"" + stamp + "\",\"LegacySourceGuid\":\"g\",\"IsPinned\":false,\"IsArchived\":false,\"IsDeleted\":false,\"ExternalOnly\":false}";
            File.WriteAllText(p.MetaPath(id), meta, new UTF8Encoding(false));
            File.WriteAllText(p.ContentPath(id), content, new UTF8Encoding(false));
        }
        public void Dispose() { try { if (Path.Contains("nh4-qa2-")) Directory.Delete(Path, true); } catch { } }
    }

    [Fact]
    public void Q2_01a_forged_nhub_note_must_not_let_the_bridge_overwrite_a_script_with_resolveSourceConflict_mine()
    {
        using var attacker = new Root(); using var victim = new Root();
        var startup = victim.Ext("startup.bat");
        File.WriteAllText(startup, "echo original", new UTF8Encoding(false));
        attacker.FileNote("forged1", startup, "echo pwned");
        using (var a = attacker.Open())
        {
            var nhub = System.IO.Path.Combine(attacker.Path, "forged.nhub");
            NhubBackup.Create(a, nhub, "x");
            using var v = victim.Open();
            NhubBackup.Restore(v, nhub, "x");
            Assert.Equal("file", v.FindMeta("forged1")!.SourceType);
            try { v.ResolveSourceConflict("forged1", "mine"); } catch (Exception) { }
        }
        Assert.Equal("echo original", File.ReadAllText(startup));
    }

    [Fact]
    public void Q2_01b_forged_nhub_note_must_not_create_a_new_script_file_through_write_through()
    {
        using var attacker = new Root(); using var victim = new Root();
        var startup = victim.Ext("new-autorun.cmd");
        attacker.FileNote("forged2", startup, "calc.exe");
        using (var a = attacker.Open())
        {
            var nhub = System.IO.Path.Combine(attacker.Path, "forged.nhub");
            NhubBackup.Create(a, nhub, "x");
            using var v = victim.Open();
            NhubBackup.Restore(v, nhub, "x");
            try { v.SetWriteThrough("forged2", true); v.Upsert(new NoteStore.UpsertRequest { Id = "forged2", Content = "calc.exe\nправка" }); } catch (Exception) { }
        }
        Assert.False(File.Exists(startup), "write-through создал " + startup + " по пути из чужой .nhub");
    }

    [Fact]
    public void Q2_01c_forged_nhub_empty_note_must_not_pull_a_json_secret_file_into_the_library()
    {
        using var attacker = new Root(); using var victim = new Root();
        var secret = victim.Ext("config.json");
        File.WriteAllText(secret, "{\"auths\":{\"x\":{\"auth\":\"c2VjcmV0LXRva2Vu\"}}}", new UTF8Encoding(false));
        attacker.FileNote("forged3", secret, "");
        using (var a = attacker.Open())
        {
            var nhub = System.IO.Path.Combine(attacker.Path, "forged.nhub");
            NhubBackup.Create(a, nhub, "x");
            using var v = victim.Open();
            NhubBackup.Restore(v, nhub, "x");
            Assert.Equal(0, v.ResolveReferencedFiles(new[] { "forged3" }));
        }
    }

    [Fact]
    public void Q2_02_a_file_longer_than_the_editor_limit_must_not_be_loaded_as_an_editable_note()
    {
        using var r = new Root();
        var big = r.Ext("big.txt");
        File.WriteAllText(big, new string('a', NoteStore.EditorLimitChars + 5000), new UTF8Encoding(false));
        using var s = r.Open();
        var note = s.OpenInPlace(big, "inbox");
        var doc = s.Open(note.Id);
        Assert.True(doc.ExternalOnly || doc.Content.Length <= NoteStore.EditorLimitChars, "в редактор отдан текст длиной " + doc.Content.Length);
    }

    [Fact]
    public void Q2_03_write_through_must_not_rewrite_line_endings_of_lines_the_user_did_not_touch()
    {
        using var r = new Root();
        var f = r.Ext("mixed.txt");
        File.WriteAllBytes(f, Encoding.UTF8.GetBytes("a\r\nb\nc"));
        using var s = r.Open();
        var note = s.OpenInPlace(f, "inbox");
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "a\nb\nc!" });
        Assert.Equal("a\r\nb\nc!", File.ReadAllText(f));
    }

    [Fact]
    public void Q2_04_write_through_must_refuse_a_path_that_goes_through_a_directory_junction()
    {
        using var r = new Root();
        var real = System.IO.Path.Combine(r.Path, "realdir"); Directory.CreateDirectory(real);
        var link = System.IO.Path.Combine(r.Path, "junc");
        var p = Process.Start(new ProcessStartInfo("cmd.exe", "/c mklink /J \"" + link + "\" \"" + real + "\"") { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true });
        p!.WaitForExit();
        Assert.True(Directory.Exists(link), "junction не создан (стенд)");
        var viaLink = System.IO.Path.Combine(link, "n.txt");
        File.WriteAllText(System.IO.Path.Combine(real, "n.txt"), "orig", new UTF8Encoding(false));
        using var s = r.Open();
        var note = s.OpenInPlace(viaLink, "inbox");
        try { s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "changed" }); } catch (Exception) { }
        var result = File.ReadAllText(System.IO.Path.Combine(real, "n.txt"));
        Directory.Delete(link);
        Assert.Equal("orig", result);
    }

    [Theory]
    [InlineData("a", 24000)]
    [InlineData("password", 3000)]
    [InlineData("token_", 4000)]
    [InlineData("пароль 1", 3000)]
    [InlineData("api key", 3400)]
    public void Q2_05_secret_scanner_must_finish_a_24000_char_text_quickly(string unit, int repeat)
    {
        var text = string.Concat(Enumerable.Repeat(unit, repeat));
        if (text.Length > 24000) text = text[..24000];
        var sw = Stopwatch.StartNew();
        SecretScanner.Find(text);
        sw.Stop();
        Assert.True(sw.ElapsedMilliseconds < 1500, unit + " x" + repeat + ": " + sw.ElapsedMilliseconds + " мс");
    }

    private sealed class Mem : IAiSecretStore { public string? Key = "sk-or-v1-test-key-0000000000000000"; public string? GetOpenRouterKey() => Key; public void SetOpenRouterKey(string k) { Key = k; } public void ClearOpenRouterKey() { Key = null; } }
    private sealed class H : HttpMessageHandler
    {
        public int ModelsDelayMs; public int ChatCalls;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
        {
            if (r.RequestUri!.AbsolutePath.EndsWith("/models"))
            {
                if (ModelsDelayMs > 0) await Task.Delay(ModelsDelayMs, ct);
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Catalog, Encoding.UTF8, "application/json") };
            }
            Interlocked.Increment(ref ChatCalls);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n") };
        }
    }
    private const string Catalog = "{\"data\":[" +
        "{\"id\":\"free/model\",\"name\":\"Free\",\"architecture\":{\"input_modalities\":[\"text\"],\"output_modalities\":[\"text\"]},\"pricing\":{\"prompt\":\"0\",\"completion\":\"0\"}}," +
        "{\"id\":\"paid/model\",\"name\":\"Paid\",\"architecture\":{\"input_modalities\":[\"text\"],\"output_modalities\":[\"text\"]},\"pricing\":{\"prompt\":\"0.000001\",\"completion\":\"0.000002\"}}]}";
    private static JsonElement Body(string model) => JsonSerializer.SerializeToElement(new { provider = "openrouter", model, operation = "proofread", scope = "paragraph", contextText = "Привет, мир", noteTitle = "t", remoteConsent = true, costConfirmed = true });
    private static JsonElement U(AiService s) => JsonSerializer.SerializeToElement(s.Usage());

    [Fact]
    public async Task Q2_06_parallel_cloud_requests_must_not_exceed_the_per_minute_limit()
    {
        var h = new H { ModelsDelayMs = 300 };
        var svc = new AiService(new HttpClient(h), new Mem(), null, new Uri("http://127.0.0.1:11434"));
        var tasks = Enumerable.Range(0, 30).Select(i => Task.Run(async () => { try { await svc.StartStreamAsync("p" + i, Body("free/model"), _ => { }); } catch (AiHttpException) { } })).ToArray();
        await Task.WhenAll(tasks);
        await Task.Delay(300);
        Assert.True(h.ChatCalls <= 10, "ушло " + h.ChatCalls + " облачных запросов при лимите 10 в минуту");
    }

    [Fact]
    public async Task Q2_07_a_request_cancelled_while_the_confirmation_dialog_is_open_must_not_use_up_quota_or_budget()
    {
        var h = new H();
        AiService? svc = null;
        svc = new AiService(new HttpClient(h), new Mem(), null, new Uri("http://127.0.0.1:11434"), null, null, info => { svc!.Cancel("r1"); return Task.FromResult(true); });
        try { await svc.StartStreamAsync("r1", Body("paid/model"), _ => { }); } catch (Exception) { }
        var u = U(svc);
        Assert.Equal(0, h.ChatCalls);
        Assert.True(u.GetProperty("callsToday").GetInt32() == 0 && u.GetProperty("spentMonthUsd").GetDouble() == 0, "ничего не отправлено, но списано: " + u);
    }

    private sealed class FailHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct) =>
            Task.FromResult(r.RequestUri!.AbsolutePath.EndsWith("/models")
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Catalog, Encoding.UTF8, "application/json") }
                : new HttpResponseMessage(HttpStatusCode.InternalServerError));
    }

    [Fact]
    public async Task Q2_08_a_failed_cloud_send_must_not_keep_the_budget_reservation()
    {
        var svc = new AiService(new HttpClient(new FailHandler()), new Mem(), null, new Uri("http://127.0.0.1:11434"), null, null, _ => Task.FromResult(true));
        try { await svc.StartStreamAsync("f1", Body("paid/model"), _ => { }); } catch (Exception) { }
        var u = U(svc);
        Assert.True(u.GetProperty("spentMonthUsd").GetDouble() == 0, "запрос не дошёл до провайдера, но бюджет списан: " + u);
    }

    [Fact]
    public void Q2_09_parallel_source_saves_of_different_notes_must_not_corrupt_internal_state()
    {
        using var r = new Root();
        using var s = r.Open();
        var notes = new List<string>();
        for (var i = 0; i < 8; i++)
        {
            var f = r.Ext("p" + i + ".txt"); File.WriteAllText(f, "x", new UTF8Encoding(false));
            notes.Add(s.OpenInPlace(f, "inbox").Id);
        }
        var errors = new List<string>();
        var tasks = notes.Select(id => Task.Run(() =>
        {
            for (var k = 0; k < 40; k++)
                try { s.SaveToSource(id, overwriteExternalChange: true); }
                catch (Exception ex) when (ex is not IOException) { lock (errors) errors.Add(ex.GetType().Name + ": " + ex.Message); }
        })).ToArray();
        Assert.True(Task.WaitAll(tasks, 60000), "зависание");
        Assert.Empty(errors);
    }

    [Fact]
    public void Q2_10_write_through_of_a_note_on_a_temporarily_missing_drive_must_survive_a_restart()
    {
        var used = DriveInfo.GetDrives().Select(d => char.ToUpper(d.Name[0])).ToHashSet();
        var letter = "QPRSTUVWXYZ".First(c => !used.Contains(c));
        using var r = new Root();
        r.FileNote("usb1", letter + @":\notes\todo.txt", "x", stamp: "2026-10-01T10:00:00.0000000Z");
        File.WriteAllText(r.Paths.SettingsV4Path, "{\"WriteThroughIds\":[\"usb1\"]}");
        using (var s = r.Open()) { }
        Assert.Contains("usb1", File.ReadAllText(r.Paths.SettingsV4Path));
    }

    [Fact]
    public void Q2_11_read_only_source_stays_intact_reports_error_and_leaves_no_temp_files()
    {
        using var r = new Root();
        var f = r.Ext("ro.txt"); File.WriteAllText(f, "orig", new UTF8Encoding(false));
        using var s = r.Open();
        var note = s.OpenInPlace(f, "inbox");
        var events = new List<string>(); s.SourceStatus += (id, st, m) => events.Add(st);
        File.SetAttributes(f, FileAttributes.ReadOnly);
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "changed" });
        var left = Directory.GetFiles(System.IO.Path.GetDirectoryName(f)!).Select(x => System.IO.Path.GetFileName(x)).ToList();
        File.SetAttributes(f, FileAttributes.Normal);
        Assert.Equal("orig", File.ReadAllText(f));
        Assert.Contains("error", events);
        Assert.Equal(new[] { "ro.txt" }, left.ToArray());
    }

    [Fact]
    public void Q2_12_empty_file_opens_in_place_and_saves_back()
    {
        using var r = new Root();
        var f = r.Ext("empty.txt"); File.WriteAllBytes(f, Array.Empty<byte>());
        using var s = r.Open();
        var n = s.OpenInPlace(f, "inbox");
        Assert.True(s.IsWriteThrough(n.Id));
        s.Upsert(new NoteStore.UpsertRequest { Id = n.Id, Content = "x" });
        Assert.Equal("x", File.ReadAllText(f));
    }

    [Fact]
    public void Q2_13_binary_file_is_refused_and_not_modified()
    {
        using var r = new Root();
        var f = r.Ext("bin.txt"); var bytes = new byte[] { 0, 1, 2, 3, 0, 0, 255, 254, 0, 9 }; File.WriteAllBytes(f, bytes);
        using var s = r.Open();
        Assert.ThrowsAny<Exception>(() => s.OpenInPlace(f, "inbox"));
        Assert.Equal(bytes, File.ReadAllBytes(f));
        Assert.Empty(s.AllNotes());
    }

    [Fact]
    public void Q2_14_opening_the_same_file_after_its_note_went_to_trash_must_not_create_a_second_note_for_it()
    {
        using var r = new Root();
        var f = r.Ext("dup.txt"); File.WriteAllText(f, "t", new UTF8Encoding(false));
        using var s = r.Open();
        var a = s.OpenInPlace(f, "inbox");
        s.SetFlags(a.Id, deleted: true);
        s.OpenInPlace(f, "inbox");
        Assert.True(s.AllNotes().Count(n => n.SourcePath == f) == 1, "заметок для файла: " + s.AllNotes().Count(n => n.SourcePath == f));
    }

    [Fact]
    public void Q2_15_unc_relative_and_device_paths_never_get_write_through()
    {
        using var r = new Root();
        r.FileNote("p1", @"\\server\share\a.txt", "x");
        r.FileNote("p2", @"..\a.txt", "x");
        r.FileNote("p3", @"\\?\C:\Temp\a.txt", "x");
        r.FileNote("p4", @"C:a.txt", "x");
        r.FileNote("p5", "//server/share/a.txt", "x");
        using var s = r.Open();
        foreach (var id in new[] { "p1", "p2", "p3", "p4", "p5" })
            Assert.ThrowsAny<InvalidOperationException>(() => s.SetWriteThrough(id, true));
    }
}
