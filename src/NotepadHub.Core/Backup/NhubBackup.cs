using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace NotepadHub.Core.Backup;

public sealed class BackupInfo
{
    public bool Valid { get; set; }
    public string Error { get; set; } = "";
    public string CreatedUtc { get; set; } = "";
    public string AppVersion { get; set; } = "";
    public int NoteCount { get; set; }
    public int ProjectCount { get; set; }
    public long Bytes { get; set; }
}

/// <summary>
/// .nhub = a ZIP with the same layout as data-v3 at its root (projects.json, notes-meta, notes-content, notes-blocks, history)
/// plus manifest.json (format, schema, counts, SHA-256 of every file). Settings and lock files are never included.
/// The manifest sits inside the archive, so it protects against damage and accidents, not against a deliberately forged file:
/// a forged archive is therefore also checked for duplicate names, unsafe paths and note ids that do not match their file names.
/// Restore copies the chosen file once, verifies that copy, re-checks every hash while extracting, and only then — inside the
/// exclusive lock — writes a rollback .nhub of the current state and swaps folders. Nothing is replaced if any step fails.
/// </summary>
public static class NhubBackup
{
    public const string Format = "notepad-hub-backup";
    public const int Schema = 1;
    private const long MaxTotalBytes = 2L * 1024 * 1024 * 1024;
    private const long MaxEntryBytes = 64L * 1024 * 1024;   // a note, its blocks or one history version is never this big
    private const int MaxEntries = 200_000;
    private static readonly string[] Folders = { "notes-meta", "notes-content", "notes-blocks", "notes-assets", "history" };
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private sealed class ManifestFile { public string Path { get; set; } = ""; public string Sha256 { get; set; } = ""; public long Bytes { get; set; } }
    private sealed class Manifest
    {
        public string Format { get; set; } = NhubBackup.Format;
        public int Schema { get; set; } = NhubBackup.Schema;
        public string CreatedUtc { get; set; } = "";
        public string AppVersion { get; set; } = "";
        public int NoteCount { get; set; }
        public int ProjectCount { get; set; }
        public List<ManifestFile> Files { get; set; } = new();
    }

    // ---------------------------------------------------------------- create

