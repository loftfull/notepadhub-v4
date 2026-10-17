using System.Security.Cryptography;
using System.Text;

namespace NotepadHub.Core;

/// <summary>The password is wrong.</summary>
public sealed class WrongPasswordException : InvalidOperationException
{
    public WrongPasswordException() : base("Неверный пароль.") { }
}

/// <summary>The note is protected by a password and has not been unlocked in this session.</summary>
public sealed class NoteLockedException : InvalidOperationException
{
    public NoteLockedException() : base("Заметка защищена паролем. Введите пароль, чтобы открыть её.") { }
}

/// <summary>
/// Note passwords. A protected note keeps its text, its blocks and its history snapshots in files that hold
/// "NHENC1:" + base64(nonce | tag | ciphertext), AES-256-GCM. The key comes from the password with PBKDF2-SHA256
/// (600 000 rounds, a salt of its own per note, kept in the note metadata together with a check value) and lives
/// in memory only: closing the program, "Заблокировать" or the idle timer forget it. There is no recovery.
/// Title, tags and project of the note stay readable (the list and the search need them).
/// </summary>
public sealed partial class NoteStore
{
    private const string EncPrefix = "NHENC1:";
    private const int KdfRounds = 600_000;
    private const int MinPasswordLength = 4;
    private readonly Dictionary<string, byte[]> _keys = new();

    public bool IsUnlocked(string id) { lock (_sync) return _keys.ContainsKey(id); }
    private bool IsProtectedNote(string id) { lock (_sync) return _notes.Any(n => n.Id == id && n.IsProtected); }

