using System.IO.Compression;
using System.Text;

namespace NotepadHub.Core.Tests;

/// <summary>All fixtures are synthetic: no real note content is read or printed by these tests.</summary>
public sealed class TempRoot : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "nh4-test-" + Guid.NewGuid().ToString("N"));
    public DataPaths Paths => new(Path);
    public TempRoot() { Directory.CreateDirectory(Path); }
    public NoteStore Open() { var s = new NoteStore(Paths); s.Initialize(); return s; }
    public void Dispose() { try { if (Path.Contains("nh4-test-")) Directory.Delete(Path, true); } catch { } }
}

public class NoteStoreTests
{
    [Fact]
    public void Reads_a_profile_written_by_3_0_5_unchanged()
    {
        using var t = new TempRoot();
        var p = t.Paths; p.Ensure();
        // exactly what the 3.0.x JavaScriptSerializer wrote (PascalCase, NaN literals, no unknown fields)
        File.WriteAllText(p.ProjectsPath, "[{\"Id\":\"inbox\",\"Name\":\"Входящие\",\"Order\":0,\"IsSystem\":true,\"ShowInTabs\":true},{\"Id\":\"abc\",\"Name\":\"Работа\",\"Order\":1,\"IsSystem\":false,\"ShowInTabs\":true}]", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(p.DataV3, "settings.json"), "{\"ActiveProjectId\":\"abc\",\"WindowLeft\":NaN,\"WindowTop\":NaN}", new UTF8Encoding(false));
        File.WriteAllText(p.MetaPath("n1"), "{\"Id\":\"n1\",\"Title\":\"Старая\",\"ProjectId\":\"abc\",\"SourcePath\":\"\",\"SourceType\":\"local\",\"ContentType\":\"text\",\"Tags\":\"\",\"CreatedUtc\":\"2026-10-01T10:00:00.0000000Z\",\"UpdatedUtc\":\"2026-10-02T10:00:00.0000000Z\",\"LastOpenedUtc\":\"\",\"SourceLastWriteUtc\":\"\",\"LegacySourceGuid\":\"\",\"IsPinned\":true,\"IsArchived\":false,\"IsDeleted\":false,\"ExternalOnly\":false}", new UTF8Encoding(false));
        File.WriteAllText(p.ContentPath("n1"), "первая строка\r\nвторая строка", new UTF8Encoding(false));

        using var s = t.Open();
        var list = s.Query("project", "abc", null);
        Assert.Single(list);
        Assert.True(list[0].IsPinned);
        var doc = s.Open("n1");
        Assert.Equal("первая строка\r\nвторая строка", doc.Content);
        Assert.Null(doc.BlocksJson); // no sidecar yet → UI builds blocks from the text
        Assert.Contains(s.Projects, x => x.Id == "import-windows"); // system folders are added when missing
    }

    [Fact]
    public void Save_keeps_blocks_while_text_is_untouched_and_drops_them_when_text_changes_elsewhere()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", "");
        s.SaveNote(n.Id, "# Заголовок\n\nТекст", "[{\"id\":\"1\",\"type\":\"heading\"}]");
        Assert.Equal("[{\"id\":\"1\",\"type\":\"heading\"}]", s.Open(n.Id).BlocksJson);

