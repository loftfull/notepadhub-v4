using System.Text;

namespace NotepadHub.Core.Tests;

public class SourceFileTests
{
    private static (TempRoot t, NoteStore s, string file, NoteMeta note) Open(byte[] bytes, string name = "doc.txt")
    {
        var t = new TempRoot(); var s = t.Open();
        var dir = Path.Combine(t.Path, "external"); Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, name); File.WriteAllBytes(file, bytes);
        return (t, s, file, s.ImportFile(file, "inbox"));
    }

    [Fact]
    public void Saving_keeps_BOM_and_CRLF_and_leaves_no_temp_file_behind()
    {
        var original = new UTF8Encoding(true).GetPreamble().Concat(Encoding.UTF8.GetBytes("строка 1\r\nстрока 2")).ToArray();
        var (t, s, file, note) = Open(original);
        using var _t = t; using var _s = s;
        s.SaveNote(note.Id, "строка 1\nстрока 2 изменена", null);
        s.SaveToSource(note.Id);
        var after = File.ReadAllBytes(file);
        Assert.Equal(new byte[] { 0xEF, 0xBB, 0xBF }, after.Take(3).ToArray());
        Assert.Equal("строка 1\r\nстрока 2 изменена", Encoding.UTF8.GetString(after, 3, after.Length - 3));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(file)!, "*.tmp"));
    }

    [Fact]
    public void Refuses_to_overwrite_a_file_that_changed_outside_unless_forced_and_keeps_the_other_edit()
    {
        var (t, s, file, note) = Open(Encoding.UTF8.GetBytes("исходный текст"));
        using var _t = t; using var _s = s;
        s.SaveNote(note.Id, "моя правка", null);
        File.WriteAllText(file, "правка в другой программе");
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddMinutes(5));
        Assert.Throws<SourceChangedException>(() => s.SaveToSource(note.Id));
        Assert.Equal("правка в другой программе", File.ReadAllText(file));
        s.SaveToSource(note.Id, overwriteExternalChange: true);
        Assert.Equal("моя правка", File.ReadAllText(file));
        Assert.NotEmpty(Directory.GetFiles(t.Paths.Backups, "source_*"));   // the other edit was kept as a backup copy
    }

    [Fact]
    public void A_failing_write_leaves_the_original_file_untouched()
    {
        var (t, s, file, note) = Open(Encoding.UTF8.GetBytes("не трогать"));
        using var _t = t; using var _s = s;
        s.SaveNote(note.Id, "новый текст", null);
        using (new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.None))
            Assert.ThrowsAny<IOException>(() => s.SaveToSource(note.Id));
        Assert.Equal("не трогать", File.ReadAllText(file));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(file)!, "*.tmp"));
    }

    private static (TempRoot t, NoteStore s, string file, NoteMeta note, List<string> events) OpenInPlace(string text)
    {
        var t = new TempRoot(); var s = t.Open();
        var dir = Path.Combine(t.Path, "external"); Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, "live.txt"); File.WriteAllText(file, text, new UTF8Encoding(false));
        var events = new List<string>();
        s.SourceStatus += (_, status, _) => events.Add(status);
        return (t, s, file, s.OpenInPlace(file, "inbox"), events);
    }

    [Fact]
    public void Open_in_place_writes_edits_into_the_file_without_a_copy_per_save()
    {
        var (t, s, file, note, events) = OpenInPlace("v1");
        using var _t = t; using var _s = s;
        Assert.True(s.IsWriteThrough(note.Id));
        for (var i = 2; i <= 4; i++)
        {
            s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "v" + i });
            Assert.Equal("v" + i, File.ReadAllText(file));
        }
        Assert.Equal(new[] { "saved", "saved", "saved" }, events);
        Assert.Single(Directory.GetFiles(t.Paths.Backups, "source_*"));      // only the original, not one per save
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "v4", Pinned = true });   // metadata only: the file is not rewritten
        Assert.Equal(3, events.Count);
    }

    [Fact]
    public void An_outside_edit_stops_write_through_until_the_user_chooses()
    {
        var (t, s, file, note, events) = OpenInPlace("исходник");
        using var _t = t; using var _s = s;
        File.WriteAllText(file, "чужая правка");
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddMinutes(3));
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "моя версия" });
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "моя версия 2" });
        Assert.Equal(new[] { "conflict" }, events);                          // reported once, file untouched
        Assert.Equal("чужая правка", File.ReadAllText(file));

        s.ResolveSourceConflict(note.Id, "disk");
        Assert.Equal("чужая правка", s.Open(note.Id).Content);
        Assert.NotEmpty(s.ListHistory(note.Id));                             // the note's own text went to history
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "после выбора" });
        Assert.Equal("после выбора", File.ReadAllText(file));
    }

    [Fact]
    public void Choosing_mine_overwrites_the_file_and_keeps_the_other_version_in_backups()
    {
        var (t, s, file, note, _) = OpenInPlace("a");
        using var _t = t; using var _s = s;
        File.WriteAllText(file, "внешняя");
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddMinutes(3));
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "моя" });
        s.ResolveSourceConflict(note.Id, "mine");
        Assert.Equal("моя", File.ReadAllText(file));
        Assert.Contains(Directory.GetFiles(t.Paths.Backups, "source_*"), f => File.ReadAllText(f) == "внешняя");
    }

    [Fact]
    public void Turning_write_through_off_stops_writing_and_notes_without_a_file_cannot_enable_it()
    {
        var (t, s, file, note, _) = OpenInPlace("a");
        using var _t = t; using var _s = s;
        s.SetWriteThrough(note.Id, false);
        s.Upsert(new NoteStore.UpsertRequest { Id = note.Id, Content = "только в библиотеке" });
        Assert.Equal("a", File.ReadAllText(file));
        var local = s.CreateNote("inbox", "x");
        Assert.Throws<InvalidOperationException>(() => s.SetWriteThrough(local.Id, true));
    }
}
