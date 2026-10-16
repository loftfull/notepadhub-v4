using System.IO.Compression;
using System.Text;
using System.Text.Json;
using NotepadHub.Core.Bridge;

namespace NotepadHub.Core.Tests;

public class BridgeTests
{
    private sealed class FakeUi : IHostUi
    {
        public string? Snapshot { get; set; }
        public List<string> Files { get; } = new();
        public string? PickWindowsSnapshot() => Snapshot;
        public IReadOnlyList<string> PickTextFiles() => Files;
        public string? SavePath { get; set; }
        public string? OpenPath { get; set; }
        public bool Confirm { get; set; }
        public List<string> Revealed { get; } = new();
        public void RevealFile(string path) => Revealed.Add(path);
        public string? PickBackupSavePath(string suggestedName) => SavePath;
        public string? PickBackupOpenPath() => OpenPath;
        public bool ConfirmRestore(NotepadHub.Core.Backup.BackupInfo backup, int currentNotes) => Confirm;
    }

    private static JsonElement J(object o) => JsonSerializer.SerializeToElement(o, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    private static async Task<JsonElement> Call(BridgeDispatcher d, string type, object? payload = null)
    {
        var r = await d.HandleAsync(type, payload == null ? default : J(payload));
        return JsonSerializer.SerializeToElement(r, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    }

    [Fact]
    public async Task Bootstrap_on_an_empty_profile_returns_contract_1_with_system_folders()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var d = new BridgeDispatcher(s, new FakeUi(), "test");
        var b = await Call(d, "bootstrap");
        Assert.Equal(1, b.GetProperty("contract").GetInt32());
        Assert.Equal("host", b.GetProperty("mode").GetString());
        var ids = b.GetProperty("projects").EnumerateArray().Select(p => p.GetProperty("id").GetString()).ToList();
        Assert.Contains("inbox", ids); Assert.Contains("import-windows", ids);
        Assert.Equal(0, b.GetProperty("notes").GetArrayLength());
    }

    [Fact]
    public async Task Reveal_note_shows_only_the_notes_own_file_and_refuses_an_unknown_id()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var ui = new FakeUi();
        var d = new BridgeDispatcher(s, ui, "test");
        await Call(d, "upsertNote", new { id = "note-1760000000001", projectId = "inbox", title = "Тест", tags = "", pinned = false, archived = false, deleted = false, content = "текст", blocksJson = "[]" });
        await Call(d, "revealNote", new { id = "note-1760000000001" });
        Assert.Single(ui.Revealed);
        Assert.EndsWith("note-1760000000001.txt", ui.Revealed[0]);
        await Assert.ThrowsAsync<BridgeException>(() => Call(d, "revealNote", new { id = "note-1760000000999" }));
        await Assert.ThrowsAnyAsync<Exception>(() => Call(d, "revealNote", new { id = "..\\..\\Windows\\win" }));
        Assert.Single(ui.Revealed);
    }

    [Fact]
    public async Task Upsert_is_idempotent_and_metadata_only_updates_keep_the_text()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var d = new BridgeDispatcher(s, new FakeUi(), "test");
        var body = new { id = "note-1760000000000", projectId = "inbox", title = "Заголовок", tags = "", pinned = false, archived = false, deleted = false,
                         content = "# Заголовок\nтекст", blocksJson = "[{\"type\":\"heading\"}]" };
        await Call(d, "upsertNote", body);
        await Call(d, "upsertNote", body);   // a retry after a timeout must not duplicate
        Assert.Single(s.AllNotes());