        // 3.0.5 (or the user) edits the .txt behind v4's back → the blocks must be considered stale
        File.WriteAllText(t.Paths.ContentPath(n.Id), "# Заголовок\n\nТекст, изменённый в 3.0.5", new UTF8Encoding(false));
        var after = s.Open(n.Id);
        Assert.Null(after.BlocksJson);
        Assert.Contains("изменённый в 3.0.5", after.Content);
    }

    [Fact]
    public void Save_rejects_non_array_blocks_and_oversized_text()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", "x");
        Assert.ThrowsAny<Exception>(() => s.SaveNote(n.Id, "x", "{\"not\":\"an array\"}"));
        Assert.ThrowsAny<InvalidOperationException>(() => s.SaveNote(n.Id, new string('я', NoteStore.EditorLimitChars + 1), null));
        Assert.Equal("x", s.Open(n.Id).Content); // the failed saves changed nothing
    }

    [Fact]
    public void Trash_restore_and_permanent_delete_follow_the_safe_order()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", "to remove");
        Assert.Throws<InvalidOperationException>(() => s.DeletePermanently(n.Id)); // must be trashed first
        s.SetFlags(n.Id, deleted: true);
        Assert.Empty(s.Query("project", "inbox", null));
        Assert.Single(s.Query("trash", null, null));
        s.SetFlags(n.Id, deleted: false);
        Assert.Single(s.Query("project", "inbox", null));
        s.SetFlags(n.Id, deleted: true);
        s.DeletePermanently(n.Id);
        Assert.False(File.Exists(t.Paths.ContentPath(n.Id)));
        Assert.False(File.Exists(t.Paths.MetaPath(n.Id)));
    }

    [Fact]
    public void Deleting_a_folder_moves_its_notes_to_inbox_and_never_destroys_them()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var p = s.CreateProject("Временная");
        var n = s.CreateNote(p.Id, "kept");
        Assert.Equal(1, s.DeleteProject(p.Id));
        Assert.Equal("inbox", s.FindMeta(n.Id)!.ProjectId);
        Assert.Throws<InvalidOperationException>(() => s.DeleteProject("inbox"));
    }

    [Fact]
    public void History_snapshots_previous_text_and_rejects_bad_names_and_ids()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", "версия 1");
        s.SaveNote(n.Id, "версия 2", null);
        var h = s.ListHistory(n.Id);
        Assert.Single(h);
        Assert.Equal("версия 1", s.ReadHistory(n.Id, h[0].Name));
        Assert.ThrowsAny<Exception>(() => s.ReadHistory(n.Id, "..\\..\\projects.json"));
        Assert.ThrowsAny<Exception>(() => s.Open("..\\..\\x"));
        Assert.Throws<ArgumentException>(() => DataPaths.SafeId("../evil"));
    }

    [Fact]
    public void Import_refuses_binary_files_and_keeps_huge_files_external()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var bin = Path.Combine(t.Path, "x.txt");
        File.WriteAllBytes(bin, Enumerable.Range(0, 4000).Select(i => (byte)(i % 7 == 0 ? 0 : 1)).ToArray());
        Assert.Throws<InvalidDataException>(() => s.ImportFile(bin, "inbox"));

        var big = Path.Combine(t.Path, "big.log");
        File.WriteAllText(big, new string('a', 1_100_000));
        var note = s.ImportFile(big, "inbox");
        Assert.True(s.IsExternalOnly(note));
        Assert.True(s.Open(note.Id).ExternalOnly);
        Assert.Throws<InvalidOperationException>(() => s.SaveNote(note.Id, "overwrite", null));
        Assert.Equal(1_100_000, new FileInfo(big).Length); // source file untouched

        var exe = Path.Combine(t.Path, "tool.exe");
        File.WriteAllText(exe, "MZ");
        Assert.Throws<InvalidDataException>(() => s.ImportFile(exe, "inbox"));
    }

    [Fact]
    public void Second_store_on_the_same_profile_is_refused()
    {
        using var t = new TempRoot();
        using var first = t.Open();
        var second = new NoteStore(t.Paths);
        Assert.Throws<StoreLockedException>(() => second.Initialize());
    }

    // ------------------------------------------------------------ Windows Notepad snapshot (synthetic binary tabs)

    private static void Uleb(Stream s, ulong v) { do { var b = (byte)(v & 0x7F); v >>= 7; if (v != 0) b |= 0x80; s.WriteByte(b); } while (v != 0); }

    private static byte[] Tab(string baseText, params (int cursor, int del, string add)[] edits)
    {
        using var ms = new MemoryStream();
        ms.WriteByte(0x4E); ms.WriteByte(0x50); Uleb(ms, 0); Uleb(ms, 0);
        ms.WriteByte(0); Uleb(ms, 0); Uleb(ms, 0); ms.Write(new byte[3]); Uleb(ms, 0);
        Uleb(ms, (ulong)baseText.Length); ms.Write(Encoding.Unicode.GetBytes(baseText)); ms.WriteByte(0); ms.Write(new byte[4]);
        foreach (var (cursor, del, add) in edits)
        { Uleb(ms, (ulong)cursor); Uleb(ms, (ulong)del); Uleb(ms, (ulong)add.Length); ms.Write(Encoding.Unicode.GetBytes(add)); ms.Write(new byte[4]); }
        return ms.ToArray();
    }

    private static string MakeSnapshot(string dir, string guid, byte[] tab, string entryPrefix = "TabState/")
    {
        var zip = Path.Combine(dir, "snap-" + Guid.NewGuid().ToString("N") + ".zip");
        using var z = ZipFile.Open(zip, ZipArchiveMode.Create);
        var e = z.CreateEntry(entryPrefix + guid + ".bin"); using (var w = e.Open()) w.Write(tab);
        var side = z.CreateEntry(entryPrefix + guid + ".0.bin"); using (var w = side.Open()) w.Write(new byte[] { 1, 2, 3 });
        return zip;
    }

    [Fact]
    public void Windows_notepad_snapshot_imports_applies_edits_and_is_idempotent()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var guid = Guid.NewGuid().ToString();
        var zip = MakeSnapshot(t.Path, guid, Tab("Привет мир", (7, 3, "всем")));
        var r1 = LegacyNotepadImporter.ImportZip(s, zip);
        Assert.Equal(1, r1.Created);
        var notes = s.Query("import", null, null);
        Assert.Single(notes);
        Assert.Equal("Привет всем", s.Open(notes[0].Id).Content);

        var r2 = LegacyNotepadImporter.ImportZip(s, zip); // same snapshot again → no duplicates
        Assert.Equal(0, r2.Created);
        Assert.Single(s.Query("import", null, null));
    }

    [Fact]
    public void Windows_notepad_snapshot_with_a_corrupt_tab_skips_it_and_reports()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var zip = MakeSnapshot(t.Path, Guid.NewGuid().ToString(), new byte[] { 9, 9, 9 });
        var r = LegacyNotepadImporter.ImportZip(s, zip);
        Assert.Equal(0, r.Created);
        Assert.Equal(1, r.Skipped);
        Assert.NotEmpty(r.Warnings);
    }

    [Fact]
    public void Snapshot_without_tabstate_is_rejected()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var zip = Path.Combine(t.Path, "empty.zip");
        using (var z = ZipFile.Open(zip, ZipArchiveMode.Create)) { var e = z.CreateEntry("readme.txt"); using var w = new StreamWriter(e.Open()); w.Write("x"); }
        Assert.Throws<InvalidDataException>(() => LegacyNotepadImporter.ImportZip(s, zip));
    }

    [Fact]
    public void Referenced_files_are_read_only_on_explicit_request()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var ext = Path.Combine(t.Path, "outside.txt");
        File.WriteAllText(ext, "текст внешнего файла");
        var meta = s.ImportFile(ext, "inbox");
        // simulate an imported-but-empty tab pointing at that file
        File.WriteAllText(t.Paths.ContentPath(meta.Id), "");
        Assert.Equal(1, s.ResolveReferencedFiles(new[] { meta.Id }));
        Assert.Equal("текст внешнего файла", s.Open(meta.Id).Content);
        Assert.Equal(0, s.ResolveReferencedFiles(new[] { meta.Id })); // never overwrites a note that has content
    }

    // ------------------------------------------------------------ opt-in: a COPY of the real profile (counts only, never prints content)

    [Fact]
    public void Real_profile_copy_loads_and_every_note_opens()
    {
        var zip = Environment.GetEnvironmentVariable("NOTEPADHUB_TEST_PROFILE_ZIP");
        if (string.IsNullOrWhiteSpace(zip) || !File.Exists(zip)) return; // opt-in only
        using var t = new TempRoot();
        ZipFile.ExtractToDirectory(zip, t.Path); // zip contains data-v3\...
        using var s = t.Open();
        var all = s.AllNotes();
        Assert.True(all.Count > 0);
        foreach (var n in all) { var d = s.Open(n.Id); Assert.NotNull(d.Meta); }
        Assert.Equal(all.Count, s.Counts()["all"] + s.Counts()["archive"] + s.Counts()["trash"]);
    }
}

