using System.Diagnostics;
using System.Text;
using System.Text.Json;
using NotepadHub.Core.Bridge;

namespace NotepadHub.Core.Tests;

/// <summary>Start-up cost on a large synthetic library. Budgets are generous: they catch a 10x regression, not noise.</summary>
public class ScaleTests
{
    private sealed class NoUi : IHostUi
    {
        public string? PickWindowsSnapshot() => null;
        public IReadOnlyList<string> PickTextFiles() => Array.Empty<string>();
        public string? PickBackupSavePath(string suggestedName) => null;
        public string? PickBackupOpenPath() => null;
        public bool ConfirmRestore(NotepadHub.Core.Backup.BackupInfo backup, int currentNotes) => false;
    }

    [Fact]
    public async Task A_library_of_3000_notes_opens_and_bootstraps_within_budget()
    {
        using var t = new TempRoot();
        var p = t.Paths; p.Ensure();
        var body = string.Join("\n", Enumerable.Range(0, 40).Select(i => "Строка заметки номер " + i + " с обычным текстом для проверки скорости чтения."));
        using (var seed = t.Open())
            for (var i = 0; i < 3000; i++) seed.Upsert(new NoteStore.UpsertRequest { Id = "n" + i.ToString("D5"), Title = "Заметка " + i, Content = body + "\nуникальное-слово-" + i });

        var sw = Stopwatch.StartNew();
        using var s = t.Open();
        var open = sw.ElapsedMilliseconds;
        sw.Restart();
        var d = new BridgeDispatcher(s, new NoUi(), "test");
        var r = await d.HandleAsync("bootstrap", default);
        var boot = sw.ElapsedMilliseconds;
        var json = JsonSerializer.Serialize(r, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Console.WriteLine($"scale: open={open} ms, bootstrap={boot} ms, payload={json.Length / 1024 / 1024.0:F1} MiB");
        Assert.True(open < 8000, $"opening took {open} ms");
        Assert.True(boot < 15000, $"bootstrap took {boot} ms");
        Assert.True(json.Length < 64 * 1024 * 1024, "bootstrap payload is too large for one bridge message");
    }
}
