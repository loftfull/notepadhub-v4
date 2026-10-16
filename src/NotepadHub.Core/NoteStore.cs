using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace NotepadHub.Core;

/// <summary>
/// File-per-note store compatible with Notepad Hub 3.0.x (<c>data-v3</c>).
/// Authoritative text of a note is <c>notes-content\&lt;id&gt;.txt</c> (a Markdown mirror).
/// v4 additionally keeps <c>notes-blocks\&lt;id&gt;.json</c>: the editor blocks plus the SHA-256 of the text they were
/// derived from. If the .txt no longer matches that hash (for example 3.0.5 edited it), the blocks are treated as
/// stale and the UI rebuilds them from the text, so the two generations can never silently fork a note.
/// </summary>
public sealed partial class NoteStore : IDisposable
{
    public const long InlineFileLimitBytes = 1024L * 1024L;
    public const int EditorLimitChars = 262144;
    private const int SearchSampleChars = 64 * 1024;
    private const int HistoryKeep = 50;
    private static readonly TimeSpan HistoryInterval = TimeSpan.FromMinutes(2);

    private static readonly HashSet<string> TextExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".txt", ".md", ".markdown", ".html", ".htm", ".json", ".xml", ".yaml", ".yml", ".log", ".csv",
        ".ps1", ".psm1", ".cmd", ".bat", ".js", ".ts", ".tsx", ".jsx", ".py", ".cs", ".css", ".sql", ".ini", ".toml",
    };

    private readonly object _sync = new();
    private readonly List<NoteMeta> _notes = new();
    private readonly List<ProjectModel> _projects = new();
    private readonly Dictionary<string, string> _search = new(StringComparer.OrdinalIgnoreCase);
    private FileStream? _writerLock;
    private CancellationTokenSource? _indexCts;

    public DataPaths Paths { get; }
    public AppSettingsV4 Settings { get; private set; } = new();

    public NoteStore(DataPaths paths) { Paths = paths; }

    // ---------------------------------------------------------------- lifecycle

    public void Initialize()
    {
        Paths.Ensure();
        AcquireWriterLock();
        LoadSettings();
        LoadProjects();
        LoadNotes();
        if (EnsureSystemProjects()) SaveProjects();
        lock (_sync)
            foreach (var n in _notes) _search[n.Id] = IndexKey(n, "");
        SanitizeWriteThrough();
        _indexCts = new CancellationTokenSource();
        var token = _indexCts.Token;
        Task.Run(() => BuildSearchIndex(token), token);
    }

    private void AcquireWriterLock()
    {
        try
        {
            _writerLock = new FileStream(Paths.WriterLockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException)
        {
            throw new StoreLockedException("Эти данные уже открыты другим окном Notepad Hub 4.");
        }
    }

    public void Dispose()
    {
        try { _indexCts?.Cancel(); } catch { }
        _writerLock?.Dispose();
        _writerLock = null;
    }

    // ---------------------------------------------------------------- backup support

    /// <summary>Runs <paramref name="action"/> while no other thread can change notes, so a backup sees one consistent state.</summary>
    public T WithExclusiveAccess<T>(Func<T> action) { lock (_sync) return action(); }

    /// <summary>Re-reads folders and notes from disk after files were replaced (restore). Memory is rebuilt from what is on disk.</summary>
    public void ReloadFromDisk()
    {
        lock (_sync)
        {
            LoadProjects();
            LoadNotes();
            if (EnsureSystemProjects()) SaveProjects();
            _search.Clear();
            foreach (var n in _notes) _search[n.Id] = IndexKey(n, "");
            SanitizeWriteThrough();
        }
        _indexCts?.Cancel();
        _indexCts = new CancellationTokenSource();
        var token = _indexCts.Token;
        Task.Run(() => BuildSearchIndex(token), token);
    }
    // ---------------------------------------------------------------- settings

    private void LoadSettings()
    {
        try { Settings = JsonIO.Read<AppSettingsV4>(Paths.SettingsV4Path) ?? new AppSettingsV4(); }
        catch (Exception ex) { Log("settings load: " + ex.Message); Settings = new AppSettingsV4(); }
    }

    public void SaveSettings(AppSettingsV4 settings)
    {
        lock (_sync)
        {
            Settings = settings;
            try { JsonIO.WriteAtomic(Paths.SettingsV4Path, settings); }
            catch (Exception ex) { Log("settings save: " + ex.Message); }
        }
    }

    // ---------------------------------------------------------------- projects

    private void LoadProjects()
    {
        lock (_sync) _projects.Clear();
        var path = Paths.ProjectsPath;
        if (!File.Exists(path)) return;
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                var list = JsonIO.Read<List<ProjectModel>>(path);
                if (list != null) lock (_sync) _projects.AddRange(list);
                return;
            }
            catch (JsonException ex)
            {
                // damaged file: keep a copy before it is rewritten with the system folders, and say so in the log
                Log("projects.json is damaged (" + ex.Message + "); copy kept");
                try { File.Copy(path, path + ".corrupt-" + DateTime.Now.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture), true); } catch { }
                return;
            }
            catch (IOException) when (attempt < 4) { Thread.Sleep(150); }   // busy (3.0.x, antivirus): wait, never treat as empty
        }
    }

    private bool EnsureSystemProjects()
    {
        var changed = false;
        lock (_sync)
        {
            if (_projects.All(p => p.Id != "inbox")) { _projects.Add(new ProjectModel { Id = "inbox", Name = "Входящие", Order = 0, IsSystem = true, ShowInTabs = true }); changed = true; }
            if (_projects.All(p => p.Id != "import-windows")) { _projects.Add(new ProjectModel { Id = "import-windows", Name = "Импорт Windows", Order = 9999, IsSystem = true, ShowInTabs = false }); changed = true; }
            if (!_projects.Any(p => p.Id == Settings.ActiveProjectId && p.ShowInTabs)) Settings.ActiveProjectId = "inbox";
        }
        return changed;
    }

    private void SaveProjects()
    {
        lock (_sync) JsonIO.WriteAtomic(Paths.ProjectsPath, _projects.OrderBy(p => p.Order).ToList());
    }

    public IReadOnlyList<ProjectModel> Projects { get { lock (_sync) return _projects.OrderBy(p => p.Order).Select(p => new ProjectModel { Id = p.Id, Name = p.Name, Order = p.Order, IsSystem = p.IsSystem, ShowInTabs = p.ShowInTabs, ParentId = p.ParentId }).ToList(); } }

    public ProjectModel CreateProject(string name, string parentId = "")
    {
        name = (name ?? "").Trim();
        if (name.Length == 0) throw new ArgumentException("Название папки пустое.");
        if (name.Length > 80) name = name[..80];
        lock (_sync)
        {
            var existing = _projects.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.CurrentCultureIgnoreCase));
            if (existing != null) return existing;
            parentId = _projects.Any(p => p.Id == parentId && !p.IsSystem) ? parentId : "";
            var order = _projects.Where(p => p.ShowInTabs).Select(p => p.Order).DefaultIfEmpty(0).Max() + 1;
            var project = new ProjectModel { Id = Guid.NewGuid().ToString("N"), Name = name, Order = order, IsSystem = false, ShowInTabs = true, ParentId = parentId };
            _projects.Add(project);
            SaveProjects();
            return project;
        }
    }

    /// <summary>Nests a project in another one (empty parent = top level). A project cannot go inside itself or its own descendants; system projects stay on top.</summary>
    public void MoveProject(string id, string parentId)
    {
        parentId ??= "";
        lock (_sync)
        {
            var p = _projects.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Проект не найден.");
            if (p.IsSystem) throw new InvalidOperationException("Системный проект нельзя переместить.");
            if (parentId.Length > 0)
            {
                var parent = _projects.FirstOrDefault(x => x.Id == parentId) ?? throw new KeyNotFoundException("Проект назначения не найден.");
                if (parent.IsSystem) throw new InvalidOperationException("Внутрь системного проекта вкладывать нельзя.");
                for (var cur = parent; cur != null; cur = _projects.FirstOrDefault(x => x.Id == cur.ParentId))
                    if (cur.Id == id) throw new InvalidOperationException("Проект нельзя вложить в самого себя или в свой вложенный проект.");
            }
            p.ParentId = parentId;
            SaveProjects();
        }
    }

    public void RenameProject(string id, string name)
    {
        name = (name ?? "").Trim();
        if (name.Length == 0) throw new ArgumentException("Название папки пустое.");
        lock (_sync)
        {
            var p = _projects.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Папка не найдена.");
            if (p.IsSystem) throw new InvalidOperationException("Системную папку нельзя переименовать.");
            p.Name = name.Length > 80 ? name[..80] : name;
            SaveProjects();
        }
    }

    /// <summary>Deletes a user folder. Its notes are moved to «Входящие» — a folder never destroys notes.</summary>
    public int DeleteProject(string id)
    {
        lock (_sync)
        {
            var p = _projects.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Папка не найдена.");
            if (p.IsSystem) throw new InvalidOperationException("Системную папку нельзя удалить.");
            var moved = 0;
            foreach (var n in _notes.Where(n => n.ProjectId == id).ToList()) { n.ProjectId = "inbox"; n.UpdatedUtc = Now(); SaveMeta(n); moved++; }
            foreach (var child in _projects.Where(c => c.ParentId == id)) child.ParentId = p.ParentId;
            _projects.Remove(p);
            SaveProjects();
            return moved;
        }
    }

    // ---------------------------------------------------------------- notes: load/list

    private void LoadNotes()
    {
        lock (_sync) _notes.Clear();
        foreach (var file in Directory.EnumerateFiles(Paths.NotesMeta, "*.json", SearchOption.TopDirectoryOnly))
        {
            try
            {
                var n = JsonIO.Read<NoteMeta>(file);
                if (n == null || string.IsNullOrWhiteSpace(n.Id)) continue;
                if (!string.Equals(n.Id, Path.GetFileNameWithoutExtension(file), StringComparison.Ordinal) || !IsSafeId(n.Id)) { Log("note meta skipped (id does not match file name): " + Path.GetFileName(file)); continue; }
                Normalize(n);
                lock (_sync) _notes.Add(n);
            }
            catch (Exception ex) { Log("note meta skipped " + Path.GetFileName(file) + ": " + ex.Message); }
        }
    }

    private static void Normalize(NoteMeta n)
    {
        if (string.IsNullOrWhiteSpace(n.Title)) n.Title = "Новая заметка";
        if (string.IsNullOrWhiteSpace(n.ProjectId)) n.ProjectId = "inbox";
        if (string.IsNullOrWhiteSpace(n.SourceType)) n.SourceType = "local";
        if (string.IsNullOrWhiteSpace(n.ContentType)) n.ContentType = DetectContentType(n.SourcePath, null);
        if (string.IsNullOrWhiteSpace(n.CreatedUtc)) n.CreatedUtc = Now();
        if (string.IsNullOrWhiteSpace(n.UpdatedUtc)) n.UpdatedUtc = n.CreatedUtc;
        n.SourcePath ??= ""; n.Tags ??= ""; n.LegacySourceGuid ??= ""; n.LastOpenedUtc ??= ""; n.SourceLastWriteUtc ??= "";
    }

    private static bool IsSafeId(string id) { try { DataPaths.SafeId(id); return true; } catch (ArgumentException) { return false; } }

    /// <summary>Only a path on a local fixed or removable drive qualifies: no UNC (\\server\share), no network drives, no device paths.</summary>
    internal static bool IsLocalDrivePath(string? path)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(path) || path.StartsWith(@"\\", StringComparison.Ordinal) || path.StartsWith("//", StringComparison.Ordinal)) return false;
            if (!Path.IsPathFullyQualified(path)) return false;
            var root = Path.GetPathRoot(path);
            if (string.IsNullOrEmpty(root) || root.Length < 3 || root[1] != ':') return false;
            var type = new DriveInfo(root).DriveType;
            return type is DriveType.Fixed or DriveType.Removable;
        }
        catch { return false; }
    }

    public IReadOnlyList<NoteMeta> AllNotes() { lock (_sync) return _notes.Select(n => n.Clone()).ToList(); }

    public NoteMeta? FindMeta(string id) { lock (_sync) return _notes.FirstOrDefault(n => n.Id == id)?.Clone(); }

    /// <summary>Views: project | all | pinned | recent | archive | trash | import.</summary>
    public IReadOnlyList<NoteMeta> Query(string view, string? projectId, string? text)
    {
        List<NoteMeta> all;
        lock (_sync) all = _notes.Select(n => n.Clone()).ToList();
        IEnumerable<NoteMeta> q = all;
        if (view == "trash") q = q.Where(n => n.IsDeleted);
        else
        {
            q = q.Where(n => !n.IsDeleted);
            q = view == "archive" ? q.Where(n => n.IsArchived) : q.Where(n => !n.IsArchived);
        }
        switch (view)
        {
            case "pinned": q = q.Where(n => n.IsPinned); break;
            case "import": q = q.Where(n => n.ProjectId == "import-windows"); break;
            case "recent": q = q.OrderByDescending(n => ParseUtc(n.LastOpenedUtc.Length > 0 ? n.LastOpenedUtc : n.UpdatedUtc)).Take(40); break;
            case "project": if (!string.IsNullOrWhiteSpace(projectId)) q = q.Where(n => n.ProjectId == projectId); break;
        }
        var s = (text ?? "").Trim().ToLowerInvariant();
        if (s.Length > 0)
        {
            q = q.Where(n =>
            {
                string? idx; lock (_sync) _search.TryGetValue(n.Id, out idx);
                if (string.IsNullOrEmpty(idx)) idx = IndexKey(n, "");
                return idx.Contains(s, StringComparison.Ordinal);
            });
        }
        if (view != "recent") q = q.OrderByDescending(n => n.IsPinned).ThenByDescending(n => ParseUtc(n.UpdatedUtc));
        return q.ToList();
    }

    public Dictionary<string, int> Counts()
    {
        lock (_sync)
        {
            var live = _notes.Where(n => !n.IsDeleted && !n.IsArchived).ToList();
            var d = new Dictionary<string, int>
            {
                ["all"] = live.Count,
                ["pinned"] = live.Count(n => n.IsPinned),
                ["archive"] = _notes.Count(n => !n.IsDeleted && n.IsArchived),
                ["trash"] = _notes.Count(n => n.IsDeleted),
                ["import"] = live.Count(n => n.ProjectId == "import-windows"),
            };
            foreach (var g in live.GroupBy(n => n.ProjectId)) d["p:" + g.Key] = g.Count();
            return d;
        }
    }

    // ---------------------------------------------------------------- notes: read/write

    public NoteDocument Open(string id, bool markOpened = true)
    {
        NoteMeta meta;
        lock (_sync) meta = (_notes.FirstOrDefault(n => n.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.")).Clone();
        var doc = new NoteDocument { Meta = meta };
        if (IsExternalOnly(meta)) { doc.ExternalOnly = true; return doc; }
        if (meta.IsProtected && !IsUnlocked(id)) { doc.Locked = true; return doc; }
        doc.Content = ReadContent(id);
        doc.BlocksJson = ReadValidBlocks(id, doc.Content);
        if (markOpened)
            lock (_sync)
            {
                var live = _notes.FirstOrDefault(n => n.Id == id);
                if (live != null) { live.LastOpenedUtc = Now(); SaveMeta(live); doc.Meta = live.Clone(); }
            }
        return doc;
    }

    public NoteMeta CreateNote(string? projectId, string? content = "", string? title = null)
    {
        content ??= "";
        EnsureWithinLimits(content);
        if (string.IsNullOrWhiteSpace(projectId)) projectId = "inbox";
        lock (_sync) if (_projects.All(p => p.Id != projectId)) projectId = "inbox";
        var n = new NoteMeta
        {
            Id = Guid.NewGuid().ToString("N"),
            ProjectId = projectId!,
            Title = !string.IsNullOrWhiteSpace(title) ? Truncate(title!.Trim(), 120) : AutoTitle(content),
            ContentType = DetectContentType(null, content),
        };
        WriteContent(n.Id, content);
        lock (_sync) { SaveMeta(n); _notes.Add(n); _search[n.Id] = IndexKey(n, content); }
        return n.Clone();
    }

    /// <summary>
    /// Saves a note. <paramref name="content"/> is the Markdown mirror produced by the editor;
    /// <paramref name="blocksJson"/> is the editor's native block array (may be null for plain-text callers).
    /// </summary>
    public NoteMeta SaveNote(string id, string content, string? blocksJson, string? title = null)
    {
        content ??= "";
        EnsureWithinLimits(content);
        NoteMeta n;
        lock (_sync) n = _notes.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.");
        if (IsExternalOnly(n)) throw new InvalidOperationException("Этот файл не загружен в редактор. Исходный файл не изменён.");

        var previous = ReadContent(id);
        if (!string.Equals(previous, content, StringComparison.Ordinal)) SnapshotHistory(id, previous, force: false);

        WriteContent(id, content);
        if (blocksJson != null) WriteBlocks(id, blocksJson, content); else DeleteBlocks(id);

        lock (_sync)
        {
            n.UpdatedUtc = Now();
            if (!string.IsNullOrWhiteSpace(title)) n.Title = Truncate(title!.Trim(), 120);
            else if (n.Title == "Новая заметка" || string.IsNullOrWhiteSpace(n.Title)) n.Title = AutoTitle(content);
            n.ContentType = DetectContentType(n.SourcePath, content);
            SaveMeta(n);
            _search[n.Id] = IndexKey(n, content);
            return n.Clone();
        }
    }

    // ---------------------------------------------------------------- bridge: idempotent upsert

    public sealed class UpsertRequest
    {
        public string Id { get; set; } = "";
        public string? ProjectId { get; set; }
        public string? Title { get; set; }
        public string? Tags { get; set; }
        public bool Pinned { get; set; }
        public bool Archived { get; set; }
        public bool Deleted { get; set; }
        /// <summary>Plain-text mirror. Null = metadata-only update (content untouched).</summary>
        public string? Content { get; set; }
        public string? BlocksJson { get; set; }
    }

    /// <summary>
    /// One call creates the note when the id is new and otherwise updates it. Safe to repeat, so the UI can retry after a failure
    /// without creating duplicates. A note is never removed here: deletion is a separate explicit call.
    /// </summary>
    public NoteMeta Upsert(UpsertRequest r)
    {
        var id = DataPaths.SafeId(r.Id);
        if (r.Content != null) EnsureWithinLimits(r.Content);
        NoteMeta result; var textChanged = false;
        lock (_sync)
        {
            var n = _notes.FirstOrDefault(x => x.Id == id);
            var created = n == null;
            if (created) n = new NoteMeta { Id = id };
            var projectId = string.IsNullOrWhiteSpace(r.ProjectId) || _projects.All(p => p.Id != r.ProjectId) ? (created ? "inbox" : n!.ProjectId) : r.ProjectId!;
            n!.ProjectId = projectId;
            if (!string.IsNullOrWhiteSpace(r.Title)) n.Title = Truncate(r.Title!.Trim(), 120);
            if (r.Tags != null) n.Tags = Truncate(r.Tags.Trim(), 200);
            n.IsPinned = r.Pinned; n.IsArchived = r.Archived; n.IsDeleted = r.Deleted;

            var content = n.ExternalOnly ? null : r.Content;
            if (content != null)
            {
                if (IsExternalOnly(n)) throw new InvalidOperationException("Этот файл не загружен в редактор. Исходный файл не изменён.");
                var previous = created ? "" : ReadContent(id);
                if (!created && !string.Equals(previous, content, StringComparison.Ordinal)) { SnapshotHistory(id, previous, force: false); textChanged = true; }
                WriteContent(id, content);
                if (r.BlocksJson != null) WriteBlocks(id, r.BlocksJson, content); else DeleteBlocks(id);
                n.ContentType = DetectContentType(n.SourcePath, content);
                if (string.IsNullOrWhiteSpace(r.Title) && (created || n.Title == "Новая заметка")) n.Title = AutoTitle(content);
            }
            else if (created) WriteContent(id, "");
            n.UpdatedUtc = Now();
            SaveMeta(n);
            if (created) _notes.Add(n);
            _search[n.Id] = IndexKey(n, content ?? (created ? "" : ReadContentSafe(n)));
            result = n.Clone();
        }
        if (textChanged) WriteThrough(id);
        return result;
    }
    public NoteMeta RenameNote(string id, string title)
    {
        title = (title ?? "").Trim();
        if (title.Length == 0) throw new ArgumentException("Название пустое.");
        lock (_sync)
        {
            var n = _notes.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.");
            n.Title = Truncate(title, 120); n.UpdatedUtc = Now(); SaveMeta(n);
            _search[n.Id] = IndexKey(n, ReadContentSafe(n));
            return n.Clone();
        }
    }

    public NoteMeta MoveNote(string id, string projectId)
    {
        lock (_sync)
        {
            var n = _notes.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.");
            if (_projects.All(p => p.Id != projectId)) throw new KeyNotFoundException("Папка не найдена.");
            n.ProjectId = projectId; n.UpdatedUtc = Now(); SaveMeta(n);
            return n.Clone();
        }
    }

    public NoteMeta SetFlags(string id, bool? pinned = null, bool? archived = null, bool? deleted = null)
    {
        lock (_sync)
        {
            var n = _notes.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.");
            if (pinned.HasValue) n.IsPinned = pinned.Value;
            if (archived.HasValue) n.IsArchived = archived.Value;
            if (deleted.HasValue) n.IsDeleted = deleted.Value;
            SaveMeta(n);
            return n.Clone();
        }
    }

    public NoteMeta Duplicate(string id)
    {
        var doc = Open(id);
        if (doc.Locked) throw new NoteLockedException();
        if (doc.ExternalOnly) throw new InvalidOperationException("Большой файл нельзя продублировать как заметку.");
        if (doc.Meta.IsProtected) throw new InvalidOperationException("Копия защищённой заметки получилась бы без пароля. Сначала снимите пароль.");
        var copy = CreateNote(doc.Meta.ProjectId, doc.Content, doc.Meta.Title + " (копия)");
        if (doc.BlocksJson != null) { WriteBlocks(copy.Id, doc.BlocksJson, doc.Content); }
        return copy;
    }

    /// <summary>Irreversible. The history snapshots are removed with the note; the UI must have asked for confirmation.</summary>
    public void DeletePermanently(string id)
    {
        lock (_sync)
        {
            var n = _notes.FirstOrDefault(x => x.Id == id);
            if (n == null) return;
            if (!n.IsDeleted) throw new InvalidOperationException("Сначала переместите заметку в корзину.");
            _notes.Remove(n); _search.Remove(id);
            _conflicts.Remove(id); _sourceBackup.Remove(id); _sourceLocks.TryRemove(id, out _);
            if (Settings.WriteThroughIds.Contains(id)) { Settings.WriteThroughIds = Settings.WriteThroughIds.Where(x => x != id).ToArray(); SaveSettings(Settings); }
        }
        TryDelete(Paths.MetaPath(id)); TryDelete(Paths.ContentPath(id)); TryDelete(Paths.BlocksPath(id));
        try { var h = Paths.HistoryDir(id); if (Directory.Exists(h)) Directory.Delete(h, true); } catch (Exception ex) { Log("history delete: " + ex.Message); }
    }

    private void EnsureWithinLimits(string content)
    {
        if (content.Length > EditorLimitChars || Encoding.UTF8.GetByteCount(content) > InlineFileLimitBytes)
            throw new InvalidOperationException("Заметка превышает безопасный размер редактора. Разделите текст на несколько заметок.");
    }

    // ---------------------------------------------------------------- content files + blocks sidecar

    private string ReadContent(string id)
    {
        var path = Paths.ContentPath(id);
        if (!File.Exists(path)) return "";
        if (new FileInfo(path).Length > InlineFileLimitBytes) return "";
        return Unprotect(id, ReadTextFile(path));
    }

    private string ReadContentSafe(NoteMeta n) { try { return IsExternalOnly(n) ? "" : ReadContent(n.Id); } catch { return ""; } }

    private void WriteContent(string id, string content) => JsonIO.WriteAllTextAtomic(Paths.ContentPath(id), Protect(id, content));

    private sealed class BlocksFile
    {
        public int Schema { get; set; } = 1;
        public string ContentSha256 { get; set; } = "";
        public JsonElement Blocks { get; set; }
    }

    private void WriteBlocks(string id, string blocksJson, string content)
    {
        using var doc = JsonDocument.Parse(blocksJson); // validates that the UI really sent JSON
        if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new InvalidDataException("Блоки должны быть массивом JSON.");
        var file = new BlocksFile { ContentSha256 = Sha256(content), Blocks = doc.RootElement.Clone() };
        JsonIO.WriteAllTextAtomic(Paths.BlocksPath(id), Protect(id, JsonSerializer.Serialize(file, file.GetType(), JsonIO.Options)));
    }

    private string? ReadValidBlocks(string id, string content)
    {
        try
        {
            if (!File.Exists(Paths.BlocksPath(id))) return null;
            var f = JsonSerializer.Deserialize<BlocksFile>(Unprotect(id, File.ReadAllText(Paths.BlocksPath(id), Encoding.UTF8)), JsonIO.Options);
            if (f == null || f.Schema != 1) return null;
            if (!string.Equals(f.ContentSha256, Sha256(content), StringComparison.OrdinalIgnoreCase)) return null; // text edited elsewhere → stale
            return f.Blocks.GetRawText();
        }
        catch (Exception ex) { Log("blocks read " + id + ": " + ex.Message); return null; }
    }

    private void DeleteBlocks(string id) => TryDelete(Paths.BlocksPath(id));

    private void SaveMeta(NoteMeta n)
    {
        Normalize(n);
        JsonIO.WriteAtomic(Paths.MetaPath(n.Id), n);
    }

    // ---------------------------------------------------------------- history

    private void SnapshotHistory(string id, string content, bool force)
    {
        if (string.IsNullOrEmpty(content)) return;
        try
        {
            var dir = Paths.HistoryDir(id);
            Directory.CreateDirectory(dir);
            var files = new DirectoryInfo(dir).GetFiles("*.txt").OrderByDescending(f => f.LastWriteTimeUtc).ToList();
            if (!force && files.Count > 0 && DateTime.UtcNow - files[0].LastWriteTimeUtc < HistoryInterval) return;
            JsonIO.WriteAllTextAtomic(Path.Combine(dir, DateTime.Now.ToString("yyyyMMdd_HHmmss_fff", CultureInfo.InvariantCulture) + ".txt"), Protect(id, content));
            var all = new DirectoryInfo(dir).GetFiles("*.txt")
                .Select(f => new HistoryFileInfo(f.FullName, f.Length, f.LastWriteTimeUtc))
                .OrderByDescending(f => f.LastWriteTimeUtc).ToList();
            foreach (var old in HistoryFilesToDelete(all, DateTime.UtcNow)) TryDelete(old);
        }
        catch (Exception ex) { Log("history save: " + ex.Message); }
    }

    /// <summary>One history snapshot as the retention policy sees it (plain data so the policy is testable without files).</summary>
    public readonly record struct HistoryFileInfo(string FullName, long Bytes, DateTime LastWriteTimeUtc);

    /// <summary>Absolute caps for the tiered retention below; the newest <see cref="HistoryKeep"/> snapshots are always kept.</summary>
    public const int HistoryMaxTotal = 200;
    public const long HistoryMaxBytes = 16L * 1024 * 1024;

    /// <summary>
    /// Tiered retention for note history, newest first. The old rule deleted everything past the
    /// 50th copy, so a month-old note kept at most one editing session. Now the newest 50 are always
    /// kept, and older snapshots are thinned out instead of dropped: one per day up to 30 days,
    /// one per week up to a year, one per month beyond that — bounded by <see cref="HistoryMaxTotal"/>
    /// files and <see cref="HistoryMaxBytes"/> bytes (caps apply past the newest 50).
    /// </summary>
    public static IReadOnlyList<string> HistoryFilesToDelete(IReadOnlyList<HistoryFileInfo> newestFirst, DateTime utcNow)
    {
        var delete = new List<string>();
        var kept = 0;
        long bytes = 0;
        DateTime lastDay = DateTime.MaxValue, lastWeek = DateTime.MaxValue, lastMonth = DateTime.MaxValue;
        foreach (var f in newestFirst)
        {
            var stamp = f.LastWriteTimeUtc;
            var age = utcNow - stamp;
            bool keep;
            if (kept < HistoryKeep) keep = true;
            else if (kept >= HistoryMaxTotal) keep = false;
            else if (age <= TimeSpan.FromDays(30)) keep = stamp.Date != lastDay;
            else if (age <= TimeSpan.FromDays(365)) keep = WeekStart(stamp) != lastWeek;
            else keep = new DateTime(stamp.Year, stamp.Month, 1, 0, 0, 0, DateTimeKind.Utc) != lastMonth;
            if (keep && kept >= HistoryKeep && bytes + f.Bytes > HistoryMaxBytes) keep = false;
            if (!keep) { delete.Add(f.FullName); continue; }
            kept++;
            bytes += f.Bytes;
            lastDay = stamp.Date;
            lastWeek = WeekStart(stamp);
            lastMonth = new DateTime(stamp.Year, stamp.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        }
        return delete;
    }

    private static DateTime WeekStart(DateTime d) => d.Date.AddDays(-(((int)d.DayOfWeek + 6) % 7));

    /// <summary>Explicit checkpoint, for example just before an AI proposal replaces text.</summary>
    public void Checkpoint(string id) { var n = FindMeta(id); if (n != null && !IsExternalOnly(n)) SnapshotHistory(id, ReadContent(id), force: true); }

    public IReadOnlyList<HistoryEntry> ListHistory(string id)
    {
        var dir = Paths.HistoryDir(id);
        if (!Directory.Exists(dir)) return Array.Empty<HistoryEntry>();
        return new DirectoryInfo(dir).GetFiles("*.txt").OrderByDescending(f => f.Name).Select(f =>
        {
            var text = IsProtectedNote(id) ? "Версия защищена паролем" : SafePreview(f.FullName);
            return new HistoryEntry { Name = f.Name, TimestampLocal = f.LastWriteTime.ToString("dd.MM.yyyy HH:mm:ss", CultureInfo.InvariantCulture), Bytes = f.Length, Preview = text };
        }).ToList();
    }

    public string ReadHistory(string id, string name)
    {
        if (!Regex.IsMatch(name ?? "", @"^\d{8}_\d{6}_\d{3}\.txt$")) throw new ArgumentException("Недопустимое имя версии.");
        var path = Path.Combine(Paths.HistoryDir(id), name!);
        if (!File.Exists(path)) throw new FileNotFoundException("Версия не найдена.");
        return Unprotect(id, ReadTextFile(path));
    }

    private static string SafePreview(string path)
    {
        try { using var r = new StreamReader(path, Encoding.UTF8); var buf = new char[160]; var n = r.Read(buf, 0, buf.Length); return new string(buf, 0, n).Replace('\r', ' ').Replace('\n', ' ').Trim(); }
        catch { return ""; }
    }

    // ---------------------------------------------------------------- files from disk

    public bool IsExternalOnly(NoteMeta n)
    {
        if (n.ExternalOnly || string.Equals(n.ContentType, "external", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(n.SourceType, "file", StringComparison.OrdinalIgnoreCase) && !TextExtensions.Contains(Path.GetExtension(n.SourcePath ?? ""))) return true;
        var stored = Paths.ContentPath(n.Id);
        return File.Exists(stored) && new FileInfo(stored).Length > InlineFileLimitBytes;
    }

    public NoteMeta ImportFile(string path, string? projectId)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) throw new FileNotFoundException("Файл не найден.");
        path = Path.GetFullPath(path);
        lock (_sync)
        {
            var existing = _notes.FirstOrDefault(n => !string.IsNullOrWhiteSpace(n.SourcePath) && string.Equals(Path.GetFullPath(n.SourcePath), path, StringComparison.OrdinalIgnoreCase));
            if (existing != null)
            {
                if (existing.IsDeleted) { existing.IsDeleted = false; existing.UpdatedUtc = Now(); SaveMeta(existing); }
                return existing.Clone();
            }
        }
        var info = new FileInfo(path);
        if (!TextExtensions.Contains(info.Extension))
            throw new InvalidDataException("Этот формат не импортируется как текст. Исходный файл не изменён.");
        if (string.IsNullOrWhiteSpace(projectId)) projectId = "inbox";
        var external = info.Length > InlineFileLimitBytes;
        var content = external ? "" : ReadTextFile(path);
        if (!external && content.Length > EditorLimitChars) { external = true; content = ""; }
        var note = new NoteMeta
        {
            Id = Guid.NewGuid().ToString("N"), ProjectId = projectId!,
            Title = Path.GetFileNameWithoutExtension(path), SourcePath = path, SourceType = "file",
            ContentType = external ? "external" : DetectContentType(path, content), ExternalOnly = external,
            UpdatedUtc = info.LastWriteTimeUtc.ToString("o", CultureInfo.InvariantCulture),
            SourceLastWriteUtc = info.LastWriteTimeUtc.ToString("o", CultureInfo.InvariantCulture),
        };
        if (!external) WriteContent(note.Id, content);
        lock (_sync) { SaveMeta(note); _notes.Add(note); _search[note.Id] = IndexKey(note, content); }
        return note.Clone();
    }

    /// <summary>Writes the note back to its source file (keeping a copy of the previous file in backups). Only for notes that came from a file.</summary>
    public NoteMeta SaveToSource(string id, bool overwriteExternalChange = false)
    {
        NoteMeta n;
        lock (_sync) n = _notes.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.");
        if (IsExternalOnly(n) || !IsAllowedSource(n)) throw new InvalidOperationException("У заметки нет исходного файла, в который можно безопасно записать.");
        var content = ReadContent(id);
        byte[] original = Array.Empty<byte>();
        var knownStamp = DateTime.TryParse(n.SourceLastWriteUtc, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var known);
        if (File.Exists(n.SourcePath))
        {
            // somebody else changed the file after we read it, or we never knew which version it was: do not silently overwrite
            if (!overwriteExternalChange)
            {
                if (!knownStamp) throw new SourceChangedException("Неизвестно, какую версию файла вы видели. Сохранение отменено: откройте файл заново или выберите версию.");
                if (Math.Abs((File.GetLastWriteTimeUtc(n.SourcePath) - known.ToUniversalTime()).TotalSeconds) > 2)
                    throw new SourceChangedException("Файл изменён другой программой после открытия. Сохранение отменено, чтобы не потерять чужие правки.");
            }
            using (var probe = new FileStream(n.SourcePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                if (probe.Length > InlineFileLimitBytes) throw new InvalidOperationException("Файл больше лимита редактора: запись отключена.");
                original = new byte[(int)probe.Length];
                var read = 0;
                while (read < original.Length) { var got = probe.Read(original, read, original.Length - read); if (got <= 0) break; read += got; }
            }
            // one copy of the file as it was before this session touched it (and always one before a forced overwrite): not a copy per keystroke batch
            var needBackup = overwriteExternalChange || !_sourceBackup.TryGetValue(id, out var lastBackup) || DateTime.UtcNow - lastBackup > TimeSpan.FromMinutes(10);
            if (needBackup)
            {
                var safe = Regex.Replace(Path.GetFileName(n.SourcePath), "[^a-zA-Z0-9._-]", "_");
                Directory.CreateDirectory(Paths.Backups);
                var copyPath = Path.Combine(Paths.Backups, "source_" + DateTime.Now.ToString("yyyyMMdd_HHmmss_fff", CultureInfo.InvariantCulture) + "_" + safe);
                File.Copy(n.SourcePath, copyPath, true);
                File.SetAttributes(copyPath, FileAttributes.Normal);   // a read-only original must not make its backup undeletable
                _sourceBackup[id] = DateTime.UtcNow;
            }
        }
        else if (!overwriteExternalChange && !string.IsNullOrWhiteSpace(n.SourceLastWriteUtc))
            throw new SourceChangedException("Исходный файл удалён или перенесён. Сохранение отменено, чтобы не создавать его заново без вашего решения.");
        else if (!Directory.Exists(Path.GetDirectoryName(n.SourcePath)!))
            throw new InvalidOperationException("Папка исходного файла не найдена.");

        // keep the file's own encoding and line endings: opening and saving must not rewrite a file the user did not edit
        var (encoding, bom) = original.Length > 0 ? DetectEncoding(original) : (new UTF8Encoding(false), false);
        if (original.Length > 0) content = MergeLineEndings(DecodeText(original, lenient: true), content);
        byte[] body;
        try { body = encoding.GetBytes(content); }
        catch (EncoderFallbackException) { throw new InvalidOperationException("В тексте есть символы, которых нет в кодировке файла (Windows-1251). Сохранение отменено, чтобы не испортить файл."); }
        var bytes = bom ? encoding.GetPreamble().Concat(body).ToArray() : body;
        JsonIO.WriteAllBytesAtomic(n.SourcePath, bytes);
        lock (_sync) { n.SourceLastWriteUtc = File.GetLastWriteTimeUtc(n.SourcePath).ToString("o", CultureInfo.InvariantCulture); SaveMeta(n); return n.Clone(); }
    }

    /// <summary>
    /// Line endings of the file win for every line the user did not touch. The editor's text mirror is always LF, so a
    /// file with mixed endings (CRLF and LF) used to come back all-CRLF after a write-through save (QA2 defect N-06):
    /// unchanged lines keep their own ending, changed and added lines get the file's dominant ending, the last line gets none.
    /// Content that already carries CR (a plain-text caller, not the editor) and files without a single CRLF are returned as they are.
    /// </summary>
    public static string MergeLineEndings(string originalText, string contentText)
    {
        if (contentText.Contains('\r')) return contentText;
        if (!originalText.Contains("\r\n")) return contentText;

        // split the original into (text, ending) pairs
        var origLines = new List<string>();
        var origEndings = new List<string>();
        var i = 0;
        while (i < originalText.Length)
        {
            var nl = originalText.IndexOf('\n', i);
            if (nl < 0) { origLines.Add(originalText[i..]); origEndings.Add(""); break; }
            var cr = nl > i && originalText[nl - 1] == '\r';
            origLines.Add(originalText[i..(cr ? nl - 1 : nl)]);
            origEndings.Add(cr ? "\r\n" : "\n");
            i = nl + 1;
            if (i == originalText.Length) { origLines.Add(""); origEndings.Add(""); }
        }

        var contentLines = contentText.Split('\n');
        var crlf = 0; var lf = 0;
        for (var k = 0; k + 1 < origEndings.Count; k++) { if (origEndings[k] == "\r\n") crlf++; else lf++; }
        var dominant = crlf >= lf ? "\r\n" : "\n";

        var sb = new StringBuilder(contentText.Length + contentLines.Length);
        for (var k = 0; k < contentLines.Length; k++)
        {
            sb.Append(contentLines[k]);
            if (k == contentLines.Length - 1) break;   // the mirror never ends with a newline: do not add one
            var unchanged = k < origLines.Count && origEndings[k].Length > 0 && string.Equals(origLines[k], contentLines[k], StringComparison.Ordinal);
            sb.Append(unchanged ? origEndings[k] : dominant);
        }
        return sb.ToString();
    }

    /// <summary>The encoding a file was read as: its BOM, else UTF-8 when valid, else Windows-1251 (what <see cref="DecodeText"/> falls back to). cp1251 refuses characters it cannot represent instead of writing '?'.</summary>
    internal static (Encoding Encoding, bool Bom) DetectEncoding(byte[] b)
    {
        if (b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) return (new UTF8Encoding(true), true);
        if (b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE) return (new UnicodeEncoding(false, true, true), true);
        if (b.Length >= 2 && b[0] == 0xFE && b[1] == 0xFF) return (new UnicodeEncoding(true, true, true), true);
        try { new UTF8Encoding(false, true).GetString(b); return (new UTF8Encoding(false), false); }
        catch (DecoderFallbackException)
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            return (Encoding.GetEncoding(1251, new EncoderExceptionFallback(), DecoderFallback.ReplacementFallback), false);
        }
    }

    /// <summary>The one gate for writing into / reading from a user file: a local drive path, a note that came from a file, a text extension, no symbolic link or junction.</summary>
    private bool IsAllowedSource(NoteMeta n)
    {
        if (n.SourceType != "file" || string.IsNullOrWhiteSpace(n.SourcePath)) return false;
        try
        {
            if (!IsLocalDrivePath(n.SourcePath) || !TextExtensions.Contains(Path.GetExtension(n.SourcePath))) return false;
            var fi = new FileInfo(n.SourcePath);
            if (fi.Exists && fi.Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
            for (var dir = fi.Directory; dir != null; dir = dir.Parent)           // a junction or symlink in any parent folder redirects the write too
                if (dir.Exists && dir.Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
            return true;
        }
        catch { return false; }
    }

    // ---------------------------------------------------------------- open in place (write-through)

    private readonly Dictionary<string, DateTime> _sourceBackup = new();
    private readonly HashSet<string> _conflicts = new();
    private readonly ConcurrentDictionary<string, object> _sourceLocks = new();
    /// <summary>(note id, "saved" | "conflict" | "error", message) after a write into the source file.</summary>
    public event Action<string, string, string>? SourceStatus;

    /// <summary>After loading or restoring a backup: write-through survives only for notes that still exist and still point at an allowed file.</summary>
    private void SanitizeWriteThrough()
    {
        // structural checks only: a USB drive that is unplugged right now must not lose its write-through setting (the real gate runs at write time)
        var keep = Settings.WriteThroughIds.Where(id => _notes.FirstOrDefault(n => n.Id == id) is { } n && !IsExternalOnly(n) && n.SourceType == "file" && !string.IsNullOrWhiteSpace(n.SourcePath)).ToArray();
        if (keep.Length == Settings.WriteThroughIds.Length) return;
        Settings.WriteThroughIds = keep;
        SaveSettings(Settings);
    }

    public bool IsWriteThrough(string id) { lock (_sync) return Settings.WriteThroughIds.Contains(id); }

    public void SetWriteThrough(string id, bool on)
    {
        lock (_sync)
        {
            var n = _notes.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.");
            if (on && (IsExternalOnly(n) || !IsAllowedSource(n)))
                throw new InvalidOperationException("У этой заметки нет файла на локальном диске, в который можно сохранять.");
            var set = Settings.WriteThroughIds.ToHashSet(StringComparer.Ordinal);
            if (on) set.Add(id); else { set.Remove(id); _conflicts.Remove(id); }
            Settings.WriteThroughIds = set.ToArray();
            SaveSettings(Settings);
        }
    }

    /// <summary>Opens a file as a library note that is saved back into the file itself. Files the editor cannot hold stay read-only references.</summary>
    public NoteMeta OpenInPlace(string path, string? projectId)
    {
        var note = ImportFile(path, projectId);
        try
        {
            if (!IsExternalOnly(note) && IsAllowedSource(note))
            {
                // an older note for this file may hold a stale or empty copy (Windows Notepad transfer): the file the user just opened wins, the old text goes to history
                var disk = ReadTextFile(note.SourcePath);
                if (!string.Equals(disk, ReadContent(note.Id), StringComparison.Ordinal) || string.IsNullOrWhiteSpace(note.SourceLastWriteUtc))
                    note = ResolveSourceConflict(note.Id, "disk");
            }
            SetWriteThrough(note.Id, true);
        }
        catch (Exception ex) when (ex is InvalidOperationException or InvalidDataException or IOException or UnauthorizedAccessException) { /* too large, binary, not allowed: stays a normal note */ }
        return note;
    }

    private void WriteThrough(string id)
    {
        lock (_sync) { if (!Settings.WriteThroughIds.Contains(id) || _conflicts.Contains(id)) return; }
        try { lock (_sourceLocks.GetOrAdd(id, _ => new object())) SaveToSource(id); SourceStatus?.Invoke(id, "saved", ""); }
        catch (SourceChangedException ex) { lock (_sync) _conflicts.Add(id); SourceStatus?.Invoke(id, "conflict", ex.Message); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        { Log("write-through " + id + ": " + ex.Message); SourceStatus?.Invoke(id, "error", "Не удалось записать в файл: " + ex.Message); }
    }

    /// <summary>After "file changed elsewhere": "mine" overwrites the file with the note (the other version is kept in backups), "disk" takes the file's text into the note (the note's text goes to history).</summary>
    public NoteMeta ResolveSourceConflict(string id, string choice)
    {
        if (choice == "mine") { NoteMeta m; lock (_sourceLocks.GetOrAdd(id, _ => new object())) m = SaveToSource(id, overwriteExternalChange: true); lock (_sync) _conflicts.Remove(id); SourceStatus?.Invoke(id, "saved", ""); return m; }
        if (choice != "disk") throw new InvalidOperationException("Неизвестный выбор.");
        NoteMeta n;
        lock (_sync) n = _notes.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.");
        if (!IsAllowedSource(n)) throw new InvalidOperationException("Этот источник нельзя читать повторно: файл должен лежать на локальном диске и быть текстовым.");
        if (!File.Exists(n.SourcePath)) throw new FileNotFoundException("Исходный файл не найден.");
        var text = ReadTextFile(n.SourcePath);
        EnsureWithinLimits(text);
        lock (_sourceLocks.GetOrAdd(id, _ => new object()))
        lock (_sync)
        {
            SnapshotHistory(id, ReadContent(id), force: true);
            WriteContent(id, text); DeleteBlocks(id);
            var live = _notes.First(x => x.Id == id);
            live.UpdatedUtc = Now();
            live.SourceLastWriteUtc = File.GetLastWriteTimeUtc(live.SourcePath).ToString("o", CultureInfo.InvariantCulture);
            SaveMeta(live); _search[id] = IndexKey(live, text); _conflicts.Remove(id);
            return live.Clone();
        }
    }

    // ---------------------------------------------------------------- pictures

    public const long AssetLimitBytes = 10L * 1024 * 1024;

    /// <summary>
    /// Stores a picture next to the notes and returns its file name (sha256 prefix + extension). The type is decided by the file's own
    /// first bytes, never by a name or a MIME string from the page: only PNG, JPEG, GIF and WebP are accepted (no SVG: it can carry script).
    /// The same picture pasted twice is stored once.
    /// </summary>
    public string SaveAsset(byte[] bytes)
    {
        if (bytes.Length == 0 || bytes.Length > AssetLimitBytes) throw new InvalidDataException("Изображение пустое или больше 10 МБ.");
        var ext = SniffImageExtension(bytes) ?? throw new InvalidDataException("Поддерживаются изображения PNG, JPEG, GIF и WebP.");
        var name = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()[..32] + "." + ext;
        var path = Path.Combine(Paths.NotesAssets, name);
        Directory.CreateDirectory(Paths.NotesAssets);
        if (!File.Exists(path)) JsonIO.WriteAllBytesAtomic(path, bytes);
        return name;
    }

    private static readonly System.Text.RegularExpressions.Regex AssetFile = new(@"^[0-9a-f]{32}\.(png|jpg|gif|webp)$", System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>The bytes of a stored picture by its file name (the name pattern is checked: no paths, no other files).</summary>
    public byte[]? ReadAsset(string name)
    {
        if (string.IsNullOrEmpty(name) || !AssetFile.IsMatch(name)) return null;
        var path = Path.Combine(Paths.NotesAssets, name);
        try { return File.Exists(path) ? File.ReadAllBytes(path) : null; } catch (IOException) { return null; }
    }

    internal static string? SniffImageExtension(byte[] b)
    {
        if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47 && b[4] == 0x0D && b[5] == 0x0A && b[6] == 0x1A && b[7] == 0x0A) return "png";
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "jpg";
        if (b.Length >= 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8' && (b[4] == '7' || b[4] == '9') && b[5] == 'a') return "gif";
        if (b.Length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "webp";
        return null;
    }

    public sealed record ReferencedFile(string Id, string Title, string SourcePath, long Bytes);

    /// <summary>Notes that are empty but point to a readable text file. Lists only; nothing is read into notes. Secret-like extensions (.env, .local, keys) never qualify.</summary>
    public IReadOnlyList<ReferencedFile> ListResolvableReferences()
    {
        var list = new List<ReferencedFile>();
        foreach (var n in AllNotes().Where(n => !n.IsDeleted && n.SourceType == "file" && !string.IsNullOrWhiteSpace(n.SourcePath)))
        {
            try
            {
                if (n.IsProtected || IsExternalOnly(n) || ReadContent(n.Id).Length > 0) continue;
                if (!TextExtensions.Contains(Path.GetExtension(n.SourcePath)) || !IsLocalDrivePath(n.SourcePath)) continue;
                var fi = new FileInfo(n.SourcePath);
                if (!fi.Exists || fi.Length == 0 || fi.Length > InlineFileLimitBytes) continue;
                list.Add(new ReferencedFile(n.Id, n.Title, n.SourcePath, fi.Length));
            }
            catch { /* unreadable path: simply not offered */ }
        }
        return list;
    }

    /// <summary>
    /// For notes imported from a Windows Notepad snapshot whose text lived in an external file: reads that file now,
    /// but only on explicit request, only text files up to 1 MiB, and never overwrites a note that already has content.
    /// </summary>
    public int ResolveReferencedFiles(IEnumerable<string>? onlyIds = null)
    {
        var set = onlyIds?.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var filled = 0;
        foreach (var n in AllNotes().Where(n => !n.IsDeleted && n.SourceType == "file" && !string.IsNullOrWhiteSpace(n.SourcePath)))
        {
            if (set != null && !set.Contains(n.Id)) continue;
            try
            {
                if (n.IsProtected || IsExternalOnly(n) || ReadContent(n.Id).Length > 0) continue;
                if (!TextExtensions.Contains(Path.GetExtension(n.SourcePath)) || !IsLocalDrivePath(n.SourcePath) || !File.Exists(n.SourcePath) || new FileInfo(n.SourcePath).Length > InlineFileLimitBytes) continue;
                var text = ReadTextFile(n.SourcePath);
                if (text.Length == 0) continue;
                WriteContent(n.Id, text); DeleteBlocks(n.Id);
                lock (_sync)
                {
                    var live = _notes.First(x => x.Id == n.Id);
                    live.ContentType = DetectContentType(live.SourcePath, text); live.UpdatedUtc = Now(); SaveMeta(live); _search[live.Id] = IndexKey(live, text);
                }
                filled++;
            }
            catch (Exception ex) { Log("resolve " + n.Id + ": " + ex.Message); }
        }
        return filled;
    }

    // ---------------------------------------------------------------- search index

    private void BuildSearchIndex(CancellationToken token)
    {
        List<NoteMeta> list;
        lock (_sync) list = _notes.Select(n => n.Clone()).ToList();
        var i = 0;
        foreach (var n in list)
        {
            if (token.IsCancellationRequested) return;
            try
            {
                var sample = "";
                if (!n.IsProtected && !IsExternalOnly(n) && File.Exists(Paths.ContentPath(n.Id))) sample = ReadIndexSample(Paths.ContentPath(n.Id));
                lock (_sync) _search[n.Id] = IndexKey(n, sample);
            }
            catch { /* a broken file must not stop indexing */ }
            if (++i % 24 == 0) Thread.Sleep(2);
        }
    }

    private static string IndexKey(NoteMeta n, string content)
    {
        if (n.IsProtected) content = "";   // the text of a protected note never reaches the search index
        var sample = content.Length > SearchSampleChars ? content[..SearchSampleChars] : content;
        return ((n.Title ?? "") + "\n" + (n.Tags ?? "") + "\n" + sample).ToLowerInvariant();
    }

    private static string ReadIndexSample(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var count = (int)Math.Min(SearchSampleChars * 3L, fs.Length);
        var buf = new byte[count];
        var read = 0;
        while (read < count) { var c = fs.Read(buf, read, count - read); if (c == 0) break; read += c; }
        return DecodeText(buf.AsSpan(0, read).ToArray(), lenient: true);
    }

    // ---------------------------------------------------------------- helpers

    public static string AutoTitle(string? content)
    {
        if (!string.IsNullOrWhiteSpace(content))
            foreach (var line in Regex.Split(content, "\r?\n"))
            {
                var t = line.Trim().TrimStart('#', ' ', '-', '*', '>').Trim();
                if (t.Length > 0) return t.Length > 88 ? t[..85] + "…" : t;
            }
        return "Новая заметка";
    }

    public static string DetectContentType(string? path, string? content)
    {
        var ext = string.IsNullOrWhiteSpace(path) ? "" : Path.GetExtension(path).ToLowerInvariant();
        if (ext is ".html" or ".htm") return "html";
        if (ext is ".json" or ".xml" or ".yaml" or ".yml" or ".js" or ".ts" or ".tsx" or ".jsx" or ".py" or ".cs" or ".ps1" or ".psm1" or ".cmd" or ".bat" or ".sql" or ".css" or ".ini" or ".toml") return "code";
        if (!string.IsNullOrWhiteSpace(content))
        {
            var t = content.TrimStart();
            if (t.StartsWith("<!DOCTYPE html", StringComparison.OrdinalIgnoreCase) || t.StartsWith("<html", StringComparison.OrdinalIgnoreCase)) return "html";
        }
        return "text";
    }

    public static string ReadTextFile(string path)
    {
        byte[] b;
        using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            if (input.Length > InlineFileLimitBytes) throw new InvalidDataException("Файл больше лимита редактора 1 МиБ.");
            using var ms = new MemoryStream();
            input.CopyTo(ms);
            b = ms.ToArray();
        }
        return DecodeText(b, lenient: false);
    }

    internal static string DecodeText(byte[] b, bool lenient)
    {
        if (b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) return Encoding.UTF8.GetString(b, 3, b.Length - 3);
        if (b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE) return Encoding.Unicode.GetString(b, 2, b.Length - 2);
        if (b.Length >= 2 && b[0] == 0xFE && b[1] == 0xFF) return Encoding.BigEndianUnicode.GetString(b, 2, b.Length - 2);
        if (!lenient && LooksBinary(b)) throw new InvalidDataException("Файл содержит двоичные данные и не может быть импортирован как текст.");
        try { return new UTF8Encoding(false, true).GetString(b); }
        catch
        {
            if (lenient) return new UTF8Encoding(false, false).GetString(b);
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            return Encoding.GetEncoding(1251).GetString(b);
        }
    }

    private static bool LooksBinary(byte[] bytes)
    {
        var n = Math.Min(bytes.Length, 8192);
        if (n == 0) return false;
        var controls = 0;
        for (var i = 0; i < n; i++)
        {
            var c = bytes[i];
            if (c == 0) return true;
            if ((c < 0x20 && c != 0x09 && c != 0x0A && c != 0x0C && c != 0x0D) || c == 0x7F) controls++;
        }
        return controls * 100 > n;
    }

    private static string Sha256(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
    private static string Now() => DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
    private static DateTime ParseUtc(string? s) => DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var d) ? d : DateTime.MinValue;
    private static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }

    internal void Log(string message)
    {
        try { File.AppendAllText(Path.Combine(Paths.LogDir, "core-v4.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "  " + message + Environment.NewLine, Encoding.UTF8); } catch { }
    }

    // exposed to LegacyNotepadImporter (same assembly)
    internal NoteMeta? FindByLegacyGuid(string guid) { lock (_sync) return _notes.FirstOrDefault(x => !string.IsNullOrWhiteSpace(x.LegacySourceGuid) && string.Equals(x.LegacySourceGuid, guid, StringComparison.OrdinalIgnoreCase)); }
    internal void AddImported(NoteMeta n, string content)
    {
        WriteContent(n.Id, content);
        lock (_sync) { SaveMeta(n); _notes.Add(n); _search[n.Id] = IndexKey(n, content); }
    }
    internal bool UpdateImportedContent(NoteMeta n, string content, string? title, string sourcePath)
    {
        var existing = ReadContentSafe(n);
        if (string.Equals(existing, content, StringComparison.Ordinal)) return false;
        SnapshotHistory(n.Id, existing, force: true);
        WriteContent(n.Id, content); DeleteBlocks(n.Id);
        lock (_sync)
        {
            var live = _notes.First(x => x.Id == n.Id);
            if (!string.IsNullOrWhiteSpace(title)) live.Title = title!;
            live.SourcePath = sourcePath; live.ContentType = DetectContentType(sourcePath, content); live.UpdatedUtc = Now();
            SaveMeta(live); _search[live.Id] = IndexKey(live, content);
        }
        return true;
    }
}






