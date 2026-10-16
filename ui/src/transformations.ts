// Ready-made transformations: a saved prompt that is run on a material and stored as an "insight" next to (never inside) the original text.
// The set follows what the strongest products offer (Open Notebook: summaries, key insights, questions, table of contents;
// Notion: summary / key info; Readwise: summary) and stays small on purpose.

export type Transformation = {
  id: string;
  /** a transformation the owner wrote */
  custom?: boolean;
  title: string;
  hint: string;
  /** "analyze" uses the structured analysis the app already had; "custom" sends `prompt` as the instruction. */
  mode: "custom" | "analyze";
  prompt: string;
  defaultOn: boolean;
};

export const INSIGHTS_HEADING = "Инсайты ИИ";
export const MAX_INSTRUCTION = 1000;

export const TRANSFORMATIONS: Transformation[] = [
  { id: "summary", title: "Краткое содержание", hint: "5–7 предложений о главном", mode: "custom", defaultOn: true,
    prompt: "Сделай краткое содержание материала: 5–7 предложений о главном. Только факты из текста, без домыслов и оценок. Пиши по-русски, без вступления." },
  { id: "keypoints", title: "Ключевые пункты", hint: "список главных мыслей и фактов", mode: "custom", defaultOn: true,
    prompt: "Выдели ключевые пункты материала маркированным списком: главные мысли, факты, цифры, решения. От 5 до 10 пунктов, каждый одной строкой. Ничего не придумывай." },
  { id: "questions", title: "Вопросы для размышления", hint: "что стоит уточнить или проверить", mode: "custom", defaultOn: false,
    prompt: "Составь 5–7 вопросов, которые помогут глубже разобраться в материале: что неясно, что стоит проверить, какие выводы спорны. Нумерованный список, вопросы короткие." },
  { id: "toc", title: "Оглавление", hint: "темы по порядку", mode: "custom", defaultOn: false,
    prompt: "Составь оглавление материала: темы и подтемы по порядку их появления в тексте. Маркированный список, без пояснений." },
  { id: "analysis", title: "Структурный анализ", hint: "факты, решения, действия, риски, вопросы", mode: "analyze", defaultOn: false,
    prompt: "" },
];

export const DEFAULT_SELECTION = TRANSFORMATIONS.filter((item) => item.defaultOn).map((item) => item.id);

export function findTransformation(id: string): Transformation | undefined {
  return TRANSFORMATIONS.find((item) => item.id === id);
}

/** Keeps only known ids, in the order of the catalogue (so insights always appear in the same order). */
export function normalizeSelection(ids: unknown, list: Transformation[] = TRANSFORMATIONS): string[] {
  const wanted = new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  return list.filter((item) => wanted.has(item.id)).map((item) => item.id);
}

export function loadSelection(storage: Pick<Storage, "getItem">, list: Transformation[] = TRANSFORMATIONS): string[] {
  try {
    const raw = storage.getItem("nh4-transformations");
    if (raw === null) return DEFAULT_SELECTION;
    return normalizeSelection(JSON.parse(raw), list);
  } catch {
    return DEFAULT_SELECTION;
  }
}

// ---- the owner's own transformations (kept on this computer)

export const CUSTOM_KEY = "nh4-custom-transformations";
export const MAX_CUSTOM = 20;
export const MAX_CUSTOM_PROMPT = 900;   // the model instruction is limited to 1000 characters

/** A valid custom transformation or null: a title of 2-40 characters, a prompt of 8-900 characters. */
export function sanitizeCustom(input: unknown): Transformation | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim() : "";
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  const id = typeof o.id === "string" && /^c-[a-z0-9-]{3,40}$/.test(o.id) ? o.id : "";
  if (!id || title.length < 2 || title.length > 40 || prompt.length < 8 || prompt.length > MAX_CUSTOM_PROMPT) return null;
  return { id, custom: true, title, hint: "своя трансформация", mode: "custom", prompt, defaultOn: false };
}

export function loadCustom(storage: Pick<Storage, "getItem">): Transformation[] {
  try {
    const raw = JSON.parse(storage.getItem(CUSTOM_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>(TRANSFORMATIONS.map((t) => t.id));
    const out: Transformation[] = [];
    for (const item of raw) { const t = sanitizeCustom(item); if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); } if (out.length >= MAX_CUSTOM) break; }
    return out;
  } catch {
    return [];
  }
}

export function saveCustom(storage: Pick<Storage, "setItem">, list: Transformation[]): void {
  storage.setItem(CUSTOM_KEY, JSON.stringify(list.filter((t) => t.custom).slice(0, MAX_CUSTOM).map((t) => ({ id: t.id, title: t.title, prompt: t.prompt }))));
}

export function newCustomId(): string {
  return "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

export function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** The insight as Markdown for the editor: a title, the answer and a provenance line. */
export function insightMarkdown(title: string, body: string, model: string, date: Date, withGroupHeading: boolean): string {
  const cleanBody = body.trim().replace(/^#{1,6}\s+.*\n+/, (match) => match.toLowerCase().includes(title.toLowerCase()) ? "" : match);
  const lines: string[] = [];
  if (withGroupHeading) lines.push(`## ${INSIGHTS_HEADING}`, "");
  lines.push(`### ${title}`, "", cleanBody, "", `*Создано ИИ · ${model} · ${formatDate(date)}*`);
  return lines.join("\n");
}
