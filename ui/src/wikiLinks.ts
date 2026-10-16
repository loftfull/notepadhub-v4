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

export type DocLike = { id: string; title: string; deletedAt?: unknown; lastOpenedAt?: number; writeThrough?: boolean };
export type LinkIndex = {
  byTitle: Map<string, string>;
  outgoing: (id: string) => Array<LinkRef & { id: string | null }>;
  backlinks: (id: string) => Array<{ id: string; title: string; snippet: string }>;
};

export function buildLinkIndex(docs: DocLike[], contents: Record<string, LooseBlock[]>): LinkIndex {
  const live = docs.filter((doc) => !doc.deletedAt);
  const byTitle = new Map<string, string>();
  const openedAt = new Map<string, number>();
  for (const doc of live) {
    const key = normTitle(doc.title);
    if (!key) continue;
    const stamp = typeof doc.lastOpenedAt === "number" ? doc.lastOpenedAt : 0;
    const prev = byTitle.get(key);
    if (prev === undefined) { byTitle.set(key, doc.id); openedAt.set(key, stamp); continue; }
    // duplicate titles: the most recently opened note wins — deterministic and matches what the user
    // means by "the one I actually use"; ties keep the earlier note, so rebuilds never flip the choice
    if (stamp > (openedAt.get(key) ?? 0)) { byTitle.set(key, doc.id); openedAt.set(key, stamp); }
  }
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
type TableLike = { type?: string; rows?: Array<{ cells?: unknown[] }> };

/**
 * Rewrites links to a renamed note inside BlockNote blocks (text runs, link labels, table cells, nested children).
 * Returns the same array when nothing changed. A link split over several styled runs is left alone on purpose.
 */
export function renameLinkInBlocks<B extends { content?: unknown; children?: unknown }>(blocks: B[], oldTitle: string, newTitle: string): { blocks: B[]; count: number } {
  let count = 0;
  const inline = (content: unknown): unknown => {
    if (typeof content === "string") { const r = renameLinkInText(content, oldTitle, newTitle); count += r.count; return r.text; }
    if (!Array.isArray(content)) {
      // a BlockNote table keeps its text in rows[].cells[] (each cell is its own inline content):
      // without this branch links inside cells survive a rename and break (QA2-L3)
      const table = content as TableLike | null;
      if (table && table.type === "tableContent" && Array.isArray(table.rows)) {
        return {
          ...table,
          rows: table.rows.map((row) => ({
            ...row,
            cells: (Array.isArray(row.cells) ? row.cells : []).map((cell) =>
              Array.isArray(cell)
                ? inline(cell)
                : cell && typeof cell === "object" && "content" in (cell as Record<string, unknown>)
                  ? { ...(cell as object), content: inline((cell as { content?: unknown }).content) }
                  : cell),
          })),
        };
      }
      return content;
    }
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

export type RenamePlan = { updates: Record<string, LooseBlock[]>; total: number };

/**
 * Планирует переписывание входящих [[ссылок]] после того, как новое название заметки устоялось.
 * `settled` — последние устоявшиеся заголовки по id; карта ОБНОВЛЯЕТСЯ на месте, чтобы между
 * вызовами видеть проход времени. Правила (те же, что были инлайном в App.tsx):
 *  - заметка без устоявшегося «до» или без изменения заголовка не трогает ничего;
 *  - если старое название осталась за другой живой заметкой, ссылки неоднозначны — переписывание пропускается;
 *  - write-through заметки не переписываются никогда: реальный файл на диске не должен
 *    меняться из-за переименования ссылки;
 *  - несколько переименований за один проход применяются цепочкой (updates переиспользуется как источник).
 */
export function planLinkRenames(
  live: DocLike[],
  contents: Record<string, LooseBlock[]>,
  settled: Map<string, string>,
): RenamePlan {
  const updates: Record<string, LooseBlock[]> = {};
  let total = 0;
  for (const doc of live) {
    const before = settled.get(doc.id);
    settled.set(doc.id, doc.title);
    if (before === undefined || before === doc.title || !doc.title.trim()) continue;
    const oldKey = normTitle(before);
    // another note with the old title would make the links ambiguous: leave them alone
    if (live.some((other) => other.id !== doc.id && normTitle(other.title) === oldKey)) continue;
    for (const other of live) {
      if (other.id === doc.id || other.writeThrough) continue;     // never rewrite a real file on disk because of a link rename
      const blocks = updates[other.id] ?? contents[other.id];
      if (!blocks || !linksOfBlocks(blocks).some((link) => normTitle(link.target) === oldKey)) continue;
      const renamed = renameLinkInBlocks(blocks, before, doc.title);
      if (renamed.count > 0) { updates[other.id] = renamed.blocks as LooseBlock[]; total += renamed.count; }
    }
  }
  return { updates, total };
}