    public static void Create(NoteStore store, string destination, string appVersion)
    {
        var tmp = destination + "." + Environment.ProcessId + "." + Guid.NewGuid().ToString("N")[..6] + ".tmp";
        try
        {
            store.WithExclusiveAccess(() =>
            {
                var root = store.Paths.DataV3;
                var manifest = new Manifest { CreatedUtc = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture), AppVersion = appVersion };
                using (var zip = ZipFile.Open(tmp, ZipArchiveMode.Create))
                {
                    foreach (var file in EnumerateBackupFiles(root))
                    {
                        var rel = Path.GetRelativePath(root, file).Replace('\\', '/');
                        var bytes = File.ReadAllBytes(file);
                        var entry = zip.CreateEntry(rel, CompressionLevel.Optimal);
                        using (var s = entry.Open()) s.Write(bytes);
                        manifest.Files.Add(new ManifestFile { Path = rel, Sha256 = Hex(SHA256.HashData(bytes)), Bytes = bytes.Length });
                    }
                    manifest.NoteCount = manifest.Files.Count(f => f.Path.StartsWith("notes-meta/", StringComparison.Ordinal));
                    manifest.ProjectCount = CountProjects(root);
                    var m = zip.CreateEntry("manifest.json", CompressionLevel.Optimal);
                    using var ms = m.Open();
                    ms.Write(JsonSerializer.SerializeToUtf8Bytes(manifest, Json));
                }
                return 0;
            });
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(destination))!);
            File.Move(tmp, destination, overwrite: true);
        }
        finally { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { } }
    }

    private static IEnumerable<string> EnumerateBackupFiles(string root)
    {
        var projects = Path.Combine(root, "projects.json");
        if (File.Exists(projects)) yield return projects;
        foreach (var folder in Folders)
        {
            var dir = Path.Combine(root, folder);
            if (!Directory.Exists(dir)) continue;
            foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                if (!f.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) yield return f;
        }
    }

    private static int CountProjects(string root)
    {
        try { using var d = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "projects.json"))); return d.RootElement.GetArrayLength(); }
        catch { return 0; }
    }

    private static string Hex(byte[] h) => Convert.ToHexString(h).ToLowerInvariant();

    // ---------------------------------------------------------------- inspect

    /// <summary>Checks the archive without touching any data: format, schema, safe unique names, sizes, note ids and every file hash.</summary>
    public static BackupInfo Inspect(string path)
    {
        var info = new BackupInfo();
        try
        {
            var fi = new FileInfo(path);
            if (!fi.Exists) return Fail(info, "Файл копии не найден.");
            info.Bytes = fi.Length;
            using var zip = ZipFile.OpenRead(path);
            var (manifest, error) = ValidateStructure(zip);
            if (manifest == null) return Fail(info, error);
            foreach (var f in manifest.Files)
            {
                var bytes = ReadEntry(zip.GetEntry(f.Path)!);
                if (bytes.Length != f.Bytes || !string.Equals(Hex(SHA256.HashData(bytes)), f.Sha256, StringComparison.OrdinalIgnoreCase))
                    return Fail(info, $"Файл повреждён или изменён: {f.Path}");
                if (f.Path.StartsWith("notes-meta/", StringComparison.Ordinal) && !IsValidMeta(f.Path, bytes))
                    return Fail(info, $"Некорректная запись заметки: {f.Path}");
            }
            info.Valid = true; info.CreatedUtc = manifest.CreatedUtc; info.AppVersion = manifest.AppVersion; info.NoteCount = manifest.NoteCount; info.ProjectCount = manifest.ProjectCount;
            return info;
        }
        catch (Exception ex) when (ex is InvalidDataException or JsonException or IOException or NotSupportedException)
        {
            return Fail(info, "Не удалось прочитать архив: он повреждён или не является копией Notepad Hub.");
        }
    }

    private static (Manifest? Manifest, string Error) ValidateStructure(ZipArchive zip)
    {
        if (zip.Entries.Count > MaxEntries) return (null, "В архиве слишком много файлов.");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var e in zip.Entries)
        {
            if (!IsSafeEntryName(e.FullName)) return (null, "В архиве есть небезопасный путь: копия отклонена.");
            if (!e.FullName.EndsWith('/') && !seen.Add(e.FullName)) return (null, "В архиве повторяются имена файлов: копия отклонена.");
            if (e.Length > MaxEntryBytes) return (null, "В архиве есть слишком большой файл: копия отклонена.");
            total += e.Length;
            if (total > MaxTotalBytes) return (null, "Размер данных в архиве больше 2 ГБ.");
        }
        var mEntry = zip.GetEntry("manifest.json");
        if (mEntry == null) return (null, "Это не резервная копия Notepad Hub 4: нет manifest.json.");
        Manifest? m;
        using (var s = mEntry.Open()) m = JsonSerializer.Deserialize<Manifest>(s, Json);
        if (m == null || m.Format != Format) return (null, "Неизвестный формат копии.");
        if (m.Schema != Schema) return (null, $"Версия формата копии ({m.Schema}) не поддерживается этой программой.");
        var listed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var f in m.Files)
        {
            if (!IsSafeEntryName(f.Path) || !IsAllowedPath(f.Path) || !listed.Add(f.Path)) return (null, "В манифесте есть недопустимый или повторяющийся путь.");
            if (zip.GetEntry(f.Path) == null) return (null, $"В архиве нет файла из манифеста: {f.Path}");
        }
        foreach (var e in zip.Entries)
            if (e.FullName != "manifest.json" && !e.FullName.EndsWith('/') && !listed.Contains(e.FullName))
                return (null, $"В архиве есть файл вне манифеста: {e.FullName}");
        return (m, "");
    }

    private static byte[] ReadEntry(ZipArchiveEntry e)
    {
        using var s = e.Open();
        using var buf = new MemoryStream();
        s.CopyTo(buf);
        return buf.ToArray();
    }

    /// <summary>A note record must be named after its own id and the id must be a plain file-name-safe string.</summary>
    private static bool IsValidMeta(string entryPath, byte[] bytes)
    {
        try
        {
            using var d = JsonDocument.Parse(bytes);
            if (d.RootElement.ValueKind != JsonValueKind.Object || !d.RootElement.TryGetProperty("Id", out var id) || id.ValueKind != JsonValueKind.String) return false;
            var value = id.GetString()!;
            DataPaths.SafeId(value);
            return string.Equals(value + ".json", Path.GetFileName(entryPath), StringComparison.Ordinal);
        }
        catch { return false; }
    }

    private static BackupInfo Fail(BackupInfo info, string error) { info.Valid = false; info.Error = error; return info; }

    private static bool IsSafeEntryName(string name) =>
        !string.IsNullOrEmpty(name) && !name.StartsWith('/') && !name.StartsWith('\\') && !name.Contains('\\') && !name.Contains(':')
        && !name.Split('/').Any(p => p == ".." || p == ".");

    private static readonly System.Text.RegularExpressions.Regex AssetName = new(@"^notes-assets/[0-9a-f]{32}\.(png|jpg|gif|webp)$", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static bool IsAllowedPath(string p) => p == "projects.json" || (p.StartsWith("notes-assets/", StringComparison.Ordinal) ? AssetName.IsMatch(p) : Folders.Any(f => p.StartsWith(f + "/", StringComparison.Ordinal)));

    // ---------------------------------------------------------------- restore

    /// <summary>
    /// A file link (SourcePath) from a backup is kept only when this profile already links the same note to the same path.
    /// Otherwise a forged or foreign .nhub could point a note at any file on this computer, and later saves would write there.
    /// </summary>
    private static byte[] DropForeignSource(byte[] meta, Dictionary<string, string> knownSources)
    {
        try
        {
            var node = System.Text.Json.Nodes.JsonNode.Parse(meta) as System.Text.Json.Nodes.JsonObject;
            if (node == null) return meta;
            var path = node["SourcePath"]?.GetValue<string>() ?? "";
            if (string.IsNullOrWhiteSpace(path)) return meta;
            var id = node["Id"]?.GetValue<string>() ?? "";
            if (knownSources.TryGetValue(id, out var known) && string.Equals(known, path, StringComparison.OrdinalIgnoreCase)) return meta;
            node["SourcePath"] = "";
            node["SourceType"] = "local";
            node["ExternalOnly"] = false;
            return System.Text.Encoding.UTF8.GetBytes(node.ToJsonString());
        }
        catch { return meta; }
    }

    /// <summary>Returns the path of the rollback copy that holds the state from just before the restore.</summary>
    public static string Restore(NoteStore store, string backupPath, string appVersion)
    {
        Directory.CreateDirectory(store.Paths.Cache);
        var stage = Path.Combine(store.Paths.Cache, "restore-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try
        {
            // 1. work on a private copy, so the file cannot change between checking and using it
            var local = Path.Combine(stage, "source.nhub");
            File.Copy(backupPath, local, overwrite: false);
            var info = Inspect(local);
            if (!info.Valid) throw new InvalidDataException(info.Error);

            // 2. extract, verifying each file against the manifest as it is written
            var data = Path.Combine(stage, "data");
            Directory.CreateDirectory(data);
            var knownSources = store.AllNotes().Where(n => !string.IsNullOrWhiteSpace(n.SourcePath)).ToDictionary(n => n.Id, n => n.SourcePath, StringComparer.Ordinal);
            using (var zip = ZipFile.OpenRead(local))
            {
                var (manifest, error) = ValidateStructure(zip);
                if (manifest == null) throw new InvalidDataException(error);
                foreach (var f in manifest.Files)
                {
                    var bytes = ReadEntry(zip.GetEntry(f.Path)!);
                    if (!string.Equals(Hex(SHA256.HashData(bytes)), f.Sha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException($"Файл изменился при чтении: {f.Path}");
                    var target = Path.GetFullPath(Path.Combine(data, f.Path));
                    if (!target.StartsWith(Path.GetFullPath(data) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Небезопасный путь в архиве.");
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    if (f.Path.StartsWith("notes-meta/", StringComparison.Ordinal)) bytes = DropForeignSource(bytes, knownSources);
                    File.WriteAllBytes(target, bytes);
                }
            }
            foreach (var f in Folders) Directory.CreateDirectory(Path.Combine(data, f));

            // 3. under the exclusive lock: rollback copy of the CURRENT state, then swap
            return store.WithExclusiveAccess(() =>
            {
                Directory.CreateDirectory(store.Paths.Backups);
                var rollback = Path.Combine(store.Paths.Backups, "before-restore-" + DateTime.Now.ToString("yyyyMMdd_HHmmss_fff", CultureInfo.InvariantCulture) + "-" + Guid.NewGuid().ToString("N")[..6] + ".nhub");
                if (string.Equals(Path.GetFullPath(rollback), Path.GetFullPath(backupPath), StringComparison.OrdinalIgnoreCase)) throw new IOException("Точка возврата совпала с восстанавливаемой копией.");
                Create(store, rollback, appVersion);
                if (!Inspect(rollback).Valid) throw new IOException("Не удалось создать точку возврата перед восстановлением. Данные не изменены.");

                var root = store.Paths.DataV3;
                var tag = ".old-" + Guid.NewGuid().ToString("N")[..8];
                var moved = new List<(string From, string To)>();
                try
                {
                    foreach (var f in Folders)
                    {
                        var cur = Path.Combine(root, f);
                        if (Directory.Exists(cur)) { Directory.Move(cur, cur + tag); moved.Add((cur, cur + tag)); }
                        Directory.Move(Path.Combine(data, f), cur);
                    }
                    var pj = Path.Combine(root, "projects.json");
                    if (File.Exists(pj)) { File.Move(pj, pj + tag); moved.Add((pj, pj + tag)); }
                    var stagedProjects = Path.Combine(data, "projects.json");
                    if (File.Exists(stagedProjects)) File.Move(stagedProjects, pj);
                }
                catch
                {
                    foreach (var (from, to) in moved.AsEnumerable().Reverse())
                    {
                        try { if (Directory.Exists(from)) Directory.Delete(from, true); else if (File.Exists(from)) File.Delete(from); } catch { }
                        try { if (Directory.Exists(to)) Directory.Move(to, from); else if (File.Exists(to)) File.Move(to, from); } catch { }
                    }
                    foreach (var f in Folders) Directory.CreateDirectory(Path.Combine(root, f));
                    throw;
                }
                foreach (var (_, to) in moved) { try { if (Directory.Exists(to)) Directory.Delete(to, true); else if (File.Exists(to)) File.Delete(to); } catch { } }
                store.ReloadFromDisk();
                return rollback;
            });
        }
        finally { try { if (Directory.Exists(stage)) Directory.Delete(stage, true); } catch { } }
    }
}
