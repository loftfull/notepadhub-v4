namespace NotepadHub.Core;

/// <summary>
/// Layout of the on-disk profile. The folder structure is the same one Notepad Hub 3.0.x uses
/// (<c>data-v3</c>), so both generations can read the same notes. v4 only ADDS the
/// <c>notes-blocks</c> folder and <c>settings-v4.json</c>; it never changes files it does not own.
/// </summary>
public sealed class DataPaths
{
    public string Root { get; }
    public string DataV3 { get; }
    public string NotesMeta { get; }
    public string NotesContent { get; }
    public string NotesBlocks { get; }
    /// <summary>Pictures pasted or dropped into notes: content-addressed files (sha256 prefix + extension), shared between notes.</summary>
    public string NotesAssets { get; }
    public string History { get; }
    public string Cache { get; }
    public string Backups { get; }
    public string LogDir { get; }
    public string ProjectsPath { get; }
    public string SettingsV4Path { get; }
    public string WriterLockPath { get; }

    public DataPaths(string root)
    {
        Root = Path.GetFullPath(root);
        DataV3 = Path.Combine(Root, "data-v3");
        NotesMeta = Path.Combine(DataV3, "notes-meta");
        NotesContent = Path.Combine(DataV3, "notes-content");
        NotesBlocks = Path.Combine(DataV3, "notes-blocks");
        NotesAssets = Path.Combine(DataV3, "notes-assets");
        History = Path.Combine(DataV3, "history");
        Cache = Path.Combine(Root, "cache-v3");
        Backups = Path.Combine(Root, "backups-v3");
        LogDir = Path.Combine(Root, "logs");
        ProjectsPath = Path.Combine(DataV3, "projects.json");
        SettingsV4Path = Path.Combine(DataV3, "settings-v4.json");
        WriterLockPath = Path.Combine(Root, "writer-v4.lock");
    }

    /// <summary>Default profile: <c>%LOCALAPPDATA%\NotepadHub</c>, overridable with NOTEPADHUB_DATA_ROOT (used by tests and dev builds).</summary>
    public static DataPaths Resolve()
    {
        var over = Environment.GetEnvironmentVariable("NOTEPADHUB_DATA_ROOT");
        if (!string.IsNullOrWhiteSpace(over)) return new DataPaths(over);
        return new DataPaths(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NotepadHub"));
    }

    public void Ensure()
    {
        foreach (var d in new[] { Root, DataV3, NotesMeta, NotesContent, NotesBlocks, NotesAssets, History, Cache, Backups, LogDir })
            Directory.CreateDirectory(d);
    }

    public string MetaPath(string id) => Path.Combine(NotesMeta, SafeId(id) + ".json");
    public string ContentPath(string id) => Path.Combine(NotesContent, SafeId(id) + ".txt");
    public string BlocksPath(string id) => Path.Combine(NotesBlocks, SafeId(id) + ".json");
    public string HistoryDir(string id) => Path.Combine(History, SafeId(id));

    /// <summary>Note ids become file names, so anything but hex/dash/underscore is rejected (blocks path traversal from the page).</summary>
    public static string SafeId(string id)
    {
        if (string.IsNullOrWhiteSpace(id) || id.Length > 64 || !id.All(c => char.IsAsciiLetterOrDigit(c) || c == '-' || c == '_'))
            throw new ArgumentException("Недопустимый идентификатор заметки.", nameof(id));
        return id;
    }
}
