/**
 * Checks of an AI answer against the text it was asked to change. The model is never trusted to be faithful:
 * numbers, addresses, tables and pictures are compared mechanically and every difference is shown before "Применить".
 */
export type AiCheck = { level: "ok" | "warn" | "error"; text: string };

const PREAMBLE = /^(?:вот|конечно|хорошо|ниже|разумеется|безусловно|итак|исправленн|переписанн|сокращённ|результат|итоговый|готово)[^\n]{0,100}[:：]\s*\n+/i;

/** Removes what models add around the answer: an introduction line, a code fence, leaked block labels, wrapping quotes. */
export function cleanModelText(output: string, source: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  let text = output.trim();
  if (/^```[^\n]*\n[\s\S]*\n```$/.test(text) && !source.includes("```")) {
    text = text.replace(/^```[^\n]*\n/, "").replace(/\n```$/, "").trim();
    notes.push("убрана обёртка из блока кода");
  }
  if (PREAMBLE.test(text) && !PREAMBLE.test(source)) {
    text = text.replace(PREAMBLE, "").trim();
    notes.push("убрано вступление модели");
  }
  if (!/\[B\d+\]/.test(source) && /\[B\d+\]/.test(text)) {
    text = text.replace(/\[B\d+\]\s?/g, "").trim();
    notes.push("убраны служебные метки блоков");
  }
  const quoted = /^[«"“].*[»"”]$/s.test(text) && !/^[«"“]/.test(source.trim());
  if (quoted && !/[«»"“”]/.test(text.slice(1, -1))) {
    text = text.slice(1, -1).trim();
    notes.push("убраны кавычки вокруг ответа");
  }
  return { text, notes };
}

const NUMBER = /\d+(?:[.,]\d+)?/g;
const ADDRESS = /https?:\/\/[^\s)>\]]+|[\w.+-]+@[\w-]+\.[\w.-]+/g;
const addresses = (text: string) => (text.match(ADDRESS) ?? []).map((a) => a.replace(/[.,;:!?]+$/, ""));   // a full stop after a link is not part of it

const count = (items: string[]) => { const map = new Map<string, number>(); for (const item of items) map.set(item, (map.get(item) ?? 0) + 1); return map; };
/** items of `a` that are not matched by `b` (multiset difference) */
function minus(a: string[], b: string[]): string[] {
  const left = count(b);
  const out: string[] = [];
  for (const item of a) { const n = left.get(item) ?? 0; if (n > 0) left.set(item, n - 1); else out.push(item); }
  return out;
}
const list = (items: string[]) => [...new Set(items)].slice(0, 6).join(", ") + (new Set(items).size > 6 ? "…" : "");
const cyrillicShare = (text: string) => { const letters = text.match(/\p{L}/gu) ?? []; return letters.length ? (text.match(/[Ѐ-ӿ]/g) ?? []).length / letters.length : 0; };

export function checkProposal(operation: string, source: string, output: string): AiCheck[] {
  const checks: AiCheck[] = [];
  if (operation === "analyze" || operation === "summarize") return checks;
  const edit = operation !== "custom" && operation !== "continue";
  const exact = operation === "proofread" || operation === "rewrite" || operation === "structure";

  const missingNumbers = minus(source.match(NUMBER) ?? [], output.match(NUMBER) ?? []);
  const addedNumbers = minus(output.match(NUMBER) ?? [], source.match(NUMBER) ?? []);
  if (missingNumbers.length && operation !== "continue") checks.push({ level: exact || operation === "expand" ? "error" : "warn", text: `Исчезли или изменились числа: ${list(missingNumbers)}` });
  if (addedNumbers.length) checks.push({ level: operation === "expand" || operation === "continue" || operation === "custom" ? "warn" : "error", text: `Появились числа, которых не было в тексте: ${list(addedNumbers)}` });

  const missingAddresses = minus(addresses(source), addresses(output));
  const addedAddresses = minus(addresses(output), addresses(source));
  if (missingAddresses.length) checks.push({ level: operation === "shorten" ? "warn" : "error", text: `Пропали ссылки или адреса: ${list(missingAddresses)}` });
  if (addedAddresses.length) checks.push({ level: "error", text: `Появились ссылки или адреса, которых не было: ${list(addedAddresses)}` });

  if (edit) {
    const rows = (text: string) => text.split("\n").filter((line) => line.startsWith("| ")).length;
    const pictures = (text: string) => (text.match(/!\[[^\]\n]*\]\([^)\s]+\)/g) ?? []).length;
    if (rows(source) !== rows(output)) checks.push({ level: "error", text: `Изменилась таблица: строк было ${rows(source)}, стало ${rows(output)}` });
    if (pictures(source) !== pictures(output)) checks.push({ level: "error", text: `Изменились изображения: было ${pictures(source)}, стало ${pictures(output)}` });
  }

  if (source.trim().length >= 20) {
    const ratio = output.length / source.length;
    if (operation === "proofread" && (ratio < 0.7 || ratio > 1.3)) checks.push({ level: "warn", text: `Объём изменился на ${Math.round((ratio - 1) * 100)}% — для исправления ошибок это много` });
    if (operation === "shorten" && ratio >= 1) checks.push({ level: "warn", text: "Результат не короче исходного текста" });
    else if (operation === "shorten" && source.length >= 300 && ratio > 0.85) checks.push({ level: "warn", text: `Текст сократился всего на ${Math.round((1 - ratio) * 100)}%: модель почти повторила исходник` });
    if (operation === "expand" && ratio < 1) checks.push({ level: "warn", text: "Результат короче исходного текста" });
    else if (operation === "expand" && source.length >= 300 && ratio < 1.15) checks.push({ level: "warn", text: "Текст почти не расширен: модель почти повторила исходник" });
    if (operation === "continue" && ratio < 1.05) checks.push({ level: "warn", text: "Продолжения нет: модель вернула текст без добавлений" });
    if (operation === "structure" && ratio < 0.85) checks.push({ level: "warn", text: `Текст стал короче на ${Math.round((1 - ratio) * 100)}%: возможно, что-то потеряно` });
    if (operation === "rewrite" && (ratio < 0.5 || ratio > 2)) checks.push({ level: "warn", text: `Объём изменился на ${Math.round((ratio - 1) * 100)}%` });
    if (Math.abs(cyrillicShare(source) - cyrillicShare(output)) > 0.4) checks.push({ level: "warn", text: "Язык ответа отличается от языка исходного текста" });
  }

  if (checks.length === 0) checks.push({ level: "ok", text: "Числа, ссылки, таблицы, изображения и язык сохранены" });
  return checks;
}

export type DiffPart = { kind: "same" | "del" | "ins"; text: string };

/** Word-level difference (longest common subsequence). Returns null for very long texts, where the plain before/after view is used. */
export function wordDiff(before: string, after: string): DiffPart[] | null {
  const a = before.split(/(\s+)/).filter((t) => t.length > 0);
  const b = after.split(/(\s+)/).filter((t) => t.length > 0);
  if (a.length * b.length > 2_500_000) return null;
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => { const last = parts[parts.length - 1]; if (last && last.kind === kind) last.text += text; else parts.push({ kind, text }); };
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push("same", a[i]); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { push("del", a[i]); i++; }
    else { push("ins", b[j]); j++; }
  }
  while (i < a.length) push("del", a[i++]);
  while (j < b.length) push("ins", b[j++]);
  return parts;
}
