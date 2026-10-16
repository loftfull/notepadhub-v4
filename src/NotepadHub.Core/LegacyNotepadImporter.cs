using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;

namespace NotepadHub.Core;

public sealed class LegacyTabRecord
{
    public string SourceGuid { get; set; } = "";
    public string FilePath { get; set; } = "";
    public string Content { get; set; } = "";
    public DateTime? Timestamp { get; set; }
}

/// <summary>Reader for the binary "TabState" files that the Windows 11 Notepad app keeps (format identical to Notepad Hub 3.0.x).</summary>
public static class LegacyNotepadParser
{
    private static ulong ReadUleb(BinaryReader br)
    {
        ulong value = 0; var shift = 0;
        while (true)
        {
            var b = br.ReadByte();
            value |= (ulong)(b & 0x7F) << shift;
            if ((b & 0x80) == 0) return value;
            shift += 7;
            if (shift > 63) throw new InvalidDataException("ULEB128");
        }
    }

    private static void Need(BinaryReader br, long count)
    {
        if (count < 0 || br.BaseStream.Length - br.BaseStream.Position < count) throw new EndOfStreamException();
    }

    public static LegacyTabRecord Parse(Stream stream, string fileNameWithoutExtension)
    {
        var r = new LegacyTabRecord { SourceGuid = Guid.TryParse(fileNameWithoutExtension, out var g) ? g.ToString("N") : fileNameWithoutExtension };
        using var br = new BinaryReader(stream, Encoding.UTF8, leaveOpen: true);
        Need(br, 2);
        if (br.ReadByte() != 0x4E || br.ReadByte() != 0x50) throw new InvalidDataException("NP header");
        ReadUleb(br);
        var type = ReadUleb(br);
        byte[] baseContent;
        if (type == 0)
        {
            Need(br, 1); br.ReadByte(); ReadUleb(br); ReadUleb(br); Need(br, 3); br.ReadBytes(3);
            var opt = ReadUleb(br); Need(br, (long)opt); br.ReadBytes((int)opt);
            var chars = ReadUleb(br); var len = checked((int)chars * 2); Need(br, len + 5);
            baseContent = br.ReadBytes(len); br.ReadByte(); br.ReadBytes(4);
        }
        else if (type == 1)
        {
            var pathChars = ReadUleb(br); var pathLen = checked((int)pathChars * 2); Need(br, pathLen);
            r.FilePath = Encoding.Unicode.GetString(br.ReadBytes(pathLen)); ReadUleb(br); Need(br, 2);
            br.ReadByte(); br.ReadByte(); var ts = ReadUleb(br);
            if (ts > 0) { try { r.Timestamp = DateTime.FromFileTime((long)ts); } catch { } }
            Need(br, 34); br.ReadBytes(34); ReadUleb(br); ReadUleb(br); Need(br, 3); br.ReadBytes(3);
            var opt = ReadUleb(br); Need(br, (long)opt); br.ReadBytes((int)opt);
            var chars = ReadUleb(br); var len = checked((int)chars * 2); Need(br, len + 5);
            baseContent = br.ReadBytes(len); br.ReadByte(); br.ReadBytes(4);
        }
        else throw new InvalidDataException("Unsupported tab type " + type);

        var text = new StringBuilder(Encoding.Unicode.GetString(baseContent));
        while (br.BaseStream.Position < br.BaseStream.Length)
        {
            var start = br.BaseStream.Position;
            try
            {
                var cursor = ReadUleb(br); var deletion = ReadUleb(br); var addition = ReadUleb(br);
                var addBytes = checked((int)addition * 2); Need(br, addBytes + 4);
                var added = Encoding.Unicode.GetString(br.ReadBytes(addBytes)); br.ReadBytes(4);
                var pos = cursor > int.MaxValue ? text.Length : (int)cursor; pos = Math.Max(0, Math.Min(text.Length, pos));
                var del = deletion > int.MaxValue ? 0 : (int)deletion; del = Math.Max(0, Math.Min(del, text.Length - pos));
                if (del > 0) text.Remove(pos, del);
                if (added.Length > 0) text.Insert(pos, added);
            }
            catch { br.BaseStream.Position = start; break; }
        }
        r.Content = text.ToString();
        return r;
    }
}

