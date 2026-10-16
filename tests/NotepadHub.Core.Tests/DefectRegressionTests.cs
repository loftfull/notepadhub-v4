using System.Net;
using System.Text;
using System.Text.Json;
using NotepadHub.Core.Ai;

namespace NotepadHub.Core.Tests;

/// <summary>Regression tests for the defects found by the independent QA review (docs/QA_REPORT.md). Each asserts the safe behaviour.</summary>
public class DefectRegressionTests
{
    private sealed class Root : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "nh4-qa-" + Guid.NewGuid().ToString("N"));
        public DataPaths Paths => new(Path);
        public Root() { Directory.CreateDirectory(Path); }
        public NoteStore Open() { var s = new NoteStore(Paths); s.Initialize(); return s; }
        public string Ext(string name) { var d = System.IO.Path.Combine(Path, "external"); Directory.CreateDirectory(d); return System.IO.Path.Combine(d, name); }

        /// <summary>Заметка "как из 3.0.5 / переноса из Блокнота Windows": SourceLastWriteUtc пуст (так у всех 26 файловых заметок реального профиля).</summary>
        public void LegacyFileNote(string id, string sourcePath, string content, string sourceType = "file")
        {
            var p = Paths; p.Ensure();
            var meta = "{\"Id\":\"" + id + "\",\"Title\":\"legacy\",\"ProjectId\":\"inbox\",\"SourcePath\":" + JsonSerializer.Serialize(sourcePath) + ",\"SourceType\":\"" + sourceType + "\",\"ContentType\":\"text\",\"Tags\":\"\",\"CreatedUtc\":\"2026-10-01T10:00:00.0000000Z\",\"UpdatedUtc\":\"2026-10-01T10:00:00.0000000Z\",\"LastOpenedUtc\":\"\",\"SourceLastWriteUtc\":\"\",\"LegacySourceGuid\":\"g\",\"IsPinned\":false,\"IsArchived\":false,\"IsDeleted\":false,\"ExternalOnly\":false}";
            File.WriteAllText(p.MetaPath(id), meta, new UTF8Encoding(false));
            File.WriteAllText(p.ContentPath(id), content, new UTF8Encoding(false));
        }

        public void Dispose() { try { if (Path.Contains("nh4-qa-")) Directory.Delete(Path, true); } catch { } }
    }

    // ------------------------------------------------------------------ QA-01 / QA-02 (D-01, D-02)
    [Fact]
    public void QA01_open_in_place_of_an_empty_legacy_file_note_takes_the_real_file_text()
    {
        using var r = new Root();
        var file = r.Ext("real.txt");
        File.WriteAllText(file, "ВАЖНЫЙ ТЕКСТ ФАЙЛА\nстрока 2\nстрока 3", new UTF8Encoding(false));
        r.LegacyFileNote("legacy1", file, "");                    // like 15 of 26 file notes of the real profile: text is empty
        using var s = r.Open();
        var note = s.OpenInPlace(file, "inbox");
        Assert.Equal("legacy1", note.Id);
        Assert.Equal("ВАЖНЫЙ ТЕКСТ ФАЙЛА\nстрока 2\nстрока 3", s.Open(note.Id).Content);   // the editor shows the file, not an empty note
        Assert.Equal("ВАЖНЫЙ ТЕКСТ ФАЙЛА\nстрока 2\nстрока 3", File.ReadAllText(file));      // opening does not touch the file
    }

    [Fact]
    public void QA02_open_in_place_of_a_stale_legacy_note_shows_the_newer_file_and_keeps_the_old_text_in_history()
    {
        using var r = new Root();
        var file = r.Ext("doc.txt");
        File.WriteAllText(file, "НОВАЯ версия на диске, дописанная после снимка", new UTF8Encoding(false));
        r.LegacyFileNote("legacy2", file, "старый снимок из Блокнота");
        using var s = r.Open();
        var note = s.OpenInPlace(file, "inbox");
        Assert.Equal("НОВАЯ версия на диске, дописанная после снимка", s.Open(note.Id).Content);
        Assert.NotEmpty(s.ListHistory(note.Id));
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "НОВАЯ версия на диске, дописанная после снимка + правка" });
        Assert.EndsWith("+ правка", File.ReadAllText(file));
    }

    [Fact]
    public void A_legacy_note_without_a_known_file_stamp_never_overwrites_the_file_by_plain_save()
    {
        using var r = new Root();
        var file = r.Ext("plain.txt");
        File.WriteAllText(file, "как на диске", new UTF8Encoding(false));
        r.LegacyFileNote("legacy3", file, "другое");
        using var s = r.Open();
        Assert.Throws<SourceChangedException>(() => s.SaveToSource("legacy3"));
        Assert.Equal("как на диске", File.ReadAllText(file));
    }

    // ------------------------------------------------------------------ QA-03 (важно, безопасность)
    [Fact]
    public void QA03_resolve_conflict_mine_must_not_write_outside_the_text_whitelist_or_without_write_through()
    {
        using var r = new Root();
        var target = r.Ext("startup.bat");
        File.WriteAllText(target, "echo original", new UTF8Encoding(false));
        r.LegacyFileNote("evil1", target, "echo pwned", sourceType: "local");   // запись из чужой .nhub: SourceType=local, путь любой
        using var s = r.Open();
        try { s.ResolveSourceConflict("evil1", "mine"); } catch (Exception) { /* отказ - это и ожидается */ }
        Assert.Equal("echo original", File.ReadAllText(target));
    }

    // ------------------------------------------------------------------ QA-04 (важно, безопасность)
    [Fact]
    public void QA04_resolve_conflict_disk_must_not_read_secret_like_files_into_a_note()
    {
        using var r = new Root();
        var secret = r.Ext("prod.env");
        File.WriteAllText(secret, "DB_PASSWORD=Sup3rSecretValue", new UTF8Encoding(false));
        r.LegacyFileNote("evil2", secret, "", sourceType: "local");   // SourceType=local обходит IsExternalOnly; при "file" текст всё равно копируется в notes-content, но редактор его не показывает
        using var s = r.Open();
        string? refused = null;
        try { s.ResolveSourceConflict("evil2", "disk"); } catch (Exception ex) { refused = ex.GetType().Name + ": " + ex.Message; }
        // ListResolvableReferences/ResolveReferencedFiles .env не читают; здесь проверяем и файл хранилища, и то, что видит редактор
        var stored = File.ReadAllText(r.Paths.ContentPath("evil2"));
        Assert.True(refused != null || !stored.Contains("Sup3rSecretValue"), "ResolveSourceConflict(disk) скопировал .env в хранилище заметок: notes-content\\evil2.txt");
        Assert.True(refused != null || !s.Open("evil2").Content.Contains("Sup3rSecretValue"), "ResolveSourceConflict(disk) показал .env в редакторе");
    }

    // ------------------------------------------------------------------ QA-05 (важно)
    [Fact]
    public void QA05_windows_1251_file_must_keep_its_encoding_after_write_through()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        var cp = Encoding.GetEncoding(1251);
        using var r = new Root();
        var file = r.Ext("ansi.txt");
        File.WriteAllBytes(file, cp.GetBytes("привет мир\r\nвторая строка"));
        using var s = r.Open();
        var note = s.OpenInPlace(file, "inbox");
        Assert.Equal("привет мир\r\nвторая строка", s.Open(note.Id).Content);   // прочитано как cp1251
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "привет мир!\nвторая строка" });
        var bytes = File.ReadAllBytes(file);
        Assert.Equal("привет мир!\r\nвторая строка", cp.GetString(bytes));       // ожидаем cp1251, фактически UTF-8
    }

    // ------------------------------------------------------------------ QA-06 (мелочь)
    [Fact]
    public void QA06_utf16_crlf_file_must_keep_crlf_after_write_through()
    {
        using var r = new Root();
        var file = r.Ext("u16.txt");
        File.WriteAllBytes(file, Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes("a\r\nb")).ToArray());
        using var s = r.Open();
        var note = s.OpenInPlace(file, "inbox");
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "a\nb!" });
        var bytes = File.ReadAllBytes(file);
        Assert.Equal(new byte[] { 0xFF, 0xFE }, bytes.Take(2).ToArray());
        Assert.Equal("a\r\nb!", Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2));
    }

    // ------------------------------------------------------------------ QA-07 (мелочь/важно)
    [Fact]
    public void QA07_write_through_must_not_recreate_a_file_the_user_deleted_or_moved()
    {
        using var r = new Root();
        var file = r.Ext("moved.txt");
        File.WriteAllText(file, "v1", new UTF8Encoding(false));
        using var s = r.Open();
        var note = s.OpenInPlace(file, "inbox");
        File.Delete(file);                                           // пользователь удалил/переместил файл
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "v2" });
        Assert.False(File.Exists(file), "Приложение молча воссоздало удалённый/перенесённый файл по старому пути");
    }

    // ------------------------------------------------------------------ QA-08 (мелочь)
    [Fact]
    public void QA08_permanent_delete_must_forget_the_write_through_id()
    {
        using var r = new Root();
        var file = r.Ext("gone.txt");
        File.WriteAllText(file, "v1", new UTF8Encoding(false));
        using var s = r.Open();
        var note = s.OpenInPlace(file, "inbox");
        s.SetFlags(note.Id, deleted: true);
        s.DeletePermanently(note.Id);
        Assert.DoesNotContain(note.Id, s.Settings.WriteThroughIds);
    }

    // ------------------------------------------------------------------ QA-09 (важно, гонка)
    [Fact]
    public void QA09_parallel_upserts_into_a_write_through_note_must_leave_file_equal_to_the_stored_text_and_report_no_errors()
    {
        using var r = new Root();
        var file = r.Ext("race.txt");
        File.WriteAllText(file, "v0", new UTF8Encoding(false));
        using var s = r.Open();
        var events = new System.Collections.Concurrent.ConcurrentBag<string>();
        s.SourceStatus += (_, st, m) => events.Add(st + ":" + m);
        var note = s.OpenInPlace(file, "inbox");
        Parallel.For(1, 40, new ParallelOptions { MaxDegreeOfParallelism = 8 }, i =>
        {
            try { s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "v" + i }); } catch (Exception) { }
        });
        Assert.DoesNotContain(events, e => e.StartsWith("error") || e.StartsWith("conflict"));
        Assert.Equal(s.Open(note.Id, markOpened: false).Content, File.ReadAllText(file));
    }

    // ------------------------------------------------------------------ QA-10 (важно, приватность)
    [Theory]
    [InlineData("Пароль - Qwerty12345")]                         // обычный дефис, не длинное тире
    [InlineData("пароль от почты: Qwerty12345")]                  // слова между ключом и разделителем
    [InlineData("Мой password is Qwerty12345")]
    [InlineData("логин admin / пароль Qwerty12345")]
    public void QA10_secret_scanner_should_catch_typical_russian_phrasing(string text) =>
        Assert.NotEmpty(SecretScanner.Find("заметка\n" + text + "\nконец"));

    // ------------------------------------------------------------------ QA-11 (мелочь)
    private sealed class Secrets : IAiSecretStore
    {
        public string? GetOpenRouterKey() => "test-key-0123456789abcdef";
        public void SetOpenRouterKey(string key) { }
        public void ClearOpenRouterKey() { }
    }

    private sealed class Handler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(
                "{\"data\":[{\"id\":\"paid/model\",\"name\":\"Paid\",\"architecture\":{\"input_modalities\":[\"text\"],\"output_modalities\":[\"text\"]},\"pricing\":{\"prompt\":\"0.000001\",\"completion\":\"0.000002\"}}]}", Encoding.UTF8, "application/json") });
    }

    [Fact]
    public async Task QA11_request_refused_with_402_must_not_consume_the_cloud_call_quota()
    {
        var svc = new AiService(new HttpClient(new Handler()), new Secrets(), null, new Uri("http://127.0.0.1:11434"));
        var body = JsonSerializer.SerializeToElement(new { provider = "openrouter", model = "paid/model", operation = "proofread", scope = "paragraph", contextText = "Привет, мир", noteTitle = "t", remoteConsent = true, costConfirmed = false });
        var ex = await Assert.ThrowsAsync<AiHttpException>(() => svc.StartStreamAsync("q1", body, _ => { }));
        Assert.Equal(402, ex.Status);
        var usage = JsonSerializer.SerializeToElement(svc.Usage());
        Assert.Equal(0, usage.GetProperty("callsToday").GetInt32());     // фактически 1: EnforceCloudRate вызывается до проверки подтверждения
    }

    // ------------------------------------------------------------------ round 2 (docs/QA_REPORT_2.md)
    [Fact]
    public void N01_a_forged_backup_cannot_point_a_note_at_a_file_on_this_computer()
    {
        using var attacker = new Root(); using var victim = new Root();
        var startup = victim.Ext("startup.bat");
        File.WriteAllText(startup, "echo original", new UTF8Encoding(false));
        attacker.LegacyFileNote("forged1", startup, "echo pwned");
        using (var a = attacker.Open())
        {
            var nhub = System.IO.Path.Combine(attacker.Path, "forged.nhub");
            NotepadHub.Core.Backup.NhubBackup.Create(a, nhub, "x");
            using var v = victim.Open();
            NotepadHub.Core.Backup.NhubBackup.Restore(v, nhub, "x");
            var meta = v.FindMeta("forged1")!;
            Assert.Equal("", meta.SourcePath);
            Assert.Equal("local", meta.SourceType);
            Assert.ThrowsAny<Exception>(() => v.ResolveSourceConflict("forged1", "mine"));
        }
        Assert.Equal("echo original", File.ReadAllText(startup));
    }

    [Fact]
    public void N01_restoring_your_own_backup_keeps_your_file_links()
    {
        using var r = new Root();
        var file = r.Ext("mine.txt");
        File.WriteAllText(file, "текст", new UTF8Encoding(false));
        using var s = r.Open();
        var note = s.OpenInPlace(file, "inbox");
        var nhub = System.IO.Path.Combine(r.Path, "own.nhub");
        NotepadHub.Core.Backup.NhubBackup.Create(s, nhub, "x");
        NotepadHub.Core.Backup.NhubBackup.Restore(s, nhub, "x");
        Assert.Equal(file, s.FindMeta(note.Id)!.SourcePath, ignoreCase: true);
    }

    [Fact]
    public void N09_opening_a_file_whose_note_is_in_the_trash_restores_that_note()
    {
        using var r = new Root();
        var file = r.Ext("again.txt");
        File.WriteAllText(file, "a", new UTF8Encoding(false));
        using var s = r.Open();
        var first = s.OpenInPlace(file, "inbox");
        s.SetFlags(first.Id, deleted: true);
        var second = s.OpenInPlace(file, "inbox");
        Assert.Equal(first.Id, second.Id);
        Assert.False(s.FindMeta(first.Id)!.IsDeleted);
        Assert.Single(s.AllNotes(), n => n.SourcePath.EndsWith("again.txt", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void N05_a_file_over_the_editor_character_limit_stays_a_reference()
    {
        using var r = new Root();
        var file = r.Ext("long.txt");
        File.WriteAllText(file, new string('я', NoteStore.EditorLimitChars + 10), new UTF8Encoding(false));
        using var s = r.Open();
        Assert.True(s.IsExternalOnly(s.OpenInPlace(file, "inbox")));
    }

    [Fact]
    public async Task N02_a_cloud_request_that_fails_to_send_gives_the_quota_and_budget_back()
    {
        var dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "nh4-usage-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            var h = new NotepadHub.Core.Tests.AiTests.RefundHandler();
            var svc = new AiService(new HttpClient(h), new NotepadHub.Core.Tests.AiTests.RefundSecrets(), null, new Uri("http://127.0.0.1:11434"), new FileAiUsageStore(dir), 5.0);
            await Assert.ThrowsAnyAsync<Exception>(() => svc.StartStreamAsync("x", JsonSerializer.SerializeToElement(new { provider = "openrouter", model = "paid/model", operation = "proofread", scope = "paragraph", contextText = "текст", noteTitle = "t", remoteConsent = true, costConfirmed = true }), _ => { }));
            var usage = new FileAiUsageStore(dir).Load();
            Assert.Empty(usage.CloudCalls);
            Assert.Equal(0, usage.SpentUsd, 9);
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }
}
