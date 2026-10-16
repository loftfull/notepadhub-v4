using System.Text.RegularExpressions;

namespace NotepadHub.Core.Ai;

/// <summary>
/// Blocks sending text that looks like it contains secrets to an outside service. A warning is not enough:
/// the text leaves the computer before the user ever sees the answer. Local Ollama is exempt.
/// This is a heuristic filter, not a guarantee: the cloud consent dialog still tells the user exactly what leaves.
/// </summary>
public static class SecretScanner
{
    // a name that contains one of these words, followed by ":" "=" "—" etc. and a value, optionally quoted:
    // password: x, "apiKey": "x", DB_PASSWORD=x, GITHUB_TOKEN=x, пароль — x
    private const string Words = @"(?:password|passwd|pwd|пароль|token|токен|secret|секрет|api[_\- ]?key|apikey|access[_\- ]?key|private[_\- ]?key|credentials?)";

    private static readonly (string Kind, Regex Pattern)[] Rules =
    {
        ("ключ API (sk-…)", new(@"\bsk-[A-Za-z0-9_\-]{20,}", RegexOptions.Compiled)),
        ("ключ платёжного сервиса (sk_live/sk_test)", new(@"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}", RegexOptions.Compiled)),
        ("ключ AWS", new(@"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", RegexOptions.Compiled)),
        ("ключ Google (AIza…)", new(@"\bAIza[0-9A-Za-z_\-]{35,}", RegexOptions.Compiled)),
        ("токен GitHub", new(@"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})", RegexOptions.Compiled)),
        ("токен Slack", new(@"\bxox[abprs]-[A-Za-z0-9\-]{10,}", RegexOptions.Compiled)),
        ("приватный ключ", new(@"-----BEGIN [A-Z ]*PRIVATE KEY-----", RegexOptions.Compiled)),
        ("публичный SSH-ключ", new(@"\bssh-(?:rsa|ed25519|dss)\s+AAAA[0-9A-Za-z+/=]{20,}", RegexOptions.Compiled)),
        ("токен JWT", new(@"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}", RegexOptions.Compiled)),
        ("заголовок Authorization", new(@"(?i)\bauthorization\s*[:=]\s*[""']?(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=\-]{16,}", RegexOptions.Compiled)),
        ("Bearer-токен", new(@"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{24,}", RegexOptions.Compiled)),
        ("адрес с логином и паролем", new(@"\b[a-z][a-z0-9+.\-]*://[^/\s:@]+:[^/\s@]{3,}@", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("пароль в свободной форме", new(@"(?i)\b(?:парол[ьяеюи]\w*|password|passwd)\b[^\n]{0,40}?[\s:=\-–—]+(?=[^\s]*\d)[^\s""',;]{6,}", RegexOptions.Compiled)),
        ("пароль или токен в тексте", new(@"(?i)[\w.\-]*" + Words + @"[\w.\-]*[""']?\s*(?:[:=]|=>|[—–])\s*[""']?[^\s""',;]{6,}", RegexOptions.Compiled)),
    };

    public static IReadOnlyList<string> Find(string text)
    {
        var kinds = new List<string>();
        foreach (var (kind, pattern) in Rules)
            if (pattern.IsMatch(text)) kinds.Add(kind);
        return kinds;
    }
}

