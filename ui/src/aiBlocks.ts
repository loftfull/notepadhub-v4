import type { PartialBlock } from "@blocknote/core";
import { textToBlocks } from "./textFormat";

/** Markdown from the AI back into blocks: tables and pictures go through our own reader (it understands the pipe rows the AI was shown), the rest through BlockNote's Markdown parser. */
export function parseAiBlocks(parseMarkdown: (markdown: string) => PartialBlock[], text: string): PartialBlock[] {
  const rich = (line: string) => line.startsWith("| ") || /^!\[[^\]\n]*\]\(\S+\)$/.test(line);
  const out: PartialBlock[] = [];
  const all = text.split("\n");
  let i = 0;
  while (i < all.length) {
    const kind = rich(all[i]);
    let j = i;
    while (j < all.length && rich(all[j]) === kind) j++;
    const chunk = all.slice(i, j).join("\n");
    if (kind) out.push(...(textToBlocks(chunk) as PartialBlock[]));
    else if (chunk.trim()) out.push(...parseMarkdown(chunk));
    i = j;
  }
  // a model answer may only point at pictures that are already stored next to the notes; any other address would be loaded by the page and could carry note text out
  return out.map((block) => {
    const url = block.type === "image" ? String((block.props as { url?: string } | undefined)?.url ?? "") : "";
    if (block.type !== "image" || url.startsWith("https://assets.notepadhub.local/")) return block;
    const alt = String((block.props as { caption?: string; name?: string } | undefined)?.caption || (block.props as { name?: string } | undefined)?.name || "").trim();
    return { type: "paragraph", content: alt ? `[${alt}]` : "" } as PartialBlock;
  });
}
