/**
 * "Привести в порядок": tidies the blocks of a note for comfortable reading. Pure and idempotent: a second run changes nothing.
 * Code blocks, links, addresses, e-mails, `code` and [[note links]] are never touched. Every change is counted so the person
 * sees what will happen before it does, and the whole run is one undo step in the editor.
 */
export type FormatOptions = {
  collapseSpaces: boolean;      // double spaces, trailing spaces, space before punctuation, missing space after it
  stripIndent: boolean;         // leading spaces and tabs in paragraphs
  emptyLines: "keep" | "one" | "none";
  joinWrapped: boolean;         // lines broken in the middle of a sentence by copy/paste become one paragraph
  lists: boolean;               // "• x", "– x", "1) x" become real lists
  typography: boolean;          // " - " → " — ", "..." → "…", straight quotes → «ёлочки»
  nbsp: boolean;                // non-breaking space after short words (в, на, не …)
  boldLabels: boolean;          // "Важно:", "Срок:", "Итого:" at the start of a line in bold
  firstLineHeading: boolean;    // a short first line without a full stop becomes the title
  capsHeadings: boolean;        // LINES IN CAPITALS become second-level headings
  capitalize: boolean;          // paragraph starts with a capital letter
};

export const DEFAULT_FORMAT: FormatOptions = {
  collapseSpaces: true, stripIndent: true, emptyLines: "none", joinWrapped: true, lists: true, typography: true,
  nbsp: false, boldLabels: true, firstLineHeading: false, capsHeadings: false, capitalize: false,
};

export type FormatStats = {
  spaces: number; indents: number; emptyBlocks: number; joined: number; lists: number;
  typography: number; nbsp: number; labels: number; headings: number; capitalized: number;
};
const emptyStats = (): FormatStats => ({ spaces: 0, indents: 0, emptyBlocks: 0, joined: 0, lists: 0, typography: 0, nbsp: 0, labels: 0, headings: 0, capitalized: 0 });
export const totalChanges = (stats: FormatStats) => Object.values(stats).reduce((sum, n) => sum + n, 0);

type Inline = { type?: string; text?: string; styles?: Record<string, unknown>; href?: string; content?: unknown };
export type FormatBlock = { id?: string; type: string; props?: Record<string, unknown>; content?: unknown; children?: FormatBlock[] };

