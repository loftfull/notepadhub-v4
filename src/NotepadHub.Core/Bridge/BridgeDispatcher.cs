using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using NotepadHub.Core.Ai;
using NotepadHub.Core.Backup;

namespace NotepadHub.Core.Bridge;

/// <summary>What the host UI layer (windows, file dialogs) must provide. Kept as an interface so the dispatcher is testable without WPF.</summary>
public interface IHostUi
{
    /// <summary>Asks the user for a Windows Notepad snapshot ZIP. Null = cancelled.</summary>
    string? PickWindowsSnapshot();
    /// <summary>Asks the user for text files to open as notes. Empty = cancelled.</summary>
    IReadOnlyList<string> PickTextFiles();
    /// <summary>Asks where to save a .nhub backup. Null = cancelled.</summary>
    string? PickBackupSavePath(string suggestedName);
    /// <summary>Asks which .nhub backup to restore. Null = cancelled.</summary>
    string? PickBackupOpenPath();
    /// <summary>Native confirmation before anything is replaced. Must show the counts and mention the rollback copy.</summary>
    bool ConfirmRestore(BackupInfo backup, int currentNotes);
    /// <summary>Shows a file of the data folder in Windows Explorer. A host without a window may ignore it.</summary>
    void RevealFile(string path) { }
}

public sealed class BridgeException : Exception
{
    public string Code { get; }
    public BridgeException(string code, string message) : base(message) { Code = code; }
}

public sealed record BridgeProject(string Id, string Name, int Order, bool IsSystem, bool ShowInTabs, string ParentId);

public sealed record BridgeNote(
    string Id, string Title, string ProjectId, string Tags, string CreatedUtc, string UpdatedUtc, string LastOpenedUtc,
    bool IsPinned, bool IsArchived, bool IsDeleted, bool ExternalOnly, string LegacySourceGuid, string SourcePath, string SourceType,
    string ContentType, string Content, string? BlocksJson, bool WriteThrough, bool IsProtected, bool Locked);

public sealed record BridgeSettings(string ActiveProjectId, string SelectedNoteId, string Theme, bool SidebarVisible);

/// <summary>
/// Contract v1 between the web UI and the native host. Every command validates its input; the page can never name a path
/// (files are chosen by the user in native dialogs) and can never reach another process or folder.
/// </summary>
public sealed class BridgeDispatcher
{
    public const int Contract = 1;
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    private readonly NoteStore _store;
    private readonly IHostUi _ui;
    private readonly string _version;
    private readonly AiService? _ai;
    private readonly Action<string, object> _raise;

    public BridgeDispatcher(NoteStore store, IHostUi ui, string version, AiService? ai = null, Action<string, object>? raise = null)
    {
        _store = store; _ui = ui; _version = version; _ai = ai; _raise = raise ?? ((_, _) => { });
        _store.SourceStatus += (id, status, message) => _raise("sourceStatus", new { id, status, message });
    }

    private ImageFetcher? _images;
    private ImageFetcher Images() => _images ??= new ImageFetcher(allowLocal: AllowLocalImages);

    private static bool AllowLocalImages =>
#if DEBUG
        Environment.GetEnvironmentVariable("NOTEPADHUB_ALLOW_LOCAL_IMAGES") == "1";
#else
        false;
#endif

    private static T Read<T>(JsonElement payload) where T : class
    {
        try { return payload.Deserialize<T>(Web) ?? throw new BridgeException("bad-request", "Пустой запрос."); }
        catch (JsonException) { throw new BridgeException("bad-request", "Некорректный запрос."); }
    }

