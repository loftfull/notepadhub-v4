using NotepadHub.Core;
using Xunit;

namespace NotepadHub.Core.Tests;

public class NotePasswordTests
{
    private const string Secret = "очень личный текст про отпуск";

    [Fact]
    public void A_password_encrypts_text_blocks_and_history_and_nothing_readable_stays_on_disk()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", "первая версия");
        s.Upsert(new NoteStore.UpsertRequest { Id = n.Id, Content = Secret, BlocksJson = "[{\"type\":\"paragraph\",\"content\":\"" + Secret + "\"}]" });
        s.Checkpoint(n.Id);
        s.SetPassword(n.Id, "лето2026");
        foreach (var file in new[] { t.Paths.ContentPath(n.Id), t.Paths.BlocksPath(n.Id) }.Concat(Directory.GetFiles(t.Paths.HistoryDir(n.Id))))
        {
            var text = File.ReadAllText(file);
            Assert.StartsWith("NHENC1:", text);
            Assert.DoesNotContain("отпуск", text);
            Assert.DoesNotContain("версия", text);
        }
        Assert.True(s.FindMeta(n.Id)!.IsProtected);
    }

    [Fact]
    public void A_locked_note_gives_no_text_until_the_right_password_and_a_wrong_one_is_refused()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", Secret);
        s.SetPassword(n.Id, "лето2026");
        s.RelockNotes();
        var locked = s.Open(n.Id, markOpened: false);
        Assert.True(locked.Locked);
        Assert.Equal("", locked.Content);
        Assert.Throws<WrongPasswordException>(() => s.UnlockNote(n.Id, "не тот"));
        Assert.True(s.Open(n.Id, markOpened: false).Locked);
        s.UnlockNote(n.Id, "лето2026");
        var open = s.Open(n.Id, markOpened: false);
        Assert.False(open.Locked);
        Assert.Equal(Secret, open.Content);
    }

    [Fact]
    public void Saving_a_locked_note_is_refused_and_an_unlocked_one_stays_encrypted_on_disk()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", "до");
        s.SetPassword(n.Id, "лето2026");
        s.RelockNotes();
        Assert.Throws<NoteLockedException>(() => s.Upsert(new NoteStore.UpsertRequest { Id = n.Id, Content = "подмена" }));
        s.UnlockNote(n.Id, "лето2026");
        s.Upsert(new NoteStore.UpsertRequest { Id = n.Id, Content = Secret });
        Assert.DoesNotContain("отпуск", File.ReadAllText(t.Paths.ContentPath(n.Id)));
        s.RelockNotes(n.Id);
        s.UnlockNote(n.Id, "лето2026");
        Assert.Equal(Secret, s.Open(n.Id, markOpened: false).Content);
    }

    [Fact]
    public void The_text_of_a_protected_note_is_not_in_the_search_and_the_history_shows_no_preview()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", Secret, "Личное");
        s.Checkpoint(n.Id);
        s.SetPassword(n.Id, "лето2026");
        Assert.DoesNotContain(s.Query("all", null, "отпуск"), m => m.Id == n.Id);
        Assert.All(s.ListHistory(n.Id), h => Assert.DoesNotContain("отпуск", h.Preview));
        s.RelockNotes();
        Assert.Throws<NoteLockedException>(() => s.ReadHistory(n.Id, s.ListHistory(n.Id)[0].Name));
    }

    [Fact]
    public void Removing_the_password_makes_the_files_plain_again_and_a_copy_of_a_protected_note_is_refused()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", Secret);
        s.Checkpoint(n.Id);
        s.SetPassword(n.Id, "лето2026");
        Assert.Throws<InvalidOperationException>(() => s.Duplicate(n.Id));
        s.RelockNotes();
        Assert.Throws<WrongPasswordException>(() => s.RemovePassword(n.Id, "нет"));
        s.RemovePassword(n.Id, "лето2026");
        Assert.False(s.FindMeta(n.Id)!.IsProtected);
        Assert.Contains("отпуск", File.ReadAllText(t.Paths.ContentPath(n.Id)));
        Assert.Contains("отпуск", File.ReadAllText(Directory.GetFiles(t.Paths.HistoryDir(n.Id))[0]));
        Assert.Equal(Secret, s.Open(n.Id, markOpened: false).Content);
    }

    [Fact]
    public void Short_passwords_and_repeated_protection_are_refused_and_the_state_survives_a_restart()
    {
        using var t = new TempRoot();
        string id;
        using (var s = t.Open())
        {
            var n = s.CreateNote("inbox", Secret);
            id = n.Id;
            Assert.Throws<ArgumentException>(() => s.SetPassword(id, "123"));
            s.SetPassword(id, "лето2026");
            Assert.Throws<InvalidOperationException>(() => s.SetPassword(id, "другой"));
        }
        using (var again = t.Open())
        {
            Assert.True(again.Open(id, markOpened: false).Locked);
            again.UnlockNote(id, "лето2026");
            Assert.Equal(Secret, again.Open(id, markOpened: false).Content);
        }
    }

    [Fact]
    public void Reloading_the_files_forgets_every_key_so_a_restored_copy_is_asked_for_its_own_password()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", Secret, "Личное");
        s.SetPassword(n.Id, "лето2026");
        Assert.True(s.IsUnlocked(n.Id));
        s.ReloadFromDisk();
        Assert.False(s.IsUnlocked(n.Id));
        Assert.True(s.Open(n.Id, markOpened: false).Locked);
        s.UnlockNote(n.Id, "лето2026");
        Assert.Equal(Secret, s.Open(n.Id, markOpened: false).Content);
    }

    [Fact]
    public void A_changed_cipher_text_is_refused_and_never_returned_as_text()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", Secret, "Личное");
        s.SetPassword(n.Id, "лето2026");
        var path = t.Paths.ContentPath(n.Id);
        var text = File.ReadAllText(path);
        var broken = text[..^6] + (text[^6] == 'A' ? "B" : "A") + text[^5..];
        File.WriteAllText(path, broken);
        Assert.Throws<InvalidDataException>(() => s.Open(n.Id, markOpened: false));
    }

    [Fact]
    public void A_protected_note_with_the_default_title_does_not_take_its_title_from_the_text()
    {
        using var t = new TempRoot();
        using var s = t.Open();
        var n = s.CreateNote("inbox", "", "Новая заметка");
        s.SetPassword(n.Id, "лето2026");
        s.Upsert(new NoteStore.UpsertRequest { Id = n.Id, Content = Secret });
        Assert.Equal("Новая заметка", s.FindMeta(n.Id)!.Title);
        Assert.DoesNotContain("отпуск", File.ReadAllText(t.Paths.MetaPath(n.Id)));
    }
}