        await Call(d, "upsertNote", new { id = "note-1760000000000", projectId = "inbox", title = "Заголовок", tags = "метка", pinned = true, archived = false, deleted = false });
        var opened = s.Open("note-1760000000000");
        Assert.Equal("# Заголовок\nтекст", opened.Content);   // untouched: no content in the request
        Assert.Equal("[{\"type\":\"heading\"}]", opened.BlocksJson);
        Assert.True(opened.Meta.IsPinned);
        Assert.Equal("метка", opened.Meta.Tags);
    }

    [Theory]
    [InlineData("..\\evil")]
    [InlineData("a/b")]
    [InlineData("")]
    public async Task Upsert_refuses_unsafe_ids(string id)
    {
        using var t = new TempRoot(); using var s = t.Open();
        var d = new BridgeDispatcher(s, new FakeUi(), "test");
        await Assert.ThrowsAnyAsync<Exception>(() => Call(d, "upsertNote", new { id, projectId = "inbox", title = "x", content = "x", blocksJson = "[]" }));
        Assert.Empty(s.AllNotes());
    }

    [Fact]
    public async Task Failed_oversized_upsert_leaves_the_note_unchanged()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var d = new BridgeDispatcher(s, new FakeUi(), "test");
        await Call(d, "upsertNote", new { id = "n1", projectId = "inbox", title = "t", content = "исходный", blocksJson = "[]" });
        await Assert.ThrowsAsync<InvalidOperationException>(() => Call(d, "upsertNote", new { id = "n1", projectId = "inbox", title = "t", content = new string('x', NoteStore.EditorLimitChars + 1), blocksJson = "[]" }));
        Assert.Equal("исходный", s.Open("n1").Content);
    }

    [Fact]
    public async Task Bootstrap_does_not_touch_last_opened()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var n = s.CreateNote("inbox", "x");
        var before = File.ReadAllText(t.Paths.MetaPath(n.Id));
        var d = new BridgeDispatcher(s, new FakeUi(), "test");
        await Call(d, "bootstrap");
        Assert.Equal(before, File.ReadAllText(t.Paths.MetaPath(n.Id)));
    }

    [Fact]
    public async Task Permanent_delete_needs_the_note_to_be_in_the_trash_first()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var d = new BridgeDispatcher(s, new FakeUi(), "test");
        await Call(d, "upsertNote", new { id = "n1", projectId = "inbox", title = "t", content = "x", blocksJson = "[]" });
        await Assert.ThrowsAsync<InvalidOperationException>(() => Call(d, "deleteNote", new { id = "n1" }));
        await Call(d, "upsertNote", new { id = "n1", projectId = "inbox", title = "t", deleted = true });
        await Call(d, "deleteNote", new { id = "n1" });
        Assert.Empty(s.AllNotes());
    }

    [Fact]
    public async Task Import_dialog_cancel_does_nothing_and_a_snapshot_imports_through_the_host_dialog()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var ui = new FakeUi();
        var d = new BridgeDispatcher(s, ui, "test");
        var cancelled = await Call(d, "importWindowsSnapshot");
        Assert.True(cancelled.GetProperty("cancelled").GetBoolean());

        var zip = Path.Combine(t.Path, "snap.zip");
        using (var z = ZipFile.Open(zip, ZipArchiveMode.Create))
        {
            var e = z.CreateEntry("TabState/" + Guid.NewGuid() + ".bin");
            using var w = e.Open();
            using var ms = new MemoryStream();
            ms.WriteByte(0x4E); ms.WriteByte(0x50); ms.WriteByte(0); ms.WriteByte(0);
            ms.WriteByte(0); ms.WriteByte(0); ms.WriteByte(0); ms.Write(new byte[3]); ms.WriteByte(0);
            ms.WriteByte(3); ms.Write(Encoding.Unicode.GetBytes("abc")); ms.WriteByte(0); ms.Write(new byte[4]);
            w.Write(ms.ToArray());
        }
        ui.Snapshot = zip;
        var done = await Call(d, "importWindowsSnapshot");
        Assert.Equal(1, done.GetProperty("created").GetInt32());
        Assert.Equal("abc", s.Open(s.Query("import", null, null)[0].Id).Content);
    }

    [Fact]
    public async Task Open_files_imports_text_and_reports_unreadable_ones()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var ui = new FakeUi();
        var good = Path.Combine(t.Path, "ok.md"); File.WriteAllText(good, "# ok");
        var bad = Path.Combine(t.Path, "bad.exe"); File.WriteAllText(bad, "MZ");
        ui.Files.AddRange(new[] { good, bad });
        var r = await Call(new BridgeDispatcher(s, ui, "test"), "openFiles");
        Assert.Equal(1, r.GetProperty("created").GetArrayLength());
        Assert.Equal(1, r.GetProperty("warnings").GetArrayLength());
    }

    [Fact]
    public async Task Backup_and_restore_go_through_native_dialogs_and_need_confirmation()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var ui = new FakeUi();
        var d = new BridgeDispatcher(s, ui, "test");
        await Call(d, "upsertNote", new { id = "n1", projectId = "inbox", title = "t", content = "первый", blocksJson = "[]" });
        Assert.True((await Call(d, "createBackup")).GetProperty("cancelled").GetBoolean());       // no path chosen
        ui.SavePath = Path.Combine(t.Path, "b.nhub");
        var made = await Call(d, "createBackup");
        Assert.Equal(1, made.GetProperty("noteCount").GetInt32());
        Assert.True(File.Exists(ui.SavePath));

        await Call(d, "upsertNote", new { id = "n2", projectId = "inbox", title = "t2", content = "второй", blocksJson = "[]" });
        ui.OpenPath = ui.SavePath; ui.Confirm = false;
        Assert.True((await Call(d, "restoreBackup")).GetProperty("cancelled").GetBoolean());       // user said no
        Assert.Equal(2, s.AllNotes().Count);
        ui.Confirm = true;
        var done = await Call(d, "restoreBackup");
        Assert.Equal(1, done.GetProperty("restoredNotes").GetInt32());
        Assert.Single(s.AllNotes());
        Assert.StartsWith("before-restore-", done.GetProperty("rollbackFileName").GetString());
    }

    [Fact]
    public async Task Referenced_files_are_listed_first_and_read_only_for_the_ids_the_user_picked()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var d = new BridgeDispatcher(s, new FakeUi(), "test");
        var ok = Path.Combine(t.Path, "plan.txt"); File.WriteAllText(ok, "текст плана");
        var other = Path.Combine(t.Path, "other.md"); File.WriteAllText(other, "другой");
        var secret = Path.Combine(t.Path, ".env"); File.WriteAllText(secret, "KEY=value-value");
        var ids = new List<string>();
        foreach (var p in new[] { ok, other }) { var m = s.ImportFile(p, "inbox"); File.WriteAllText(t.Paths.ContentPath(m.Id), ""); ids.Add(m.Id); }
        // a snapshot note pointing at a secret-like file: the extension check keeps it out of every list
        var sec = s.CreateNote("inbox", ""); var meta = s.FindMeta(sec.Id)!;
        File.WriteAllText(t.Paths.MetaPath(sec.Id), System.Text.Json.JsonSerializer.Serialize(new { Id = sec.Id, Title = "env", ProjectId = "inbox", SourcePath = secret, SourceType = "file", ContentType = "text", Tags = "", CreatedUtc = meta.CreatedUtc, UpdatedUtc = meta.UpdatedUtc }));
        s.ReloadFromDisk();

        var preview = await Call(d, "previewReferencedFiles");
        Assert.Equal(2, preview.GetProperty("files").GetArrayLength());
        Assert.DoesNotContain(preview.GetProperty("files").EnumerateArray(), f => f.GetProperty("sourcePath").GetString()!.EndsWith(".env"));

        await Assert.ThrowsAsync<BridgeException>(() => Call(d, "resolveReferencedFiles", new { ids = new string[0] }));
        var done = await Call(d, "resolveReferencedFiles", new { ids = new[] { ids[0] } });
        Assert.Equal(1, done.GetProperty("filled").GetInt32());
        Assert.Equal("текст плана", s.Open(ids[0]).Content);
        Assert.Equal("", s.Open(ids[1]).Content);   // not picked → untouched
    }

    [Fact]
    public async Task Checkpoint_forces_a_history_entry()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var d = new BridgeDispatcher(s, new FakeUi(), "test");
        await Call(d, "upsertNote", new { id = "n1", projectId = "inbox", title = "t", content = "версия", blocksJson = "[]" });
        await Call(d, "checkpoint", new { id = "n1" });
        Assert.Single(s.ListHistory("n1"));
    }

    [Fact]
    public async Task Unknown_command_is_rejected()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var d = new BridgeDispatcher(s, new FakeUi(), "test");
        await Assert.ThrowsAsync<BridgeException>(() => Call(d, "formatDisk"));
    }
}


