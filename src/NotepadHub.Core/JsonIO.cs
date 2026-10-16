using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace NotepadHub.Core;

public static class JsonIO
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = null,
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        // 3.0.x serialised double.NaN (window position) as a bare NaN literal.
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString
                         | System.Text.Json.Serialization.JsonNumberHandling.AllowNamedFloatingPointLiterals,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    public static T? Read<T>(string path) where T : class
    {
        if (!File.Exists(path)) return null;
        return JsonSerializer.Deserialize<T>(File.ReadAllText(path, Encoding.UTF8), Options);
    }

    public static void WriteAtomic(string path, object value) =>
        WriteAllTextAtomic(path, JsonSerializer.Serialize(value, value.GetType(), Options));

    /// <summary>Write to a temp file then swap it in, so a crash never leaves a half-written note.</summary>
    public static void WriteAllTextAtomic(string path, string text) =>
        WriteAllBytesAtomic(path, new UTF8Encoding(false).GetBytes(text));

    /// <summary>
    /// Temp file in the same folder, flushed to disk, then swapped in. An existing file is replaced with File.Replace so its
    /// permissions and creation time survive (this is also used for the user's own files). The temp file is removed on failure.
    /// </summary>
    public static void WriteAllBytesAtomic(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + "." + Environment.ProcessId + "." + Guid.NewGuid().ToString("N")[..6] + ".tmp";
        try
        {
            using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                fs.Write(bytes, 0, bytes.Length);
                fs.Flush(true);                   // reach the disk before the swap, so a power cut cannot leave an empty file
            }
            if (File.Exists(path)) File.Replace(tmp, path, null, ignoreMetadataErrors: true);
            else File.Move(tmp, path);
        }
        catch
        {
            try { File.Delete(tmp); } catch { /* best effort */ }
            throw;
        }
    }
}

