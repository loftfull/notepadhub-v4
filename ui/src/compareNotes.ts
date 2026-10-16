// Comparing two notes side by side: paragraph by paragraph (longest common subsequence of paragraphs), and inside a changed pair word by word.
// Pure functions: the dialog only draws what they return.

export type DiffPart = { kind: "same" | "del" | "ins"; text: string };

/** Word-level difference (longest common subsequence of words). Null for very long texts. */
function wordDiff(before: string, after: string): DiffPart[] | null {
  const a = before.split(/(\s+)/).filter((t) => t.length > 0), b = after.split(/(\s+)/).filter((t) => t.length > 0);
  if (a.length * b.length > 4_000_000) return null;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => { const last = out[out.length - 1]; if (last && last.kind === kind) last.text += text; else out.push({ kind, text }); };
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push("same", a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", a[i]); i++; }
    else { push("ins", b[j]); j++; }
  }
  while (i < a.length) push("del", a[i++]);
  while (j < b.length) push("ins", b[j++]);
  return out;
}

export type CompareRow =
  | { kind: "same"; left: string; right: string; leftIndex: number; rightIndex: number }
  | { kind: "changed"; left: string; right: string; leftIndex: number; rightIndex: number; leftParts: DiffPart[]; rightParts: DiffPart[] }
  | { kind: "left-only"; left: string; leftIndex: number }
  | { kind: "right-only"; right: string; rightIndex: number };

export type CompareResult = { rows: CompareRow[]; same: number; changed: number; leftOnly: number; rightOnly: number; similarity: number };

const norm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Words of the changed pair: removed words only on the left, added words only on the right. */
function pairParts(left: string, right: string): { leftParts: DiffPart[]; rightParts: DiffPart[] } {
  const parts = wordDiff(left, right);
  if (!parts) return { leftParts: [{ kind: "del", text: left }], rightParts: [{ kind: "ins", text: right }] };
  return { leftParts: parts.filter((p) => p.kind !== "ins"), rightParts: parts.filter((p) => p.kind !== "del") };
}

/** Closeness of two paragraphs 0..1 by shared words: decides whether two different paragraphs are a "changed" pair or unrelated. */
export function paragraphCloseness(a: string, b: string): number {
  const wa = norm(a).split(" ").filter(Boolean), wb = norm(b).split(" ").filter(Boolean);
  if (wa.length === 0 || wb.length === 0) return 0;
  const bag = new Map<string, number>();
  for (const w of wb) bag.set(w, (bag.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of wa) { const n = bag.get(w) ?? 0; if (n > 0) { shared += 1; bag.set(w, n - 1); } }
  return (2 * shared) / (wa.length + wb.length);
}

export function compareNotes(left: string[], right: string[]): CompareResult {
  const a = left.map(norm), b = right.map(norm);
  // longest common subsequence of equal paragraphs
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows: CompareRow[] = [];
  let i = 0, j = 0;
  let pendingLeft: number[] = [], pendingRight: number[] = [];
  const flush = () => {
    // between two equal paragraphs: pair the leftovers in order when they resemble each other, the rest stays one-sided
    const lefts = [...pendingLeft], rights = [...pendingRight];
    pendingLeft = []; pendingRight = [];
    while (lefts.length > 0 || rights.length > 0) {
      const l = lefts[0], r = rights[0];
      if (l !== undefined && r !== undefined && paragraphCloseness(left[l], right[r]) >= 0.4) {
        rows.push({ kind: "changed", left: left[l], right: right[r], leftIndex: l, rightIndex: r, ...pairParts(left[l], right[r]) });
        lefts.shift(); rights.shift();
      } else if (l !== undefined && (r === undefined || paragraphCloseness(left[l], right[r]) < 0.4)) {
        // a left paragraph with no partner comes first if a later right paragraph resembles the next left one, else just one-sided
        rows.push({ kind: "left-only", left: left[l], leftIndex: l }); lefts.shift();
      } else if (r !== undefined) {
        rows.push({ kind: "right-only", right: right[r], rightIndex: r }); rights.shift();
      }
    }
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { flush(); rows.push({ kind: "same", left: left[i], right: right[j], leftIndex: i, rightIndex: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { pendingLeft.push(i); i++; }
    else { pendingRight.push(j); j++; }
  }
  while (i < a.length) { pendingLeft.push(i); i++; }
  while (j < b.length) { pendingRight.push(j); j++; }
  flush();
  const count = (kind: CompareRow["kind"]) => rows.filter((row) => row.kind === kind).length;
  const same = count("same"), changed = count("changed"), leftOnly = count("left-only"), rightOnly = count("right-only");
  const total = same + changed + leftOnly + rightOnly;
  return { rows, same, changed, leftOnly, rightOnly, similarity: total === 0 ? 1 : (same + changed * 0.5) / total };
}
