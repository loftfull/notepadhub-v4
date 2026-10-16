// Markdown from the AI as the user should see it: headings are headings, **bold** is bold, lists are lists.
// Pure functions without dependencies, so the same reader serves the proposal preview, the plain-text diff and the "Apply" step.

export type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

export type MdBlock =
  | { kind: "h"; level: 1 | 2 | 3; inlines: Inline[] }
  | { kind: "p"; inlines: Inline[] }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "ul"; items: Inline[][] }
  | { kind: "ol"; items: Inline[][] }
  | { kind: "code"; text: string };

const INLINE = /\*\*([^*\n]+?)\*\*|`([^`\n]+?)`|\[([^\]\n]+?)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)|\*([^*\s][^*\n]*?)\*|(?<![\p{L}\p{N}])_([^_\s][^_\n]*?)_(?![\p{L}\p{N}])/gu;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: src.slice(last, at) });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) out.push({ text: m[2], code: true });
    else if (m[3] !== undefined) out.push({ text: m[3], href: m[4] });
    else out.push({ text: m[5] ?? m[6] ?? "", italic: true });
    last = at + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out.length ? out : [{ text: "" }];
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ kind: "p", inlines: parseInline(para.join(" ")) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "h", level: Math.min(heading[1].length, 3) as 1 | 2 | 3, inlines: parseInline(heading[2]) });
      continue;
    }
    const bullet = /^\s*[-*+•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? "ul" : "ol";
      const items: Inline[][] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const m = (kind === "ul" ? /^\s*[-*+•]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/).exec(lines[j]);
        if (!m) break;
        items.push(parseInline(m[1]));
      }
      blocks.push(kind === "ul" ? { kind: "ul", items } : { kind: "ol", items });
      i = j - 1;
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { flush(); blocks.push({ kind: "quote", inlines: parseInline(quote[1]) }); continue; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

const plain = (inlines: Inline[]) => inlines.map((part) => part.text).join("");

/** The text without markup characters: for the word diff and for counting. Blocks are separated by a line break. */
export function stripMarkdown(text: string): string {
  return parseMarkdown(text).map((block) => {
    if (block.kind === "code") return block.text;
    if (block.kind === "ul") return block.items.map((item) => `• ${plain(item)}`).join("\n");
    if (block.kind === "ol") return block.items.map((item, index) => `${index + 1}. ${plain(item)}`).join("\n");
    return plain(block.inlines);
  }).join("\n");
}

export type RichText =
  | { type: "text"; text: string; styles: Record<string, boolean> }
  | { type: "link"; href: string; content: Array<{ type: "text"; text: string; styles: Record<string, boolean> }> };

/** Inline Markdown as BlockNote inline content, so applying a proposal keeps bold, italic, code and links. */
export function toInlineContent(src: string): RichText[] {
  return parseInline(src).filter((part) => part.text).map((part): RichText => {
    const styles: Record<string, boolean> = {};
    if (part.bold) styles.bold = true;
    if (part.italic) styles.italic = true;
    if (part.code) styles.code = true;
    const text = { type: "text" as const, text: part.text, styles };
    return part.href ? { type: "link", href: part.href, content: [text] } : text;
  });
}

/** True when the text carries Markdown that the preview and the apply step would turn into formatting. */
export function hasMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}#{1,6}\s|(^|\n)\s*([-*+•]|\d+[.)])\s|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:/.test(text);
}
