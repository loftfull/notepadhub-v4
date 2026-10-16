namespace NotepadHub.Core.Ai;

/// <summary>
/// Size and sampling rules that decide whether an AI answer is complete and faithful.
/// A fixed 512-token answer cap used to cut longer rewrites in the middle of a sentence, and a fixed 8192-token window
/// silently dropped the start of a long note on the local model, so both now follow the size of the request.
/// The same numbers are mirrored in ui/src/aiLimits.ts (a test on each side pins the same values).
/// </summary>
public static class AiLimits
{
    /// <summary>Russian text is about 2 characters per token on small models: counting 2 keeps the estimate on the safe (large) side.</summary>
    public static int Tokens(int chars) => (int)Math.Ceiling(chars / 2.0);

    public static int OutputTokens(string operation, int contextChars)
    {
        var input = Tokens(contextChars);
        return operation switch
        {
            "analyze" => 1536,
            "summarize" => 600,
            "structure" => Math.Clamp((int)(input * 1.4) + 200, 1536, 6000),
            "shorten" => Math.Clamp(input + 64, 256, 4096),
            "expand" => Math.Clamp(input * 2 + 128, 512, 4096),
            "continue" => Math.Clamp(input + 128, 512, 2048),
            "proofread" or "rewrite" => Math.Clamp((int)(input * 1.3) + 64, 256, 4096),
            _ => Math.Clamp((int)(input * 1.5), 512, 3072),     // custom instruction
        };
    }

    /// <summary>Low for tasks that must not invent anything, higher only where new wording is the point.</summary>
    public static double Temperature(string operation) => operation switch
    {
        "proofread" => 0.0,
        "analyze" or "structure" => 0.1,
        "shorten" or "summarize" => 0.2,
        "rewrite" or "custom" => 0.3,
        "expand" => 0.4,
        "continue" => 0.6,
        _ => 0.2,
    };

    /// <summary>Local model window: the whole prompt and the whole answer must fit, in steps of 2048, between 4096 and 32768 tokens.</summary>
    public static int NumCtx(int promptChars, int maxOut)
    {
        var need = Tokens(promptChars) + maxOut + 256;
        return Math.Clamp((need + 2047) / 2048 * 2048, 4096, 32768);
    }

    /// <summary>
    /// Sampling for editing. Several current models ship a Modelfile with presence_penalty 1.5 (tuned for long free-form chat):
    /// at temperature 0 it forbids the model to repeat the words it is asked to keep, so proofreading and rewriting drift from the text.
    /// The penalties are set explicitly to neutral values for every request.
    /// </summary>
    public static Dictionary<string, object> OllamaOptions(double temperature, int numCtx, int numPredict) => new()
    {
        ["temperature"] = temperature,
        ["top_p"] = 0.9,
        ["top_k"] = 40,
        ["presence_penalty"] = 0.0,
        ["frequency_penalty"] = 0.0,
        ["repeat_penalty"] = 1.0,
        ["num_ctx"] = numCtx,
        ["num_predict"] = numPredict,
    };
}
