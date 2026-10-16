import { blocksToText, type LooseBlock } from "./textFormat";

type Doc = { id: string; title: string; deletedAt?: unknown; lastOpenedAt?: number };
export type SearchHit<D extends Doc> = { doc: D; snippet: string };

// lower-cased text per blocks array: only the edited note is converted again
const textCache = new WeakMap<object, string>();
const textOf = (blocks: LooseBlock[] | undefined) => {
  if (!blocks) return "";
  let hit = textCache.get(blocks);
  if (hit === undefined) { hit = blocksToText(blocks); textCache.set(blocks, hit); }
  return hit;
};

/**
 * Ranked search: every word of the query must occur (AND); title weighs 6, tag 3, body 1 (+ bonus when the whole phrase is in the title).
 * Empty query lists notes by recent use. The snippet shows where the body matched.
 */
export function searchNotes<D extends Doc>(docs: D[], contents: Record<string, LooseBlock[]>, tags: Record<string, string>, query: string, limit = 50): Array<SearchHit<D>> {
  const q = query.trim().toLocaleLowerCase("ru");
  const live = docs.filter((doc) => !doc.deletedAt);
  if (!q) return live.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)).slice(0, limit).map((doc) => ({ doc, snippet: "" }));
  const words = q.split(/\s+/).filter(Boolean);
  const hits: Array<SearchHit<D> & { score: number }> = [];
  for (const doc of live) {
    const title = doc.title.toLocaleLowerCase("ru");
    const tag = (tags[doc.id] ?? "").toLocaleLowerCase("ru");
    const body = textOf(contents[doc.id]);
    const bodyLower = body.toLocaleLowerCase("ru");
    let score = 0;
    let ok = true;
    for (const word of words) {
      const inTitle = title.includes(word), inTag = tag.includes(word), inBody = bodyLower.includes(word);
      if (!inTitle && !inTag && !inBody) { ok = false; break; }
      score += (inTitle ? 6 : 0) + (inTag ? 3 : 0) + (inBody ? 1 : 0);
    }
    if (!ok) continue;
    if (title.includes(q)) score += 4;
    if (title.startsWith(q)) score += 2;
    let snippet = "";
    const at = bodyLower.indexOf(words.find((w) => bodyLower.includes(w)) ?? "");
    if (at >= 0 && !title.includes(q)) {
      const start = Math.max(0, at - 30);
      snippet = (start > 0 ? "…" : "") + body.slice(start, at + 70).replace(/\s+/g, " ").trim() + (at + 70 < body.length ? "…" : "");
    }
    hits.push({ doc, snippet, score });
  }
  return hits.sort((a, b) => b.score - a.score || (b.doc.lastOpenedAt ?? 0) - (a.doc.lastOpenedAt ?? 0)).slice(0, limit).map(({ doc, snippet }) => ({ doc, snippet }));
}