public static class LegacyNotepadImporter
{
    public const long MaxZipBytes = 50L * 1024 * 1024;
    public const long MaxTotalTabBytes = 100L * 1024 * 1024;
    public const long MaxTabBytes = 8L * 1024 * 1024;
    private static readonly Regex MainTab = new(@"(^|[\\/])TabState[\\/]([^\\/]+)\.bin$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex SideFile = new(@"\.[01]\.bin$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// Imports a snapshot ZIP that contains a TabState folder. Notes are matched by the Notepad tab id, so importing the
    /// same snapshot twice updates instead of duplicating. Paths stored inside the snapshot are NEVER opened.
    /// </summary>
    public static ImportResult ImportZip(NoteStore store, string zipPath)
    {
        var result = new ImportResult();
        var info = new FileInfo(zipPath);
        if (!info.Exists) throw new FileNotFoundException("Файл снимка не найден.");
        if (info.Length > MaxZipBytes) throw new InvalidDataException("Снимок больше 50 МБ.");

        using var zip = ZipFile.OpenRead(zipPath);
        var tabs = zip.Entries.Where(e => MainTab.IsMatch(e.FullName) && !SideFile.IsMatch(e.Name)).ToList();
        if (tabs.Count == 0) throw new InvalidDataException("В архиве не найдена папка TabState с файлами вкладок.");

        long total = 0;
        foreach (var e in tabs)
        {
            var guid = Path.GetFileNameWithoutExtension(e.Name);
            if (e.Length > MaxTabBytes) { result.Skipped++; result.Warnings.Add($"Вкладка {Short(guid)} пропущена: больше 8 МБ."); continue; }
            total += e.Length;
            if (total > MaxTotalTabBytes) throw new InvalidDataException("Суммарный размер вкладок больше 100 МБ.");
            LegacyTabRecord tab;
            try
            {
                using var ms = new MemoryStream();
                using (var s = e.Open()) s.CopyTo(ms);
                ms.Position = 0;
                tab = LegacyNotepadParser.Parse(ms, guid);
            }
            catch (Exception ex) { result.Skipped++; result.Warnings.Add($"Вкладка {Short(guid)} пропущена: {ex.Message}"); continue; }

            var content = tab.Content ?? "";
            if (content.Length > NoteStore.EditorLimitChars) { result.Skipped++; result.Warnings.Add($"Вкладка {Short(guid)} пропущена: слишком длинный текст."); continue; }
            var title = !string.IsNullOrWhiteSpace(tab.FilePath) ? Path.GetFileNameWithoutExtension(tab.FilePath) : NoteStore.AutoTitle(content);
            if (string.IsNullOrWhiteSpace(title)) title = "Новая заметка";

            var existing = store.FindByLegacyGuid(tab.SourceGuid);
            if (existing == null)
            {
                var n = new NoteMeta
                {
                    Id = Guid.NewGuid().ToString("N"), ProjectId = "import-windows", LegacySourceGuid = tab.SourceGuid, Title = title,
                    SourcePath = tab.FilePath ?? "", SourceType = string.IsNullOrWhiteSpace(tab.FilePath) ? "local" : "file",
                    ContentType = NoteStore.DetectContentType(tab.FilePath, content),
                    UpdatedUtc = (tab.Timestamp ?? e.LastWriteTime.UtcDateTime).ToUniversalTime().ToString("o", CultureInfo.InvariantCulture),
                };
                store.AddImported(n, content);
                result.Created++;
                if (content.Length == 0 && !string.IsNullOrWhiteSpace(tab.FilePath)) result.EmptyWithExternalFile++;
            }
            else if (content.Length > 0 && store.UpdateImportedContent(existing, content, title, tab.FilePath ?? ""))
            {
                result.Updated++;
            }
        }
        return result;
    }

    private static string Short(string s) => s.Length > 8 ? s[..8] : s;
}