    public async Task<object?> HandleAsync(string type, JsonElement payload)
    {
        switch (type)
        {
            case "aiStatus": return await Ai().StatusAsync(CancellationToken.None);
            case "aiModels": return await Ai().ModelsAsync(Read<ProviderRequest>(payload).Provider, CancellationToken.None);
            case "aiStreamStart":
            {
                var r = Read<StreamRequest>(payload);
                if (string.IsNullOrWhiteSpace(r.RequestId) || r.RequestId.Length > 64) throw new BridgeException("bad-request", "Нет идентификатора запроса.");
                var id = r.RequestId;
                await Ai().StartStreamAsync(id, r.Body, data => _raise("aiEvent", new { requestId = id, data }));
                return new { status = 200 };
            }
            case "fetchImage":
            {
                // a picture copied from a web page: downloaded here (public addresses only), stored next to the notes, shown from the host's own address
                var r = Read<UrlRequest>(payload);
                if (string.IsNullOrWhiteSpace(r.Url) || r.Url.Length > 4096) throw new BridgeException("bad-request", "Адрес картинки пустой или слишком длинный.");
                try
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                    var bytes = await Images().FetchAsync(r.Url, cts.Token);
                    return new { file = _store.SaveAsset(bytes) };
                }
                catch (InvalidDataException ex) { throw new BridgeException("bad-request", ex.Message); }
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException or SocketException)
                { throw new BridgeException("unavailable", "Не удалось скачать картинку."); }
            }
            case "aiCancel": Ai().Cancel(Read<StreamRequest>(payload).RequestId); return new { };
            case "aiSetKey": Ai().SetKey(Read<KeyRequest>(payload).Key); return new { };
            case "aiCompatSave": { var r = Read<CompatRequest>(payload); Ai().SaveCompat(r.BaseUrl, r.Name, string.IsNullOrWhiteSpace(r.Key) ? null : r.Key); return new { }; }
            case "aiCompatClear": Ai().ClearCompat(); return new { };
            case "generateImage":
            {
                var r = Read<GenerateImageRequest>(payload);
                try
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(120));
                    var bytes = await Ai().GenerateImageAsync(r.Prompt, r.Width, r.Height, r.Via, r.Model, r.Consent, Images(), cts.Token);
                    return new { file = _store.SaveAsset(bytes) };
                }
                catch (InvalidDataException ex) { throw new BridgeException("bad-request", ex.Message); }
                catch (AiHttpException ex) { throw new BridgeException("bad-request", ex.Message); }
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException or SocketException)
                { throw new BridgeException("unavailable", "Не удалось получить картинку: сервис не ответил."); }
            }
            case "readAsset":
            {
                // the page cannot read its own picture address (no CORS), but an editor must see the pixels: the host hands over a stored picture by its file name
                var r = Read<NameRequest>(payload);
                var bytes = _store.ReadAsset(r.Name) ?? throw new BridgeException("not-found", "Картинка не найдена.");
                return new { data = Convert.ToBase64String(bytes) };
            }
            case "aiClearKey": Ai().ClearKey(); return new { };
        }
        return await Task.Run(() => HandleSync(type, payload));
    }

    private AiService Ai() => _ai ?? throw new BridgeException("unavailable", "AI недоступен в этой сборке.");

    private object? HandleSync(string type, JsonElement payload)
    {
        switch (type)
        {
            case "bootstrap": return Bootstrap();
            case "createProject": { var r = Read<NameRequest>(payload); return Project(_store.CreateProject(r.Name, r.ParentId ?? "")); }
            case "moveProject": { var r = Read<MoveProjectRequest>(payload); _store.MoveProject(r.Id, r.ParentId ?? ""); return new { }; }
            case "renameProject": { var r = Read<RenameRequest>(payload); _store.RenameProject(r.Id, r.Name); return new { }; }
            case "deleteProject": return new { movedNotes = _store.DeleteProject(Read<IdRequest>(payload).Id) };
            case "upsertNote": return Upsert(Read<UpsertDto>(payload));
            case "deleteNote": { _store.DeletePermanently(Read<IdRequest>(payload).Id); return new { }; }
            case "saveSettings": SaveSettings(Read<SettingsDto>(payload)); return new { };
            case "listHistory": return _store.ListHistory(Read<IdRequest>(payload).Id);
            case "readHistory": { var r = Read<HistoryRequest>(payload); return _store.ReadHistory(r.Id, r.Name); }
            case "importWindowsSnapshot": return ImportSnapshot();
            case "openFiles": return OpenFiles();
            case "revealNote":
            {
                var r = Read<IdRequest>(payload); RequireId(r.Id);
                var path = _store.Paths.ContentPath(r.Id);
                if (!File.Exists(path)) throw new BridgeException("not-found", "Файл заметки ещё не записан на диск.");
                _ui.RevealFile(path);
                return new { };
            }
            case "saveAsset":
            {
                var r = Read<AssetRequest>(payload);
                if (string.IsNullOrEmpty(r.Data) || r.Data.Length > 14_500_000) throw new BridgeException("bad-request", "Изображение пустое или больше 10 МБ.");
                byte[] bytes;
                try { bytes = Convert.FromBase64String(r.Data); } catch (FormatException) { throw new BridgeException("bad-request", "Не удалось прочитать изображение."); }
                try { return new { file = _store.SaveAsset(bytes) }; }
                catch (InvalidDataException ex) { throw new BridgeException("bad-request", ex.Message); }
            }
            case "setWriteThrough": { var r = Read<WriteThroughRequest>(payload); RequireId(r.Id); _store.SetWriteThrough(r.Id, r.Enabled); return new { id = r.Id, enabled = r.Enabled }; }
            case "resolveSourceConflict": { var r = Read<ConflictRequest>(payload); RequireId(r.Id); var m = _store.ResolveSourceConflict(r.Id, r.Choice); return new { id = m.Id, updatedUtc = m.UpdatedUtc }; }
            case "setPassword": { var r = Read<PasswordRequest>(payload); RequireId(r.Id); var m = _store.SetPassword(r.Id, r.Password); return new { id = m.Id, updatedUtc = m.UpdatedUtc }; }
            case "unlockNote": { var r = Read<PasswordRequest>(payload); RequireId(r.Id); _store.UnlockNote(r.Id, r.Password); return new { }; }
            case "removePassword": { var r = Read<PasswordRequest>(payload); RequireId(r.Id); var m = _store.RemovePassword(r.Id, r.Password); return new { id = m.Id, updatedUtc = m.UpdatedUtc }; }
            case "relockNotes": _store.RelockNotes(Read<OptionalIdRequest>(payload).Id); return new { };
            case "checkpoint": _store.Checkpoint(Read<IdRequest>(payload).Id); return new { };
            case "createBackup": return CreateBackup();
            case "restoreBackup": return RestoreBackup();
            case "previewReferencedFiles": return new { files = _store.ListResolvableReferences().Select(r => new { r.Id, r.Title, r.SourcePath, r.Bytes }).ToList() };
            case "resolveReferencedFiles":
            {
                var ids = Read<IdsRequest>(payload).Ids;
                if (ids == null || ids.Count == 0 || ids.Count > 500) throw new BridgeException("bad-request", "Выберите заметки для чтения файлов.");
                return new { filled = _store.ResolveReferencedFiles(ids) };
            }
            default: throw new BridgeException("unknown-command", "Неизвестная команда.");
        }
    }

    private object Bootstrap()
    {
        var notes = _store.AllNotes().Select(m =>
        {
            string content = ""; string? blocks = null; var external = false;
            try
            {
                var d = _store.Open(m.Id, markOpened: false);
                content = d.Content; blocks = d.BlocksJson; external = d.ExternalOnly;
            }
            catch (Exception ex) when (ex is IOException or InvalidDataException or ArgumentException or UnauthorizedAccessException)
            {
                // one unreadable file (binary bytes, access error) must not stop the whole library from opening:
                // it is shown as "not loaded into the editor" and its files stay untouched
                external = true;
            }
            return new BridgeNote(m.Id, m.Title, m.ProjectId, m.Tags, m.CreatedUtc, m.UpdatedUtc, m.LastOpenedUtc, m.IsPinned, m.IsArchived, m.IsDeleted,
                external, m.LegacySourceGuid, m.SourcePath, m.SourceType, m.ContentType, content, blocks, _store.IsWriteThrough(m.Id), m.IsProtected, m.IsProtected && !_store.IsUnlocked(m.Id));
        }).ToList();
        var s = _store.Settings;
        return new
        {
            contract = Contract, hostVersion = _version, mode = "host",
            projects = _store.Projects.Select(Project).ToList(),
            notes,
            settings = new BridgeSettings(s.ActiveProjectId, s.SelectedNoteId, s.Theme, s.SidebarVisible),
        };
    }

    private static BridgeProject Project(ProjectModel p) => new(p.Id, p.Name, p.Order, p.IsSystem, p.ShowInTabs, p.ParentId);

    private object Upsert(UpsertDto d)
    {
        if (string.IsNullOrWhiteSpace(d.Id)) throw new BridgeException("bad-request", "Нет идентификатора заметки.");
        var m = _store.Upsert(new NoteStore.UpsertRequest
        {
            Id = d.Id, ProjectId = d.ProjectId, Title = d.Title, Tags = d.Tags, Pinned = d.Pinned, Archived = d.Archived, Deleted = d.Deleted,
            Content = d.Content, BlocksJson = d.BlocksJson,
        });
        return new { id = m.Id, updatedUtc = m.UpdatedUtc };
    }

    private void SaveSettings(SettingsDto d)
    {
        var s = _store.Settings;
        if (d.ActiveProjectId != null) s.ActiveProjectId = d.ActiveProjectId;
        if (d.SelectedNoteId != null) s.SelectedNoteId = d.SelectedNoteId;
        if (d.Theme is "system" or "light" or "dark") s.Theme = d.Theme;
        if (d.SidebarVisible.HasValue) s.SidebarVisible = d.SidebarVisible.Value;
        _store.SaveSettings(s);
    }

    private object ImportSnapshot()
    {
        var path = _ui.PickWindowsSnapshot();
        if (string.IsNullOrWhiteSpace(path)) return new { created = 0, updated = 0, skipped = 0, emptyWithExternalFile = 0, warnings = new[] { "Перенос отменён." }, cancelled = true };
        var r = LegacyNotepadImporter.ImportZip(_store, path);
        return new { created = r.Created, updated = r.Updated, skipped = r.Skipped, emptyWithExternalFile = r.EmptyWithExternalFile, warnings = r.Warnings, cancelled = false };
    }

    private object CreateBackup()
    {
        var path = _ui.PickBackupSavePath("NotepadHub_" + DateTime.Now.ToString("yyyy-MM-dd_HH-mm") + ".nhub");
        if (string.IsNullOrWhiteSpace(path)) return new { cancelled = true };
        NhubBackup.Create(_store, path, _version);
        var info = NhubBackup.Inspect(path);
        if (!info.Valid) throw new InvalidOperationException("Копия создана, но проверка не пройдена: " + info.Error);
        return new { cancelled = false, fileName = Path.GetFileName(path), noteCount = info.NoteCount, projectCount = info.ProjectCount, bytes = info.Bytes };
    }

    private object RestoreBackup()
    {
        var path = _ui.PickBackupOpenPath();
        if (string.IsNullOrWhiteSpace(path)) return new { cancelled = true };
        var info = NhubBackup.Inspect(path);
        if (!info.Valid) throw new InvalidDataException(info.Error);
        if (!_ui.ConfirmRestore(info, _store.AllNotes().Count)) return new { cancelled = true };
        var rollback = NhubBackup.Restore(_store, path, _version);
        return new { cancelled = false, restoredNotes = info.NoteCount, rollbackFileName = Path.GetFileName(rollback) };
    }

    private object OpenFiles()
    {
        var files = _ui.PickTextFiles();
        if (files.Count == 0) return new { created = Array.Empty<string>(), cancelled = true, warnings = Array.Empty<string>() };
        var created = new List<string>(); var warnings = new List<string>();
        foreach (var f in files)
        {
            try { created.Add(_store.OpenInPlace(f, _store.Settings.ActiveProjectId).Id); }
            catch (Exception ex) when (ex is InvalidDataException or IOException or InvalidOperationException) { warnings.Add(Path.GetFileName(f) + ": " + ex.Message); }
        }
        return new { created, cancelled = false, warnings };
    }

    // ---- request shapes (camelCase from the page)
    private sealed class PasswordRequest { public string Id { get; set; } = ""; public string Password { get; set; } = ""; }
    private sealed class OptionalIdRequest { public string? Id { get; set; } }
    private sealed class NameRequest { public string Name { get; set; } = ""; public string? ParentId { get; set; } }
    private sealed class MoveProjectRequest { public string Id { get; set; } = ""; public string? ParentId { get; set; } }
    private sealed class RenameRequest { public string Id { get; set; } = ""; public string Name { get; set; } = ""; }
    private sealed class ProviderRequest { public string Provider { get; set; } = ""; }
    private sealed class KeyRequest { public string Key { get; set; } = ""; }
    private sealed class CompatRequest { public string BaseUrl { get; set; } = ""; public string Name { get; set; } = ""; public string Key { get; set; } = ""; }
    private sealed class StreamRequest { public string RequestId { get; set; } = ""; public JsonElement Body { get; set; } }
    private sealed class IdsRequest { public List<string>? Ids { get; set; } }
    private sealed class AssetRequest { public string Data { get; set; } = ""; }
    private sealed class UrlRequest { public string Url { get; set; } = ""; }
    private sealed class GenerateImageRequest { public string Prompt { get; set; } = ""; public int Width { get; set; } = 768; public int Height { get; set; } = 768; public string Via { get; set; } = "pollinations"; public string Model { get; set; } = ""; public bool Consent { get; set; } }
    private sealed class IdRequest { public string Id { get; set; } = ""; }
    private sealed class WriteThroughRequest { public string Id { get; set; } = ""; public bool Enabled { get; set; } }
    private sealed class ConflictRequest { public string Id { get; set; } = ""; public string Choice { get; set; } = ""; }
    private static void RequireId(string id) { if (string.IsNullOrWhiteSpace(id) || id.Length > 64) throw new BridgeException("bad-request", "Нет идентификатора заметки."); }
    private sealed class HistoryRequest { public string Id { get; set; } = ""; public string Name { get; set; } = ""; }
    private sealed class UpsertDto
    {
        public string Id { get; set; } = ""; public string? ProjectId { get; set; } public string? Title { get; set; } public string? Tags { get; set; }
        public bool Pinned { get; set; } public bool Archived { get; set; } public bool Deleted { get; set; }
        public string? Content { get; set; } public string? BlocksJson { get; set; }
    }
    private sealed class SettingsDto { public string? ActiveProjectId { get; set; } public string? SelectedNoteId { get; set; } public string? Theme { get; set; } public bool? SidebarVisible { get; set; } }
}



