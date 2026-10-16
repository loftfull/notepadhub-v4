import { blocksToText, type LooseBlock } from "./textFormat";

type Doc = { id: string; title: string; deletedAt?: unknown; lastOpenedAt?: number };
/** snippet: the first place of the text where the query matched; snippets: up to three different places; matches: how many times the words occur in the note */
export type SearchHit<D extends Doc> = { doc: D; snippet: string; snippets: string[]; matches: number };

/** The text cut into pieces, the pieces that equal a query word (any case) marked, for showing the match highlighted. */
export function splitHighlight(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const words = [...new Set(query.trim().toLocaleLowerCase("ru").split(/\s+/).filter((w) => w.length > 0))].sort((a, b) => b.length - a.length);
  if (!text || words.length === 0) return [{ text, hit: false }];
  const lower = text.toLocaleLowerCase("ru");
  if (lower.length !== text.length) return [{ text, hit: false }];   // special letters changed the length: do not guess the places
  const marks: Array<[number, number]> = [];
  for (const word of words) { let from = 0; for (let i = 0; i < 200; i++) { const at = lower.indexOf(word, from); if (at < 0) break; marks.push([at, at + word.length]); from = at + word.length; } }
  marks.sort((a, b) => a[0] - b[0]);
  const out: Array<{ text: string; hit: boolean }> = [];
  let pos = 0;
  for (const [a, b] of marks) { if (a < pos) continue; if (a > pos) out.push({ text: text.slice(pos, a), hit: false }); out.push({ text: text.slice(a, b), hit: true }); pos = b; }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

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
  if (!q) return live.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)).slice(0, limit).map((doc) => ({ doc, snippet: "", snippets: [], matches: 0 }));
  const words = q.split(/\s+/).filter(Boolean);
  const hits: Array<SearchHit<D> & { score: number }> = [];
  const around = (body: string, at: number) => { const start = Math.max(0, at - 30); return (start > 0 ? "…" : "") + body.slice(start, at + 70).replace(/\s+/g, " ").trim() + (at + 70 < body.length ? "…" : ""); };
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
    // every place of the body where a word occurs (up to 60), three of them far enough from each other become snippets
    const places: number[] = [];
    for (const word of words) { let from = 0; for (let i = 0; i < 60; i++) { const at = bodyLower.indexOf(word, from); if (at < 0) break; places.push(at); from = at + Math.max(1, word.length); } }
    places.sort((a, b) => a - b);
    const snippets: string[] = [];
    let last = -1000;
    for (const at of places) { if (at - last >= 100 && snippets.length < 3) { snippets.push(around(body, at)); last = at; } }
    const snippet = !title.includes(q) ? (snippets[0] ?? "") : "";
    hits.push({ doc, snippet, snippets, matches: places.length + words.filter((w) => title.includes(w)).length, score });
  }
  return hits.sort((a, b) => b.score - a.score || (b.doc.lastOpenedAt ?? 0) - (a.doc.lastOpenedAt ?? 0)).slice(0, limit).map(({ doc, snippet, snippets, matches }) => ({ doc, snippet, snippets, matches }));
}
