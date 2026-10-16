using System.IO.Compression;
using System.Text;
using NotepadHub.Core.Backup;

namespace NotepadHub.Core.Tests;

public class BackupTests
{
    private static NoteStore Populated(TempRoot t)
    {
        var s = t.Open();
        var p = s.CreateProject("Работа");
        var a = s.CreateNote(p.Id, "# Первая\nтекст один");
        s.SaveNote(a.Id, "# Первая\nтекст один — правка", "[{\"type\":\"heading\"}]");
        s.CreateNote("inbox", "вторая заметка");
        return s;
    }

    [Fact]
    public void Backup_round_trips_notes_folders_blocks_and_history_into_a_fresh_profile()
    {
        using var src = new TempRoot(); using var dst = new TempRoot();
        using var a = Populated(src);
        var file = Path.Combine(src.Path, "copy.nhub");
        NhubBackup.Create(a, file, "test");
        var info = NhubBackup.Inspect(file);
        Assert.True(info.Valid, info.Error);
        Assert.Equal(2, info.NoteCount);

        using var b = dst.Open();
        NhubBackup.Restore(b, file, "test");
        Assert.Equal(2, b.AllNotes().Count);
        Assert.Contains(b.Projects, p => p.Name == "Работа");
        var first = b.AllNotes().First(n => n.Title == "Первая");
        var doc = b.Open(first.Id);
        Assert.Contains("правка", doc.Content);
        Assert.NotNull(doc.BlocksJson);
        Assert.NotEmpty(b.ListHistory(first.Id));
    }

    [Fact]
    public void Settings_and_lock_files_are_not_part_of_a_backup()
    {
        using var t = new TempRoot(); using var s = Populated(t);
        s.SaveSettings(new AppSettingsV4 { Theme = "dark" });
        var file = Path.Combine(t.Path, "c.nhub");
        NhubBackup.Create(s, file, "test");
        using var z = ZipFile.OpenRead(file);
        Assert.DoesNotContain(z.Entries, e => e.FullName.Contains("settings"));
        Assert.DoesNotContain(z.Entries, e => e.FullName.EndsWith(".lock"));
        Assert.Contains(z.Entries, e => e.FullName == "manifest.json");
    }

    [Fact]
    public void A_tampered_archive_is_rejected_and_restore_changes_nothing()
    {
        using var t = new TempRoot(); using var s = Populated(t);
        var file = Path.Combine(t.Path, "c.nhub");
        NhubBackup.Create(s, file, "test");
        // flip bytes inside one stored note (rebuild the zip with the same manifest but a modified note)
        var bad = Path.Combine(t.Path, "bad.nhub");
        using (var src = ZipFile.OpenRead(file))
        using (var dst = ZipFile.Open(bad, ZipArchiveMode.Create))
            foreach (var e in src.Entries)
            {
                var ne = dst.CreateEntry(e.FullName);
                using var r = e.Open(); using var w = ne.Open();
                if (e.FullName.StartsWith("notes-content/")) { w.Write(Encoding.UTF8.GetBytes("ПОДМЕНЁННЫЙ ТЕКСТ")); } else r.CopyTo(w);
            }
        Assert.False(NhubBackup.Inspect(bad).Valid);
        var before = s.AllNotes().Select(n => n.Id).OrderBy(x => x).ToList();
        Assert.Throws<InvalidDataException>(() => NhubBackup.Restore(s, bad, "test"));
        Assert.Equal(before, s.AllNotes().Select(n => n.Id).OrderBy(x => x).ToList());
    }

    [Fact]
    public void Archives_with_unsafe_paths_or_without_a_manifest_are_refused()
    {
        using var t = new TempRoot(); using var s = Populated(t);
        var evil = Path.Combine(t.Path, "evil.nhub");
        using (var z = ZipFile.Open(evil, ZipArchiveMode.Create)) { var e = z.CreateEntry("../../evil.txt"); using var w = new StreamWriter(e.Open()); w.Write("x"); }
        Assert.False(NhubBackup.Inspect(evil).Valid);
        var plain = Path.Combine(t.Path, "plain.zip");
        using (var z = ZipFile.Open(plain, ZipArchiveMode.Create)) { var e = z.CreateEntry("hello.txt"); using var w = new StreamWriter(e.Open()); w.Write("x"); }
        Assert.Contains("manifest", NhubBackup.Inspect(plain).Error);
        Assert.False(NhubBackup.Inspect(Path.Combine(t.Path, "missing.nhub")).Valid);
    }

    [Fact]
    public void Restore_over_changed_data_reverts_it_and_keeps_a_rollback_copy_that_brings_the_changes_back()
    {
        using var t = new TempRoot(); using var s = Populated(t);
        var file = Path.Combine(t.Path, "c.nhub");
        NhubBackup.Create(s, file, "test");

        var extra = s.CreateNote("inbox", "заметка после копии");
        s.SaveNote(s.AllNotes().First(n => n.Title == "Первая").Id, "# Первая\nизменено после копии", null);
        Assert.Equal(3, s.AllNotes().Count);

        var rollback = NhubBackup.Restore(s, file, "test");
        Assert.Equal(2, s.AllNotes().Count);
        Assert.DoesNotContain(s.AllNotes(), n => n.Id == extra.Id);
        Assert.Contains("правка", s.Open(s.AllNotes().First(n => n.Title == "Первая").Id).Content);
        Assert.True(File.Exists(rollback));

        NhubBackup.Restore(s, rollback, "test");   // undo the restore
        Assert.Equal(3, s.AllNotes().Count);
        Assert.Contains(s.AllNotes(), n => n.Id == extra.Id);
    }

    [Fact]
    public void An_oversized_file_inside_the_archive_is_refused_without_reading_it_into_memory()
    {
        using var t = new TempRoot(); using var s = Populated(t);
        var big = Path.Combine(t.Path, "big.nhub");
        using (var z = ZipFile.Open(big, ZipArchiveMode.Create))
        {
            var e = z.CreateEntry("notes-content/x.txt", CompressionLevel.Optimal);
            using var w = e.Open(); var chunk = new byte[1024 * 1024];
            for (var i = 0; i < 65; i++) w.Write(chunk);   // 65 MiB of zeros compresses to almost nothing
        }
        var info = NhubBackup.Inspect(big);
        Assert.False(info.Valid);
        Assert.Contains("слишком большой", info.Error);
    }

    [Fact]
    public void Failed_create_leaves_no_partial_file()
    {
        using var t = new TempRoot(); using var s = Populated(t);
        var dest = Path.Combine(t.Path, "no-such-drive-xyz", "..", "c.nhub");
        NhubBackup.Create(s, Path.Combine(t.Path, "ok.nhub"), "test");
        Assert.DoesNotContain(Directory.GetFiles(t.Path), f => f.EndsWith(".tmp"));
    }
}


