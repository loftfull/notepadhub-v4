using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace NotepadHub.Core.Ai;

/// <summary>One installed Ollama model as /api/tags reports it.</summary>
public sealed record InstalledModel(string Name, long SizeBytes, string Family, double ParamsBillions);

public sealed record HiddenModel(string Name, string Reason);

/// <summary>
/// Decides which installed models are fit for editing the user's notes, and which one is the best default.
/// Hidden on purpose: cloud models (an Ollama alias without local weights sends the text to ollama.com while the app says
/// "stays on this computer"), embedding models, code and base models, outdated families and models too small to edit
/// Russian text. A weak or old model is still offered when nothing better is installed.
/// </summary>
public static class LocalModelCatalog
{
    private static readonly Regex Cloud = new(@"(?:^|[-/:])cloud(?:$|[-/:])", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Embedding = new(@"embed|bert|bge-|minilm|e5-|gte-|rerank", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Code = new(@"coder|codellama|starcoder|codegemma|autocomplete|(?:^|[-:])base(?:$|[-:])", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex OldFamily = new(@"^(?:qwen|qwen2|qwen2\.5|llama2|llama3|mistral|gemma|gemma2|phi|phi3|tinyllama|vicuna|orca|falcon|stablelm|starling|zephyr|yi|solar)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>Generation weight by family: newer general-purpose families first.</summary>
    private static int FamilyWeight(string family) => family.ToLowerInvariant() switch
    {
        "qwen35" or "qwen3.5" or "gemma4" => 10,
        "qwen3" or "qwen3moe" or "gemma3" or "gemma3n" or "llama4" or "phi4" => 9,
        "llama3.3" or "mistral3" or "mistral-small" or "granite" or "granite4" => 8,
        "llama3.2" or "llama3.1" => 7,
        _ => 5,
    };

    public static (List<InstalledModel> Usable, List<HiddenModel> Hidden) Classify(IEnumerable<InstalledModel> installed)
    {
        var usable = new List<InstalledModel>();
        var hidden = new List<HiddenModel>();
        foreach (var m in installed)
        {
            if (m.SizeBytes == 0 || Cloud.IsMatch(m.Name)) hidden.Add(new(m.Name, "облачная: текст уходил бы с компьютера"));
            else if (Embedding.IsMatch(m.Name) || Embedding.IsMatch(m.Family)) hidden.Add(new(m.Name, "модель для поиска, не умеет править текст"));
            else if (Code.IsMatch(m.Name)) hidden.Add(new(m.Name, "для кода или автодополнения, не для заметок"));
            else usable.Add(m);
        }
        // a machine with only code models still gets an assistant (last resort); cloud and embedding models never do
        if (usable.Count == 0)
        {
            var lastResort = hidden.Where(h => h.Reason.StartsWith("для кода", StringComparison.Ordinal)).Select(h => h.Name).ToHashSet();
            usable = installed.Where(m => lastResort.Contains(m.Name)).ToList();
            hidden.RemoveAll(h => lastResort.Contains(h.Name));
        }
        // outdated families and tiny models go away only when something better is left to use
        var modern = usable.Where(m => !OldFamily.IsMatch(m.Family)).ToList();
        if (modern.Count > 0 && modern.Count < usable.Count)
        {
            foreach (var m in usable.Except(modern)) hidden.Add(new(m.Name, "устаревшее поколение, есть новее"));
            usable = modern;
        }
        var capable = usable.Where(m => m.ParamsBillions <= 0 || m.ParamsBillions >= 3).ToList();
        if (capable.Count > 0 && capable.Count < usable.Count)
        {
            foreach (var m in usable.Except(capable)) hidden.Add(new(m.Name, "слишком слабая для правки текста (меньше 3 млрд параметров)"));
            usable = capable;
        }
        // the same weights under several names: keep one entry (the best, then the shortest name), hide the aliases
        var seen = new HashSet<string>();
        var unique = new List<InstalledModel>();
        foreach (var m in usable.OrderByDescending(Score).ThenBy(m => m.Name.Length))
        {
            var key = m.Family.Length > 0 && m.SizeBytes > 0 ? $"{m.Family}|{m.SizeBytes}" : "name:" + m.Name;
            if (seen.Add(key)) unique.Add(m); else hidden.Add(new(m.Name, "дубликат других весов под другим именем"));
        }
        return (unique, hidden);
    }

    public static double Score(InstalledModel m) => FamilyWeight(m.Family) * 100 + Math.Min(m.ParamsBillions <= 0 ? 4 : m.ParamsBillions, 14);

    public static List<InstalledModel> Parse(string tagsJson)
    {
        var list = new List<InstalledModel>();
        using var doc = JsonDocument.Parse(tagsJson);
        if (!doc.RootElement.TryGetProperty("models", out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
        foreach (var m in arr.EnumerateArray())
        {
            if (!m.TryGetProperty("name", out var n) || n.ValueKind != JsonValueKind.String) continue;
            var size = m.TryGetProperty("size", out var s) && s.ValueKind == JsonValueKind.Number && s.TryGetInt64(out var sz) ? sz : -1;   // -1: not reported (unknown), 0: no local weights = a cloud alias
            var family = ""; var p = 0.0;
            if (m.TryGetProperty("details", out var d) && d.ValueKind == JsonValueKind.Object)
            {
                family = d.TryGetProperty("family", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString() ?? "" : "";
                if (d.TryGetProperty("parameter_size", out var ps) && ps.ValueKind == JsonValueKind.String)
                {
                    var mt = Regex.Match(ps.GetString() ?? "", @"([\d.]+)\s*([MBT])", RegexOptions.IgnoreCase);
                    if (mt.Success && double.TryParse(mt.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var v))
                        p = char.ToUpperInvariant(mt.Groups[2].Value[0]) switch { 'M' => v / 1000, 'T' => v * 1000, _ => v };
                }
            }
            list.Add(new InstalledModel(n.GetString()!, size, family, p));
        }
        return list;
    }
}