const PROTECTED = /(https?:\/\/\S+|\S+@\S+\.\S+|\[\[[^\]\n]*\]\]|[A-Za-z]:\\\S+)/;
const SENTENCE_END = /[.!?…:;»"”)]$/;
const LABEL = /^(Важно|Внимание|Примечание|Заметка|Срок|Итого|Вывод|Выводы|Решение|Вопрос|Идея|Цель|Задача|Проблема|Результат|Контакты|Адрес|Телефон|Пример|TODO|NB|Note|Warning|Important)\s*:/i;

const runsOf = (content: unknown): Inline[] => typeof content === "string" ? (content ? [{ type: "text", text: content, styles: {} }] : []) : Array.isArray(content) ? (content as Inline[]) : [];
const plain = (content: unknown): string => runsOf(content).map((r) => r.type === "link" ? plain(r.content) : (r.text ?? "")).join("");
const isEmptyParagraph = (b: FormatBlock) => b.type === "paragraph" && plain(b.content).trim() === "" && !(b.children && b.children.length);

/** Applies `fn` to the unprotected pieces of every plain text run (code runs, links and protected spans are skipped). */
function mapRuns(content: unknown, fn: (text: string) => string): { content: unknown; changed: boolean } {
  if (typeof content !== "string" && !Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const fixText = (text: string) => {
    const parts = text.split(PROTECTED);
    const out = parts.map((part, i) => (i % 2 === 1 ? part : fn(part))).join("");
    if (out !== text) changed = true;
    return out;
  };
  if (typeof content === "string") { const next = fixText(content); return { content: next, changed }; }
  const next = (content as Inline[]).map((run) => {
    if (run.type === "link") return run;                                   // link labels are left as they are
    if (run.type === "text" && typeof run.text === "string" && !run.styles?.code) return { ...run, text: fixText(run.text) };
    return run;
  });
  return { content: next, changed };
}

const countMatches = (before: string, after: string, pattern: RegExp) => Math.max(0, (before.match(pattern) ?? []).length - (after.match(pattern) ?? []).length);

export function formatBlocks(input: FormatBlock[], options: FormatOptions): { blocks: FormatBlock[]; stats: FormatStats; changed: boolean } {
  const stats = emptyStats();
  const blocks = structuredClone(input) as FormatBlock[];

  const textBlock = (b: FormatBlock) => b.type === "paragraph" || b.type === "bulletListItem" || b.type === "numberedListItem" || b.type === "checkListItem" || b.type === "quote" || b.type === "heading";

  const processList = (list: FormatBlock[]): FormatBlock[] => {
    let blocksNow = list;

    // 1. leading indentation
    if (options.stripIndent) for (const b of blocksNow) if (b.type === "paragraph") {
      const runs = runsOf(b.content);
      if (runs[0]?.type === "text" && /^[ \t 　]+/.test(runs[0].text ?? "")) {
        const first = { ...runs[0], text: (runs[0].text ?? "").replace(/^[ \t 　]+/, "") };
        b.content = [first, ...runs.slice(1)].filter((r) => !(r.type === "text" && r.text === ""));
        stats.indents++;
      }
    }

    // 2. bullet and numbered markers typed by hand
    if (options.lists) {
      for (let i = 0; i < blocksNow.length; i++) {
        const b = blocksNow[i];
        if (b.type !== "paragraph" || (b.children && b.children.length)) continue;
        const text = plain(b.content);
        const bullet = /^([•·▪●○–—*])\s+\S/.exec(text);
        if (bullet) { retype(b, "bulletListItem", bullet[0].length - 1 - (text.slice(bullet[0].length - 1).length - text.slice(bullet[0].length - 1).trimStart().length) + 0, text); stats.lists++; continue; }
        const numbered = /^(\d{1,2})[).]\s+\S/.exec(text);
        const next = blocksNow[i + 1];
        const prev = blocksNow[i - 1];
        const near = (x?: FormatBlock) => !!x && x.type === "paragraph" && /^(\d{1,2})[).]\s+\S/.test(plain(x.content));
        if (numbered && (near(next) || near(prev) || prev?.type === "numberedListItem")) { retype(b, "numberedListItem", 0, text); stats.lists++; }
      }
    }

    // 3. lines broken in the middle of a sentence
    if (options.joinWrapped) {
      const out: FormatBlock[] = [];
      for (const b of blocksNow) {
        const prev = out[out.length - 1];
        if (prev && prev.type === "paragraph" && b.type === "paragraph" && !(prev.children?.length) && !(b.children?.length)) {
          const a = plain(prev.content).trimEnd(), c = plain(b.content).trimStart();
          if (a.length >= 40 && !SENTENCE_END.test(a) && /^[a-zа-яё]/.test(c)) {
            prev.content = [...runsOf(prev.content), { type: "text", text: " ", styles: {} }, ...runsOf(b.content)];
            stats.joined++;
            continue;
          }
        }
        out.push(b);
      }
      blocksNow = out;
    }

    // 4. empty lines
    if (options.emptyLines !== "keep") {
      const out: FormatBlock[] = [];
      for (let i = 0; i < blocksNow.length; i++) {
        const b = blocksNow[i];
        const last = i === blocksNow.length - 1;
        if (isEmptyParagraph(b) && !last) {
          const keep = options.emptyLines === "one" && out.length > 0 && !isEmptyParagraph(out[out.length - 1]);
          if (!keep) { stats.emptyBlocks++; continue; }
        }
        out.push(b);
      }
      blocksNow = out;
    }

    // 5. per block text fixes
    for (const b of blocksNow) {
      if (textBlock(b)) {
        const before = plain(b.content);
        let content = b.content;
        if (options.collapseSpaces) {
          const r = mapRuns(content, (t) => t
            .replace(/[ \t]{2,}/g, " ")
            .replace(/ +([,.;:!?…»)\]])/g, "$1")
            .replace(/([(«\[]) +/g, "$1")
            .replace(/([,;!?])(?=[A-Za-zА-Яа-яЁё])/g, "$1 ")
            .replace(/([а-яё])\.(?=[А-ЯЁ])/g, "$1. "));
          content = r.content;
          // trailing spaces at the end of the block
          const runs = runsOf(content);
          const last = runs[runs.length - 1];
          if (last?.type === "text" && /[ \t]+$/.test(last.text ?? "")) content = [...runs.slice(0, -1), { ...last, text: (last.text ?? "").replace(/[ \t]+$/, "") }].filter((x) => !(x.type === "text" && x.text === ""));
          const after = plain(content);
          stats.spaces += Math.max(0, before.length - after.length) + countMatches(before, after, /[,;!?](?=[A-Za-zА-Яа-яЁё])/g) + countMatches(before, after, /[а-яё]\.(?=[А-ЯЁ])/g);
        }
        if (options.typography && /[А-Яа-яЁё]/.test(before)) {
          const typo = mapRuns(content, (t) => {
            let quoteOpen = true;
            return t
              .replace(/ (?:-|--) /g, " — ")
              .replace(/\.{3,}/g, "…")
              .replace(/(^|[\s(\[—])-(?=\s)/g, "$1—")
              .replace(/["“”„]/g, (q, offset: number, all: string) => {
                const prev = offset === 0 ? " " : all[offset - 1];
                const open = /[\s(\[—«]/.test(prev) || offset === 0;
                quoteOpen = !open;
                return open ? "«" : "»";
              });
          });
          if (typo.changed) { stats.typography++; content = typo.content; }
        }
        if (options.nbsp && /[А-Яа-яЁё]/.test(before)) {
          const r = mapRuns(content, (t) => t
            .replace(/(^|[\s(«])(в|к|с|у|о|и|а|но|на|за|по|из|от|до|не|ни|во|со|ко)\s+(?=\S)/gi, "$1$2 ")
            .replace(/\s+—/g, " —"));
          if (r.changed) { stats.nbsp++; content = r.content; }
        }
        if (options.capitalize && b.type === "paragraph") {
          const runs = runsOf(content);
          const first = runs[0];
          if (first?.type === "text" && /^[a-zа-яё]/.test(first.text ?? "") && plain(content).length >= 3 && !PROTECTED.test((first.text ?? "").split(/\s/)[0])) {
            content = [{ ...first, text: (first.text ?? "").charAt(0).toUpperCase() + (first.text ?? "").slice(1) }, ...runs.slice(1)];
            stats.capitalized++;
          }
        }
        if (options.boldLabels && (b.type === "paragraph" || b.type === "bulletListItem" || b.type === "numberedListItem" || b.type === "checkListItem" || b.type === "quote")) {
          const runs = runsOf(content);
          const first = runs[0];
          const m = first?.type === "text" ? LABEL.exec(first.text ?? "") : null;
          if (first && m && !first.styles?.bold && (first.text ?? "").length > m[0].length - 0) {
            const label = (first.text ?? "").slice(0, m[0].length), rest = (first.text ?? "").slice(m[0].length);
            content = [{ type: "text", text: label, styles: { ...(first.styles ?? {}), bold: true } }, ...(rest ? [{ type: "text", text: rest, styles: first.styles ?? {} }] : []), ...runs.slice(1)];
            stats.labels++;
          }
        }
        b.content = content;
      }
      if (b.children?.length) b.children = processList(b.children);
    }
    return blocksNow;
  };

  function retype(b: FormatBlock, type: string, _unused: number, text: string) {
    const marker = /^([•·▪●○–—*]|\d{1,2}[).])\s+/.exec(text)![0];
    const runs = runsOf(b.content);
    const first = runs[0];
    b.type = type;
    b.props = type === "numberedListItem" ? {} : {};
    b.content = first?.type === "text" ? [{ ...first, text: (first.text ?? "").slice(marker.length) }, ...runs.slice(1)].filter((r) => !(r.type === "text" && r.text === "")) : b.content;
  }

  let result = processList(blocks);

  // 6. headings
  if (options.firstLineHeading && !result.some((b) => b.type === "heading")) {
    const first = result.find((b) => !isEmptyParagraph(b));
    const text = first ? plain(first.content).trim() : "";
    if (first && first.type === "paragraph" && text.length >= 3 && text.length <= 80 && !/[.!?:;,…]$/.test(text) && result.length > 1) {
      first.type = "heading"; first.props = { level: 1 }; stats.headings++;
    }
  }
  if (options.capsHeadings) {
    for (const b of result) if (b.type === "paragraph") {
      const text = plain(b.content).trim();
      const letters = text.match(/\p{L}/gu) ?? [];
      if (text.length >= 4 && text.length <= 80 && letters.length >= 3 && text === text.toUpperCase() && text !== text.toLowerCase() && !/[.!?]$/.test(text)) {
        b.type = "heading"; b.props = { level: 2 }; stats.headings++;
      }
    }
  }
  result = result.length ? result : [{ type: "paragraph", content: "" }];
  const changed = totalChanges(stats) > 0;
  return { blocks: result, stats, changed };
}

/** BlockNote must get blocks without ids when they replace the old ones: it creates fresh ids itself. */
export function withoutIds(blocks: FormatBlock[]): FormatBlock[] {
  return blocks.map((b) => { const { id: _id, ...rest } = b; return { ...rest, ...(b.children ? { children: withoutIds(b.children) } : {}) } as FormatBlock; });
}

export const STAT_LABELS: Array<[keyof FormatStats, string]> = [
  ["spaces", "лишних пробелов и знаков исправлено"], ["indents", "отступов в начале строк убрано"], ["emptyBlocks", "пустых строк убрано"],
  ["joined", "оборванных строк склеено в абзацы"], ["lists", "пунктов превращено в списки"], ["typography", "абзацев с типографикой (тире, кавычки, многоточия)"],
  ["nbsp", "абзацев с неразрывными пробелами"], ["labels", "меток выделено жирным"], ["headings", "заголовков выделено"], ["capitalized", "абзацев начато с заглавной буквы"],
];
