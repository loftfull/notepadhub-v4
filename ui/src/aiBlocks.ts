import type { PartialBlock } from "@blocknote/core";
import { textToBlocks } from "./textFormat";

const ASSET_HOST = "assets.notepadhub.local";
const MEDIA = new Set(["image", "video", "audio", "file"]);

/** Only an address of a picture already stored next to the notes is allowed: https and exactly the assets host. */
export function isOwnAssetUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === ASSET_HOST && u.username === "" && u.password === "";
  } catch { return false; }
}

type Loose = { type?: string; props?: Record<string, unknown>; children?: Loose[]; content?: unknown };

/** Every media block at any depth (lists, quotes, table cells) with a foreign address becomes plain text: the page would load it and could carry note text out. */
function sanitize(block: Loose): Loose {
  const children = Array.isArray(block.children) ? block.children.map(sanitize) : block.children;
  if (block.type && MEDIA.has(block.type)) {
    const props = block.props ?? {};
    if (!isOwnAssetUrl(String(props.url ?? ""))) {
      const alt = String(props.caption || props.name || "").trim();
      return { type: "paragraph", content: alt ? `[${alt}]` : "", ...(children ? { children } : {}) };
    }
  }
  return children === block.children ? block : { ...block, children };
}

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
  return out.map((block) => sanitize(block as Loose) as PartialBlock);
}
