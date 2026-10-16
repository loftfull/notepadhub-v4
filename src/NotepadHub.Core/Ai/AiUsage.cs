using System.Text.Json;

namespace NotepadHub.Core.Ai;

/// <summary>What the cloud AI has been asked for recently: call times (last 24 h) and the money reserved this month.</summary>
public sealed class AiUsageData
{
    public List<DateTime> CloudCalls { get; set; } = new();
    public string Month { get; set; } = "";
    public double SpentUsd { get; set; }
}

public interface IAiUsageStore
{
    AiUsageData Load();
    void Save(AiUsageData data);
}

/// <summary>Keeps nothing between runs (tests, or when no data folder is available).</summary>
public sealed class MemoryAiUsageStore : IAiUsageStore
{
    private AiUsageData _data = new();
    public AiUsageData Load() => _data;
    public void Save(AiUsageData data) => _data = data;
}

/// <summary>
/// ai-usage.json next to the profile. A restart no longer resets the daily limit or the monthly budget.
/// This is a safety net against accidents (runaway loops, forgotten paid model), not a security boundary:
/// a missing or damaged file starts a fresh count, and the damaged file is kept as .bad for inspection.
/// </summary>
public sealed class FileAiUsageStore : IAiUsageStore
{
    private readonly string _path;
    private readonly Action<string> _log;
    public FileAiUsageStore(string dataRoot, Action<string>? log = null) { _path = Path.Combine(dataRoot, "ai-usage.json"); _log = log ?? (_ => { }); }

    public AiUsageData Load()
    {
        try
        {
            if (!File.Exists(_path)) return new AiUsageData();
            return JsonSerializer.Deserialize<AiUsageData>(File.ReadAllText(_path)) ?? new AiUsageData();
        }
        catch (Exception ex)
        {
            _log("ai usage file unreadable, starting a new count: " + ex.GetType().Name);
            try { File.Copy(_path, _path + ".bad", true); } catch { /* best effort */ }
            return new AiUsageData();
        }
    }

    public void Save(AiUsageData data)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var tmp = _path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(data));
            File.Move(tmp, _path, true);
        }
        catch (Exception ex) { _log("ai usage file not saved: " + ex.GetType().Name); }
    }
}
