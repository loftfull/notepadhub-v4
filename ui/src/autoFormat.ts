// SAFE MODE (the default without a model): only changes that cannot turn a note into nonsense. A short line is a heading only when it ends
// with a colon or is written in capitals and stands over a real paragraph; terms are bolded only in a clearly uniform list; lines are glued only
// in a clear hard-wrapped run; typography is skipped where the text is ambiguous (odd quotes).
// "Автоформат": makes a note balanced and readable in the way answers of ChatGPT and Claude are laid out, without calling a model:
// a title, short headings over paragraphs, paragraphs of two to four sentences, clean lists with a bold lead term, one kind of quotes and dashes.
// Nothing is invented and no word is changed; only structure and typography. Tables, pictures, code, quotes and checklists are left alone.

export type Inline = { type: "text"; text: string; styles?: Record<string, unknown> } | { type: "link"; href: string; content: Inline[] };
export type AfBlock = { type: string; props?: Record<string, unknown>; content?: string | Inline[] | unknown; children?: unknown[]; [key: string]: unknown };

export type AutoFormatReport = { headings: number; paragraphsSplit: number; paragraphsMerged: number; boldTerms: number; typography: number; removedEmpty: number; letterParts: number; listsMade: number; images: number; technical: number };


/** A line of a command, a path, a setting, a log or code: such text is never "formatted" (dashes, quotes, lists and merged lines would break it). */
export function isCodeLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^[A-Za-z]:[\\/]/.test(t)
    || /^(?:~|\.{1,2})?[/\\]\w[\w.-]*[/\\]/.test(t)
    || /^(?:\$ |>>? ?\S|#!|PS [A-Z]:|git |npm |npx |cd |ls |dir |dotnet |python3? |node |pip |curl |sudo |cat |echo |mkdir |rm |cp |mv |winget |choco |docker |ollama )/i.test(t)
    || /^[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*\S/.test(t)
    || /[{};]\s*$/.test(t)
    || /=>|::|\\\w|(?:^|\s)--?[a-z][\w-]+(?:\s|=|$)/.test(t)
    || /^\s*(?:at |File ").+/.test(text)
    || /\.(?:exe|dll|json|ps1|apk|log|env|ya?ml|toml)(?:["'\s]|$)/i.test(t);
}

const NBSP = " ";
// Letter conventions (Russian and English): a greeting stands alone on its line, the closing and the signature stand apart under the body.
const GREETING = /^(здравствуй(те)?|добрый\s+(день|вечер)|доброе\s+утро|доброго\s+времени|уважаем(ый|ая|ые|ое)|многоуваж|дорог(ой|ая|ие)|привет(ствую)?|hello|hi|dear|good\s+(morning|afternoon|evening))(\s|,|!|$)/i;
const CLOSING = /^(с\s+уважением|с\s+наилучшими|с\s+благодарностью|искренне|всего\s+(доброго|наилучшего)|хорошего\s+дня|до\s+встречи|best\s+regards|kind\s+regards|regards|sincerely|yours|thanks|thank\s+you)(\s|,|!|\.|$)/i;
const MAX_IMAGE_WIDTH = 720;

const TEXT_TYPES = new Set(["paragraph", "heading", "bulletListItem", "numberedListItem"]);
const MAX_PARAGRAPH = 900;
const SENTENCE_END = /[.!?…]["»”)]?$/;

/** The plain text of a block when it has no styles and no links, otherwise null (such blocks keep their structure). */
export function plainOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let out = "";
  for (const part of content as Inline[]) {
    if (part.type !== "text") return null;
    if (part.styles && Object.values(part.styles).some(Boolean)) return null;
    out += part.text;
  }
  return out;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Inline[]).map((part) => (part.type === "text" ? part.text : part.content.map((c) => (c.type === "text" ? c.text : "")).join(""))).join("");
};

const isCyrillic = (text: string) => (text.match(/[А-Яа-яЁё]/g)?.length ?? 0) > (text.match(/[A-Za-z]/g)?.length ?? 0);

/** Typography of one string: spaces, dashes, ellipsis and quotes. Returns the new text and how many fixes were made. */
export function fixTypography(text: string, cyrillic: boolean): { text: string; fixes: number } {
  let fixes = 0;
  const sub = (re: RegExp, to: string) => { fixes += (text.match(re) ?? []).length; text = text.replace(re, to); };
  sub(/[ \t]{2,}/g, " ");
  sub(/ +([,.;:!?…])/g, "$1");
  sub(/\.{3,}/g, "…");
  sub(/([\p{L}»”"’)])(\s)[-–](\s)(?=[\p{L}«"“(])/gu, "$1$2—$3");
  sub(/\(\s+/g, "(");
  sub(/\s+\)/g, ")");
  if (cyrillic) {
    sub(/(?<=[а-яё]),(?=[а-яё])/g, ", ");           // "слово,слово"
    sub(/(?<=[а-яё])\.(?=[А-ЯЁ][а-яё])/g, ". ");   // "слово.Другое"
    sub(/(?<![\p{L}])([А-ЯЁ])\.\s?([А-ЯЁ])\.\s?(?=[А-ЯЁ][а-яё])/gu, `$1.${NBSP}$2.${NBSP}`);   // initials stay with the surname
    sub(/(?<![\p{L}])т\.\s?е\./gu, `т.${NBSP}е.`);
    sub(/(?<![\p{L}])т\.\s?д\./gu, `т.${NBSP}д.`);
    sub(/(?<![\p{L}])т\.\s?п\./gu, `т.${NBSP}п.`);
    sub(/ —(?=\s)/g, `${NBSP}—`);                   // a dash never starts a line
  }
  if (cyrillic && !/https?:\/\//.test(text)) {
    // straight and curly double quotes to guillemets, paired in order of appearance; an odd number of marks is ambiguous and left alone
    const marks = text.match(/["“”„]/g)?.length ?? 0;
    if (marks > 0 && marks % 2 === 0) {
      let open = true;
      text = text.replace(/["“”„]/g, () => { fixes += 1; const q = open ? "«" : "»"; open = !open; return q; });
    }
  }
  return { text, fixes };
}

function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!/[.!?…]/.test(text[i])) continue;
    let j = i + 1;
    while (j < text.length && /["»”)]/.test(text[j])) j++;
    if (text[j] !== " ") continue;
    const next = text[j + 1] ?? "";
    if (!/[A-ZА-ЯЁ«"(0-9]/.test(next)) continue;
    const word = text.slice(start, i).split(/\s+/).pop() ?? "";
    if (text[i] === "." && (word.length <= 2 || /^(т|др|пр|см|рис|ул|им|гг?|руб|тыс|млн|млрд|англ|лат|напр|etc|vs|Mr|Mrs|Dr)$/i.test(word))) continue;   // initials and abbreviations
    parts.push(text.slice(start, j).trim());
    start = j + 1;
  }
  if (start < text.length) parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/** Paragraph of 2-4 sentences: split long ones at sentence ends, about three sentences each. */
export function splitParagraph(text: string): string[] {
  if (text.length <= MAX_PARAGRAPH) return [text];
  const sentences = splitSentences(text);
  if (sentences.length < 4) return [text];
  const groups: string[] = [];
  let current = "";
  let count = 0;
  for (const sentence of sentences) {
    if (current && (count >= 3 || (current + " " + sentence).length > 520)) { groups.push(current); current = ""; count = 0; }
    current = current ? current + " " + sentence : sentence;
    count += 1;
  }
  if (current) groups.push(current);
  // a one-sentence tail glued to the previous group reads better than a lonely line
  if (groups.length > 1 && groups[groups.length - 1].length < 120) { const tail = groups.pop()!; groups[groups.length - 1] += " " + tail; }
  return groups;
}

const looksLikeHeading = (text: string): boolean => {
  const t = text.trim();
  if (t.length < 3 || t.length > 70) return false;
  if (/[.!?…;,]$/.test(t)) return false;
  if (/^[-*•–—]\s/.test(t) || /^\d+[.)]\s/.test(t)) return false;
  if (/https?:\/\//.test(t)) return false;
  return t.split(/\s+/).length <= 9;
};

/** "Term — explanation" or "Term: explanation" at the start of a list item: the term becomes bold, as in a model's answer. */
export function boldLeadTerm(text: string): { content: Inline[]; changed: boolean } | null {
  const m = /^([^.:—–]{2,40}?)(\s[—–-]\s|:\s)(.{12,})$/.exec(text);
  if (!m || m[1].trim().split(/\s+/).length > 4 || /^(https?|\d)/.test(m[1])) return null;
  return { changed: true, content: [{ type: "text", text: m[1].trim(), styles: { bold: true } }, { type: "text", text: (m[2].trim() === ":" ? ": " : NBSP + "— ") + m[3], styles: {} }] };
}

export function autoFormat(input: AfBlock[]): { blocks: AfBlock[]; report: AutoFormatReport } {
  const report: AutoFormatReport = { headings: 0, paragraphsSplit: 0, paragraphsMerged: 0, boldTerms: 0, typography: 0, removedEmpty: 0, letterParts: 0, listsMade: 0, images: 0, technical: 0 };
  const fromBreak = new WeakSet<object>();   // lines that came out of one pasted block with line breaks inside
  const all: AfBlock[] = [];
  for (const block of input) {
    const copy: AfBlock = { ...block };
    if (copy.type === "paragraph") {
      const plain = plainOf(copy.content);
      if (plain !== null && /[\r\n\u2028\u2029\u000b]/.test(plain)) {
        // a pasted block with line breaks inside: every line is its own paragraph, blank lines vanish with the empty-block rule below
        const lines = plain.split(/[\r\n\u2028\u2029\u000b]+/);
        lines.forEach((line, i) => { const part: AfBlock = i === 0 ? { ...copy, content: line } : { type: "paragraph", props: { ...(copy.props ?? {}) }, content: line }; fromBreak.add(part); all.push(part); });
        continue;
      }
      if (Array.isArray(copy.content)) {
        // styled text: only the line breaks at the very start and end go; inner structure stays
        const parts = (copy.content as Inline[]).map((part) => ({ ...part }));
        const first = parts[0], last = parts[parts.length - 1];
        if (first && first.type === "text") first.text = first.text.replace(/^[\s]+/, "");
        if (last && last.type === "text") last.text = last.text.replace(/[\s]+$/, "");
        while (parts.length && parts[0].type === "text" && parts[0].text === "") parts.shift();
        while (parts.length && parts[parts.length - 1].type === "text" && (parts[parts.length - 1] as { text: string }).text === "") parts.pop();
        copy.content = parts;
      }
    }
    all.push(copy);
  }
  const cyrillic = isCyrillic(all.map((block) => textOf(block.content)).join(" "));
  // A note that is mostly commands, paths, settings or a log is technical text: only the empty lines go, nothing else is "improved".
  const filled = all.filter((block) => TEXT_TYPES.has(block.type) && textOf(block.content).trim() !== "");
  const codeLines = filled.filter((block) => isCodeLine(textOf(block.content))).length;
  const technical = codeLines >= 3 && codeLines / Math.max(1, filled.length) >= 0.25;
  if (technical) report.technical = 1;

  // 0. spaces at the ends of lines and fake indents made of spaces
  for (const block of all) {
    if (!TEXT_TYPES.has(block.type)) continue;
    if (typeof block.content === "string") block.content = block.content.replace(/^[\s 　]+|[\s 　]+$/g, "");
  }

  // 1. typography per text node (works on styled text too)
  for (const block of all) {
    if (!TEXT_TYPES.has(block.type) || technical || isCodeLine(textOf(block.content))) continue;
    if (typeof block.content === "string") {
      const r = fixTypography(block.content, cyrillic);
      block.content = r.text; report.typography += r.fixes;
    } else if (Array.isArray(block.content)) {
      block.content = (block.content as Inline[]).map((part) => {
        if (part.type !== "text") return part;
        const r = fixTypography(part.text, cyrillic);
        report.typography += r.fixes;
        return { ...part, text: r.text };
      });
    }
  }

  // 2. drop empty blocks (spacing comes from the layout, not from blank lines): paragraphs, headings, list items, quotes without text
  const EMPTY_TYPES = new Set(["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "quote"]);
  let blocks = all.filter((block) => {
    const empty = EMPTY_TYPES.has(block.type) && textOf(block.content).replace(/[\s ​　]+/g, "") === "" && !(block.children as unknown[] | undefined)?.length;
    if (empty) report.removedEmpty += 1;
    return !empty;
  });

  // 2a. letter: the greeting stands alone, the closing and the signature stand apart under the text; none of them is a heading, a list or a part of a paragraph
  const letter = new WeakSet<object>();
  const isPlainPara = (block: AfBlock | undefined): string | null => (block && block.type === "paragraph" ? plainOf(block.content) : null);
  for (let k = 0; k < Math.min(3, blocks.length); k++) {
    const text = isPlainPara(blocks[k])?.trim();
    if (text && text.length <= 90 && GREETING.test(text) && !/[.]$/.test(text)) { letter.add(blocks[k]); report.letterParts += 1; break; }
  }
  for (let k = Math.max(0, blocks.length - 6); k < blocks.length; k++) {
    const text = isPlainPara(blocks[k])?.trim();
    if (!text || text.length > 60 || !CLOSING.test(text)) continue;
    letter.add(blocks[k]); report.letterParts += 1;
    let n = 0;
    for (let m = k + 1; m < blocks.length && n < 3; m++, n++) {
      const sign = isPlainPara(blocks[m])?.trim();
      if (!sign || sign.length > 50 || /[.!?]$/.test(sign)) break;
      letter.add(blocks[m]); report.letterParts += 1;
    }
    // "С уважением" over a signature reads "С уважением," (the comma is the rule of the genre)
    if (n > 0 && /^[^,!.]+$/.test(text) && isPlainPara(blocks[k]) !== null) blocks[k] = { ...blocks[k], content: text + "," }, letter.add(blocks[k]);
    break;
  }

  // 2a2. Markdown typed as plain text ("## Title"): the marks become real headings, no "##" is left in the text
  if (!technical) {
    blocks = blocks.map((block) => {
      const text = letter.has(block) ? null : isPlainPara(block);
      const m = text === null ? null : /^(#{1,6})\s+(\S.*)$/.exec(text.trim());
      if (!m) return block;
      report.headings += 1;
      return { ...block, type: "heading", props: { ...(block.props ?? {}), level: Math.min(3, m[1].length) }, content: m[2].replace(/\s+#+\s*$/, "").trim() };
    });
  }

  // 2b. lines that wear list marks as typed characters become real lists (two or more in a row)
  const markOf = (block: AfBlock | undefined): { kind: "bulletListItem" | "numberedListItem"; text: string } | null => {
    const text = block && !technical && !letter.has(block) ? isPlainPara(block) : null;
    if (text === null) return null;
    const bullet = /^\s*[-*•·]\s+(\S.*)$/.exec(text);
    if (bullet) return { kind: "bulletListItem", text: bullet[1].trim() };
    const numbered = /^\s*\d{1,2}[.)]\s+(\S.*)$/.exec(text);
    return numbered ? { kind: "numberedListItem", text: numbered[1].trim() } : null;
  };
  {
    const listed: AfBlock[] = [];
    let k = 0;
    while (k < blocks.length) {
      const first = markOf(blocks[k]);
      let end = k;
      while (first && markOf(blocks[end + 1])?.kind === first.kind) end++;
      if (first && end > k) {
        for (let m = k; m <= end; m++) listed.push({ ...blocks[m], type: markOf(blocks[m])!.kind, content: markOf(blocks[m])!.text });
        report.listsMade += end - k + 1;
        k = end + 1;
      } else { listed.push(blocks[k]); k++; }
    }
    blocks = listed;
  }

  // 3. merge hard-wrapped lines: a run of two or more joins, or one join when both lines came out of one pasted block (a lone break elsewhere stays)
  const wrapsInto = (a: AfBlock | undefined, b: AfBlock | undefined) => {
    if (technical || (a && letter.has(a)) || (b && letter.has(b))) return false;
    if (isCodeLine(textOf(a?.content)) || isCodeLine(textOf(b?.content))) return false;
    const x = isPlainPara(a), y = isPlainPara(b);
    return x !== null && y !== null && x.length >= 40 && !SENTENCE_END.test(x.trim()) && !/[:;]$/.test(x.trim()) && /^[a-zа-яё]/.test(y.trim());
  };
  const merged = blocks;
  // joins are decided on whole runs so that a lone break is never touched
  const out: AfBlock[] = [];
  let i = 0;
  while (i < merged.length) {
    let j = i;
    while (wrapsInto(merged[j], merged[j + 1])) j++;
    const sameOrigin = j > i && merged.slice(i, j + 1).every((b) => fromBreak.has(b));
    const longLine = (plainOf(merged[i].content) ?? "").trim().length >= 60;   // a long line broken before a lowercase word is a wrap
    if (j - i >= 2 || (j - i >= 1 && (sameOrigin || longLine))) {
      const text = merged.slice(i, j + 1).map((b) => (plainOf(b.content) ?? "").trim()).join(" ");
      out.push({ ...merged[i], content: text });
      report.paragraphsMerged += j - i;
      i = j + 1;
    } else { out.push(merged[i]); i++; }
  }
  blocks = out;

  // 4. headings: a short line that ends with a colon or is in capitals, standing over a real paragraph (a plain short line is just a line)
  blocks = blocks.map((block, index) => {
    if (block.type !== "paragraph" || technical || letter.has(block)) return block;
    const text = plainOf(block.content);
    if (text === null || !looksLikeHeading(text.replace(/:$/, ""))) return block;
    const next = blocks[index + 1];
    const nextText = next && next.type === "paragraph" ? plainOf(next.content) : null;
    const overParagraph = nextText !== null && nextText.length >= 80;
    const allCaps = text.length >= 4 && text === text.toUpperCase() && /[A-ZА-ЯЁ]/.test(text);
    const colon = /:$/.test(text.trim());
    if (!overParagraph || !(allCaps || colon)) return block;
    report.headings += 1;
    const clean = text.trim().replace(/:$/, "");
    const display = allCaps ? clean.charAt(0) + clean.slice(1).toLowerCase() : clean;
    return { ...block, type: "heading", props: { ...(block.props ?? {}), level: 2 }, content: display };
  });

  // 5. one title: later level-1 headings become level 2
  let seenTitle = false;
  blocks = blocks.map((block) => {
    if (block.type !== "heading") return block;
    const level = Number((block.props as { level?: number } | undefined)?.level ?? 1);
    if (level === 1) { if (seenTitle) return { ...block, props: { ...(block.props ?? {}), level: 2 } }; seenTitle = true; }
    return block;
  });

  // 6. long paragraphs into paragraphs of a few sentences
  const split: AfBlock[] = [];
  for (const block of blocks) {
    const text = block.type === "paragraph" && !technical ? plainOf(block.content) : null;
    if (text !== null && text.length > MAX_PARAGRAPH) {
      const parts = splitParagraph(text);
      if (parts.length > 1) {
        report.paragraphsSplit += parts.length - 1;
        parts.forEach((part, i) => split.push(i === 0 ? { ...block, content: part } : { type: "paragraph", props: { ...(block.props ?? {}) }, content: part }));
        continue;
      }
    }
    split.push(block);
  }
  blocks = split;

  // 7. list items: bold lead term, only where at least two neighbouring items follow the same "Term — text" pattern
  const isTermItem = (block: AfBlock | undefined) => !!block && (block.type === "bulletListItem" || block.type === "numberedListItem") && plainOf(block.content) !== null && boldLeadTerm(plainOf(block.content)!) !== null;
  blocks = blocks.map((block, index) => {
    if (technical || !isTermItem(block) || !(isTermItem(blocks[index - 1]) || isTermItem(blocks[index + 1]))) return block;
    report.boldTerms += 1;
    return { ...block, content: boldLeadTerm(plainOf(block.content)!)!.content };
  });

  // 7b. text justified "by width" (pasted from Word or a web page) leaves wide gaps in a narrow column: the reading column is left-aligned
  blocks = blocks.map((block) => {
    if (!TEXT_TYPES.has(block.type) || (block.props as { textAlignment?: string } | undefined)?.textAlignment !== "justify") return block;
    report.typography += 1;
    return { ...block, props: { ...(block.props ?? {}), textAlignment: "left" } };
  });

  // 8. pictures: centred, not wider than the reading column; a picture never sits inside a text block
  blocks = blocks.map((block) => {
    if (block.type !== "image") return block;
    const props = { ...(block.props ?? {}) } as Record<string, unknown>;
    let changed = false;
    if (props.textAlignment !== "center") { props.textAlignment = "center"; changed = true; }
    const width = Number(props.previewWidth);
    if (Number.isFinite(width) && width > MAX_IMAGE_WIDTH) { props.previewWidth = MAX_IMAGE_WIDTH; changed = true; }
    if (!changed) return block;
    report.images += 1;
    return { ...block, props };
  });

  return { blocks, report };
}

export function describeReport(report: AutoFormatReport): string {
  const parts: string[] = [];
  if (report.headings) parts.push(`заголовков: ${report.headings}`);
  if (report.paragraphsSplit) parts.push(`абзацев разбито: ${report.paragraphsSplit}`);
  if (report.paragraphsMerged) parts.push(`склеено строк: ${report.paragraphsMerged}`);
  if (report.boldTerms) parts.push(`выделено терминов: ${report.boldTerms}`);
  if (report.typography) parts.push(`правок знаков: ${report.typography}`);
  if (report.letterParts) parts.push(`письмо: приветствие и подпись отделены`);
  if (report.listsMade) parts.push(`пунктов списка: ${report.listsMade}`);
  if (report.images) parts.push(`картинок выровнено: ${report.images}`);
  if (report.technical) parts.push("похоже на команды, пути или лог: структуру и знаки не менял");
  if (report.removedEmpty) parts.push(`убрано пустых строк: ${report.removedEmpty}`);
  return parts.length ? "Автоформат: " + parts.join(", ") : "Автоформат: заметка уже оформлена, менять нечего";
}

const wordsOf = (text: string) => (text.toLowerCase().replace(/[*_`#>|-]+/g, " ").match(/[\p{L}\p{N}]+/gu) ?? []);

/**
 * How much of the source's word sequence is still in the result, 0..1 (longest common subsequence of words; markup characters are ignored).
 * A model that only formats keeps this near 1; a model that rewrites, shortens or invents drops it.
 */
export function wordSimilarity(source: string, result: string): number {
  const a = wordsOf(source), b = wordsOf(result);
  if (a.length === 0) return b.length === 0 ? 1 : 0;
  if (a.length > 3500 || b.length > 3500) {
    // too long for the exact method: compare the bags of words
    const bag = new Map<string, number>();
    for (const w of a) bag.set(w, (bag.get(w) ?? 0) + 1);
    let kept = 0;
    for (const w of b) { const n = bag.get(w) ?? 0; if (n > 0) { kept += 1; bag.set(w, n - 1); } }
    return kept / a.length;
  }
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length] / a.length;
}

/** The result is accepted as formatting only: the words stay (at least 98 %), nothing big is added (at most 8 % new words), numbers are intact. */
export function isFormattingOnly(source: string, result: string): { ok: boolean; reason: string } {
  const similarity = wordSimilarity(source, result);
  const lenRatio = wordsOf(result).length / Math.max(1, wordsOf(source).length);
  if (similarity < 0.98) return { ok: false, reason: `модель изменила слова (сохранено ${Math.round(similarity * 100)}%)` };
  if (lenRatio > 1.08) return { ok: false, reason: "модель добавила текст" };
  const numbers = (t: string) => (t.match(/\d+(?:[.,]\d+)?/g) ?? []).sort().join("|");
  if (numbers(source) !== numbers(result)) return { ok: false, reason: "изменились числа" };
  return { ok: true, reason: "" };
}
