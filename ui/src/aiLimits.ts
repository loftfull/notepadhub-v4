/** Mirror of src/NotepadHub.Core/Ai/AiLimits.cs: the page uses it only to show the cost estimate; the host decides the real limits. */
export const tokensOf = (chars: number) => Math.ceil(chars / 2);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function outputTokensFor(operation: string, contextChars: number): number {
  const input = tokensOf(contextChars);
  switch (operation) {
    case "analyze": return 1536;
    case "summarize": return 600;
    case "structure": return clamp(Math.trunc(input * 1.4) + 200, 1536, 6000);
    case "shorten": return clamp(input + 64, 256, 4096);
    case "expand": return clamp(input * 2 + 128, 512, 4096);
    case "continue": return clamp(input + 128, 512, 2048);
    case "proofread": case "rewrite": return clamp(Math.trunc(input * 1.3) + 64, 256, 4096);
    default: return clamp(Math.trunc(input * 1.5), 512, 3072);
  }
}
