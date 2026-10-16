// Lossless line format used as the plain-text mirror of a note (data-v3\notes-content\<id>.txt).
//
// Contract (see docs/adr/0002-storage-format.md):
//   textToBlocks(text) -> blocks -> blocksToText(blocks) gives the original lines back for every input,
//   so opening and saving an old plain-text note never rewrites its words.
// Only a handful of unambiguous line prefixes become structure; everything else stays a literal paragraph
// (this is deliberate: "# comment" in a .env, "- x" in a shell snippet, "1." inside prose must not be reinterpreted
// beyond what the same line produces again on save).

export type LooseBlock = {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: LooseBlock[];
};

const CHECK = /^- \[( |x)\] (.*)$/;
const BULLET = /^- (.*)$/;
const NUMBERED = /^(\d{1,4})\. (.*)$/;
const HEADING = /^(#{1,3}) (.*)$/;
const QUOTE = /^> ?(.*)$/;
const FENCE = /^```(\S*)\s*$/;
const IMAGE = /^!\[([^\]\n]*)\]\((\S+)\)$/;
const SEPARATOR_LINE = (cols: number) => "| " + Array.from({ length: cols }, () => SEPARATOR_CELL).join(" | ") + " |";

function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object") {
      const p = part as { type?: string; text?: unknown; content?: unknown };
      if (typeof p.text === "string") return p.text;
      if (p.type === "link") return inlineText(p.content);
    }
    return "";
  }).join("");
}

const SEPARATOR_CELL = "---";

function tableText(content: unknown): string[] {
  const table = content as { rows?: Array<{ cells?: unknown[] }>; headerRows?: number } | null;
  const rows = table?.rows;
  if (!Array.isArray(rows)) return [];
  const lines = rows.map((row) => "| " + (row.cells ?? []).map((cell) => {
    const c = cell as { content?: unknown } | unknown[];
    return inlineText(Array.isArray(c) ? c : (c as { content?: unknown }).content ?? c).replace(/\n/g, " ").replace(/\|/g, "\\|");
  }).join(" | ") + " |");
  // a header row is written the Markdown way: a separator line right under the first row
  if (table?.headerRows && lines.length > 0) lines.splice(1, 0, "| " + (rows[0].cells ?? []).map(() => SEPARATOR_CELL).join(" | ") + " |");
  return lines;
}

/** Splits `| a | b |` into cells, honouring \| escapes. Returns null unless the line is exactly the form tableText writes. */
function canonicalCells(line: string): string[] | null {
  if (!line.startsWith("| ") || !line.endsWith(" |")) return null;
  const inner = line.slice(2, -2);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") { current += "|"; i++; continue; }
    if (inner[i] === "|") {
      if (!current.endsWith(" ") || inner[i + 1] !== " ") return null;
      cells.push(current.slice(0, -1)); current = ""; i++;   // " | " separator: the space before it was collected, the one after is skipped
      continue;
    }
    current += inner[i];
  }
  cells.push(current);
  const rebuilt = "| " + cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ") + " |";
  return rebuilt === line ? cells : null;
}

const imageUrl = (url: unknown) => String(url ?? "").replace(/ /g, "%20").replace(/\)/g, "%29");

export function blocksToText(blocks: LooseBlock[]): string {
  const lines: string[] = [];
  const emit = (list: LooseBlock[], depth: number) => {
    let numbered = 0;
    for (const block of list) {
      const indent = "  ".repeat(depth);
      const text = inlineText(block.content);
      numbered = block.type === "numberedListItem" ? numbered + 1 : 0;
      switch (block.type) {
        case "heading": {
          const level = Math.min(3, Math.max(1, Number(block.props?.level ?? 1)));
          lines.push(`${"#".repeat(level)} ${text}`);
          break;
        }
        case "bulletListItem": lines.push(`${indent}- ${text}`); break;
        case "numberedListItem": lines.push(`${indent}${block.props?.start ? Number(block.props.start) + numbered - 1 : numbered}. ${text}`); break;
        case "checkListItem": lines.push(`${indent}- [${block.props?.checked === true ? "x" : " "}] ${text}`); break;
        case "quote": lines.push(`> ${text}`); break;
        case "codeBlock":
          lines.push("```" + String(block.props?.language ?? ""), ...text.split("\n"), "```");
          break;
        case "table": lines.push(...tableText(block.content)); break;
        case "image": {
          const alt = String(block.props?.caption || block.props?.name || "").replace(/[\]\n]/g, " ");
          const url = imageUrl(block.props?.url);
          lines.push(url ? `![${alt}](${url})` : `[image${alt ? ": " + alt : ""}]`);
          break;
        }
        case "video": case "audio": case "file": {
          const name = String(block.props?.name ?? block.props?.caption ?? "");
          lines.push(`[${block.type}${name ? ": " + name : ""}]`);
          break;
        }
        default: lines.push(...(text.length ? text.split("\n") : [""]));
      }
      if (block.children?.length) emit(block.children, depth + 1);
    }
  };
  emit(blocks, 0);
  // BlockNote always keeps a phantom empty paragraph at the end; it is not part of the user's text.
  if (lines.length > 1 && lines[lines.length - 1] === "" ) lines.pop();
  return lines.join("\n");
}

export function textToBlocks(input: string): LooseBlock[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const out: LooseBlock[] = [];
  // stack of the most recent list item per depth, for nesting
  const lastAtDepth: Array<LooseBlock | undefined> = [];
  let expectedNumber = 1;
  let i = 0;
  const push = (block: LooseBlock, depth: number) => {
    if (depth > 0) {
      const parent = lastAtDepth[depth - 1];
      if (parent) { (parent.children ??= []).push(block); lastAtDepth.length = depth; lastAtDepth[depth] = block; return true; }
      return false;
    }
    out.push(block);
    lastAtDepth.length = 0;
    lastAtDepth[0] = block;
    return true;
  };
  const paragraph = (raw: string) => { push({ type: "paragraph", content: raw }, 0); expectedNumber = 1; };

  while (i < lines.length) {
    const raw = lines[i];
    const fence = FENCE.exec(raw);
    if (fence) {
      const close = lines.findIndex((l, k) => k > i && l === "```");
      if (close > i) {
        push({ type: "codeBlock", props: { language: fence[1] || "text" }, content: lines.slice(i + 1, close).join("\n") }, 0);
        i = close + 1; expectedNumber = 1; continue;
      }
    }
    const lead = /^( *)/.exec(raw)![1].length;
    const depth = lead % 2 === 0 ? lead / 2 : -1;
    const body = depth >= 0 ? raw.slice(lead) : raw;
    let m: RegExpExecArray | null;

    if (depth === 0 && (m = HEADING.exec(body))) { push({ type: "heading", props: { level: m[1].length }, content: m[2] }, 0); expectedNumber = 1; i++; continue; }
    if (depth === 0 && (m = QUOTE.exec(body)) && body.startsWith("> ")) { push({ type: "quote", content: m[1] }, 0); expectedNumber = 1; i++; continue; }
    if (depth >= 0 && (m = CHECK.exec(body))) {
      if (push({ type: "checkListItem", props: { checked: m[1] === "x" }, content: m[2] }, depth)) { expectedNumber = 1; i++; continue; }
    } else if (depth >= 0 && (m = BULLET.exec(body))) {
      if (push({ type: "bulletListItem", content: m[1] }, depth)) { expectedNumber = 1; i++; continue; }
    } else if (depth >= 0 && (m = NUMBERED.exec(body))) {
      const n = Number(m[1]);
      if (depth > 0 || n === expectedNumber) {
        if (depth === 0 || n >= 1) {
          if (push({ type: "numberedListItem", content: m[2] }, depth)) { if (depth === 0) expectedNumber = n + 1; i++; continue; }
        }
      }
    }
    if (depth === 0 && raw.startsWith("| ")) {
      const table = readTable(lines, i);
      if (table) { push(table.block, 0); expectedNumber = 1; i = table.next; continue; }
      // somebody else's pipe lines: the whole run stays text, no fragment of it may turn into a table
      while (i < lines.length && lines[i].startsWith("|")) { paragraph(lines[i]); i++; }
      continue;
    }
    if (depth === 0 && (m = IMAGE.exec(raw))) {
      push({ type: "image", props: { url: m[2], caption: m[1], name: m[1] } }, 0);
      expectedNumber = 1; i++; continue;
    }
    paragraph(raw);
    i++;
  }
  if (out.length === 0) out.push({ type: "paragraph", content: "" });
  return out;
}


/** A run of canonical pipe rows (optional separator under the first) becomes a table; anything else stays plain paragraphs. */
function readTable(lines: string[], start: number): { block: LooseBlock; next: number } | null {
  const rows: string[][] = [];
  let header = false;
  let j = start;
  while (j < lines.length) {
    const line = lines[j];
    if (rows.length === 1 && !header && line === SEPARATOR_LINE(rows[0].length)) { header = true; j++; continue; }
    const cells = canonicalCells(line);
    if (!cells || cells.length < 2 || (rows.length > 0 && cells.length !== rows[0].length)) break;
    rows.push(cells); j++;
  }
  // a pipe line that is not in our own form (compact markdown, uneven rows) means this is somebody's markdown table: leave the whole run as text
  if (rows.length === 0 || (j < lines.length && lines[j].startsWith("|"))) return null;
  return {
    next: j,
    block: {
      type: "table",
      content: {
        type: "tableContent",
        columnWidths: rows[0].map(() => undefined),
        ...(header ? { headerRows: 1 } : {}),
        rows: rows.map((cells) => ({ cells: cells.map((text) => (text ? [{ type: "text", text, styles: {} }] : [])) })),
      },
    },
  };
}
