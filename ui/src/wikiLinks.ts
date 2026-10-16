import { blocksToText, type LooseBlock } from "./textFormat";

/**
 * [[Название]] links between notes (Obsidian-style). Links live as plain text in the note, so the .txt file stays
 * authoritative and readable by 3.0.5; nothing about the storage format changes. Matching is by note title,
 * case-insensitive, whitespace-collapsed. An optional alias is allowed: [[Название|подпись]].
 */
export const WIKILINK_RE = /\[\[([^\[\]\n|]{1,120}?)(?:\|([^\[\]\n]{1,120}))?\]\]/g;

export const normTitle = (value: string) => value.replace(/[\[\]|]/g, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase("ru");   // brackets and pipes cannot appear inside [[ ]], so they are neutral on both sides

export type LinkRef = { target: string; snippet: string };

const SNIPPET = 90;
const snippetAround = (text: string, index: number, length: number) => {
  const start = Math.max(0, index - SNIPPET / 2);
  const end = Math.min(text.length, index + length + SNIPPET / 2);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
};

export function extractLinks(text: string): LinkRef[] {
  const found: LinkRef[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(WIKILINK_RE)) {
    const target = match[1].replace(/\s+/g, " ").trim();
    const key = normTitle(target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    found.push({ target, snippet: snippetAround(text, match.index ?? 0, match[0].length) });
  }
  return found;
}

// per-note cache keyed by the blocks array: the editor replaces only the edited note's array, so typing re-parses one note
const cache = new WeakMap<object, LinkRef[]>();
export function linksOfBlocks(blocks: LooseBlock[] | undefined): LinkRef[] {
  if (!blocks) return [];
  const hit = cache.get(blocks);
  if (hit) return hit;
  const links = extractLinks(blocksToText(blocks));
  cache.set(blocks, links);
  return links;
}

export type DocLike = { id: string; title: string; deletedAt?: unknown };
export type LinkIndex = {
  byTitle: Map<string, string>;
  outgoing: (id: string) => Array<LinkRef & { id: string | null }>;
  backlinks: (id: string) => Array<{ id: string; title: string; snippet: string }>;
};

export function buildLinkIndex(docs: DocLike[], contents: Record<string, LooseBlock[]>): LinkIndex {
  const live = docs.filter((doc) => !doc.deletedAt);
  const byTitle = new Map<string, string>();
  for (const doc of live) { const key = normTitle(doc.title); if (key && !byTitle.has(key)) byTitle.set(key, doc.id); }
  const incoming = new Map<string, Array<{ id: string; title: string; snippet: string }>>();
  for (const doc of live) {
    for (const link of linksOfBlocks(contents[doc.id])) {
      const targetId = byTitle.get(normTitle(link.target));
      if (!targetId || targetId === doc.id) continue;
      const list = incoming.get(targetId) ?? [];
      list.push({ id: doc.id, title: doc.title, snippet: link.snippet });
      incoming.set(targetId, list);
    }
  }
  return {
    byTitle,
    outgoing: (id) => linksOfBlocks(contents[id]).map((link) => ({ ...link, id: byTitle.get(normTitle(link.target)) ?? null })),
    backlinks: (id) => incoming.get(id) ?? [],
  };
}

export const wikiLinkText = (title: string) => `[[${title.replace(/[\[\]|\n]/g, " ").replace(/\s+/g, " ").trim()}]]`;

/** [[old]] → [[new]] in one text, keeping an alias ([[old|подпись]]). */
export function renameLinkInText(text: string, oldTitle: string, newTitle: string): { text: string; count: number } {
  const key = normTitle(oldTitle);
  const safe = newTitle.replace(/[\[\]|\n]/g, " ").replace(/\s+/g, " ").trim();   // a title with brackets must not break the link syntax
  if (!safe) return { text, count: 0 };
  let count = 0;
  const next = text.replace(WIKILINK_RE, (match, target: string, alias: string | undefined) => {
    if (normTitle(target) !== key) return match;
    count++;
    return `[[${safe}${alias !== undefined ? "|" + alias : ""}]]`;
  });
  return { text: next, count };
}

type InlineLike = { type?: string; text?: string; content?: unknown };
/**
 * Rewrites links to a renamed note inside BlockNote blocks (text runs, link labels, nested children).
 * Returns the same array when nothing changed. A link split over several styled runs is left alone on purpose.
 */
export function renameLinkInBlocks<B extends { content?: unknown; children?: unknown }>(blocks: B[], oldTitle: string, newTitle: string): { blocks: B[]; count: number } {
  let count = 0;
  const inline = (content: unknown): unknown => {
    if (typeof content === "string") { const r = renameLinkInText(content, oldTitle, newTitle); count += r.count; return r.text; }
    if (!Array.isArray(content)) return content;
    return content.map((item: InlineLike) => {
      if (item && item.type === "text" && typeof item.text === "string") { const r = renameLinkInText(item.text, oldTitle, newTitle); count += r.count; return r.count ? { ...item, text: r.text } : item; }
      if (item && item.type === "link" && Array.isArray(item.content)) return { ...item, content: inline(item.content) };
      return item;
    });
  };
  const walk = (list: B[]): B[] => list.map((block) => {
    const content = inline(block.content);
    const children = Array.isArray(block.children) ? walk(block.children as B[]) : block.children;
    return { ...block, content, children } as B;
  });
  const next = walk(blocks);
  return count === 0 ? { blocks, count: 0 } : { blocks: next, count };
}