    private static byte[] DeriveKey(string password, string saltBase64) =>
        Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), Convert.FromBase64String(saltBase64), KdfRounds, HashAlgorithmName.SHA256, 32);

    private static string Encrypt(byte[] key, string plain)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var data = Encoding.UTF8.GetBytes(plain);
        var cipher = new byte[data.Length];
        var tag = new byte[16];
        using (var aes = new AesGcm(key, 16)) aes.Encrypt(nonce, data, cipher, tag);
        var all = new byte[12 + 16 + cipher.Length];
        nonce.CopyTo(all, 0); tag.CopyTo(all, 12); cipher.CopyTo(all, 28);
        return EncPrefix + Convert.ToBase64String(all);
    }

    private static string Decrypt(byte[] key, string stored)
    {
        var all = Convert.FromBase64String(stored[EncPrefix.Length..].Trim());
        if (all.Length < 28) throw new CryptographicException("Файл повреждён.");
        var data = new byte[all.Length - 28];
        using (var aes = new AesGcm(key, 16)) aes.Decrypt(all.AsSpan(0, 12), all.AsSpan(28), all.AsSpan(12, 16), data);
        return Encoding.UTF8.GetString(data);
    }

    /// <summary>Encrypts for a protected note (the key must be in the session), passes a plain note's text through.</summary>
    private string Protect(string id, string plain)
    {
        lock (_sync)
        {
            if (!_notes.Any(n => n.Id == id && n.IsProtected)) return plain;
            if (!_keys.TryGetValue(id, out var key)) throw new NoteLockedException();
            return Encrypt(key, plain);
        }
    }

    /// <summary>Decrypts what <see cref="Protect"/> wrote; text without the prefix is plain (a stop while locking left it so).</summary>
    private string Unprotect(string id, string stored)
    {
        if (!stored.StartsWith(EncPrefix, StringComparison.Ordinal)) return stored;
        byte[]? key;
        lock (_sync) _keys.TryGetValue(id, out key);
        if (key == null) throw new NoteLockedException();
        try { return Decrypt(key, stored); }
        catch (CryptographicException) { throw new InvalidDataException("Не удалось расшифровать файл заметки: он изменён или повреждён."); }
    }

    private IEnumerable<string> HistoryFiles(string id)
    {
        var dir = Paths.HistoryDir(id);
        return Directory.Exists(dir) ? Directory.GetFiles(dir, "*.txt") : Array.Empty<string>();
    }

    /// <summary>Sets a password on a note. The text, the blocks and every history version are encrypted; the note stays unlocked in this session.</summary>
    public NoteMeta SetPassword(string id, string password)
    {
        password ??= "";
        if (password.Length < MinPasswordLength) throw new ArgumentException($"Пароль короче {MinPasswordLength} знаков.");
        var salt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        var key = DeriveKey(password, salt);   // 600 000 rounds: not under the lock, the window must not freeze
        lock (_sync)
        {
            var n = _notes.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.");
            if (n.IsProtected) throw new InvalidOperationException("У заметки уже есть пароль.");
            if (IsExternalOnly(n)) throw new InvalidOperationException("Этот файл не загружен в редактор: пароль поставить нельзя.");
            if (Settings.WriteThroughIds.Contains(id)) throw new InvalidOperationException("Заметка сохраняется в файл на диске: пароль на неё поставить нельзя. Сначала отключите сохранение в файл.");
            var content = ReadContent(id);
            var blocks = File.Exists(Paths.BlocksPath(id)) ? File.ReadAllText(Paths.BlocksPath(id), Encoding.UTF8) : null;
            var history = HistoryFiles(id).Select(f => (file: f, text: ReadTextFile(f))).ToList();
            // metadata first: if the program stops half way, plain files under a protected note are still read (see Unprotect) and encrypted on the next save
            n.LockSalt = salt; n.LockCheck = Encrypt(key, "nh4"); n.IsProtected = true; n.UpdatedUtc = Now();
            SaveMeta(n);
            _keys[id] = key;
            JsonIO.WriteAllTextAtomic(Paths.ContentPath(id), Encrypt(key, content));
            if (blocks != null) JsonIO.WriteAllTextAtomic(Paths.BlocksPath(id), Encrypt(key, blocks));
            foreach (var (file, text) in history) JsonIO.WriteAllTextAtomic(file, Encrypt(key, text));
            _search[id] = IndexKey(n, "");
            return n.Clone();
        }
    }

    private static byte[] CheckPassword(NoteMeta n, string password)
    {
        if (!n.IsProtected) throw new InvalidOperationException("У заметки нет пароля.");
        var key = DeriveKey(password ?? "", n.LockSalt);
        try { if (Decrypt(key, n.LockCheck) == "nh4") return key; } catch (CryptographicException) { /* wrong password */ }
        throw new WrongPasswordException();
    }

    /// <summary>Checks the password and keeps the key for this session.</summary>
    public NoteMeta UnlockNote(string id, string password)
    {
        NoteMeta n;
        lock (_sync) n = (_notes.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.")).Clone();
        var key = CheckPassword(n, password);
        lock (_sync) _keys[id] = key;
        return n;
    }

    /// <summary>Forgets the key of one note, or of all of them (id empty).</summary>
    public void RelockNotes(string? id = null)
    {
        lock (_sync)
        {
            if (string.IsNullOrEmpty(id)) { foreach (var k in _keys.Values) CryptographicOperations.ZeroMemory(k); _keys.Clear(); }
            else if (_keys.Remove(id, out var key)) CryptographicOperations.ZeroMemory(key);
        }
    }

    public int UnlockedCount { get { lock (_sync) return _keys.Count; } }

    /// <summary>Takes the password off: the files become plain again.</summary>
    public NoteMeta RemovePassword(string id, string password)
    {
        NoteMeta snapshot;
        lock (_sync) snapshot = (_notes.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.")).Clone();
        var key = CheckPassword(snapshot, password);   // slow: outside the lock
        lock (_sync)
        {
            var n = _notes.FirstOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("Заметка не найдена.");
            _keys[id] = key;
            var content = ReadContent(id);
            var blocks = File.Exists(Paths.BlocksPath(id)) ? Unprotect(id, File.ReadAllText(Paths.BlocksPath(id), Encoding.UTF8)) : null;
            var history = HistoryFiles(id).Select(f => (file: f, text: Unprotect(id, ReadTextFile(f)))).ToList();
            // plain files first, the metadata last: a stop half way leaves plain files under a protected note, which is readable
            JsonIO.WriteAllTextAtomic(Paths.ContentPath(id), content);
            if (blocks != null) JsonIO.WriteAllTextAtomic(Paths.BlocksPath(id), blocks);
            foreach (var (file, text) in history) JsonIO.WriteAllTextAtomic(file, text);
            n.IsProtected = false; n.LockSalt = ""; n.LockCheck = "";
            n.UpdatedUtc = Now();
            SaveMeta(n);
            if (_keys.Remove(id, out var forgotten)) CryptographicOperations.ZeroMemory(forgotten);
            _search[id] = IndexKey(n, content);
            return n.Clone();
        }
    }
}
