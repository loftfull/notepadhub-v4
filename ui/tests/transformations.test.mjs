import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/loadTs.mjs";
const { TRANSFORMATIONS, DEFAULT_SELECTION, normalizeSelection, loadSelection, insightMarkdown, MAX_INSTRUCTION, INSIGHTS_HEADING } = await loadTs("../src/transformations.ts");

test("five transformations, two on by default, ids are unique", () => {
  assert.equal(TRANSFORMATIONS.length, 5);
  assert.deepEqual(DEFAULT_SELECTION, ["summary", "keypoints"]);
  assert.equal(new Set(TRANSFORMATIONS.map((item) => item.id)).size, 5);
});

test("every custom prompt fits the model instruction limit", () => {
  for (const item of TRANSFORMATIONS) if (item.mode === "custom") assert.ok(item.prompt.length > 20 && item.prompt.length <= MAX_INSTRUCTION, item.id);
});

test("selection keeps catalogue order and drops unknown ids", () => {
  assert.deepEqual(normalizeSelection(["toc", "nope", "summary"]), ["summary", "toc"]);
  assert.deepEqual(normalizeSelection("junk"), []);
});

test("stored selection: missing -> defaults, empty list stays empty, broken json -> defaults", () => {
  const store = (value) => ({ getItem: () => value });
  assert.deepEqual(loadSelection(store(null)), DEFAULT_SELECTION);
  assert.deepEqual(loadSelection(store("[]")), []);
  assert.deepEqual(loadSelection(store("{oops")), DEFAULT_SELECTION);
  assert.deepEqual(loadSelection(store('["questions"]')), ["questions"]);
});

test("insight markdown carries title, answer and provenance; group heading only once", () => {
  const first = insightMarkdown("Краткое содержание", "Текст ответа.", "qwen3:4b", new Date(2026, 9, 15), true);
  assert.match(first, new RegExp(`^## ${INSIGHTS_HEADING}\n\n### Краткое содержание\n\nТекст ответа\.`));
  assert.match(first, /\*Создано ИИ · qwen3:4b · 15\.10\.2026\*$/);
  const next = insightMarkdown("Ключевые пункты", "- один", "qwen3:4b", new Date(2026, 9, 15), false);
  assert.doesNotMatch(next, /## Инсайты ИИ/);
  assert.match(next, /^### Ключевые пункты/);
});

test("a repeated title heading from the model is not doubled", () => {
  const out = insightMarkdown("Краткое содержание", "## Краткое содержание\n\nТекст.", "m", new Date(2026, 0, 1), false);
  assert.equal((out.match(/Краткое содержание/g) ?? []).length, 1);
});

const { sanitizeCustom, loadCustom, saveCustom, newCustomId } = await loadTs("../src/transformations.ts");

test("custom transformations are validated, saved and reloaded", () => {
  const ok = sanitizeCustom({ id: newCustomId(), title: "  Сроки   и даты ", prompt: "Выпиши все даты и сроки списком." });
  assert.equal(ok?.title, "Сроки и даты");
  assert.equal(ok?.custom, true);
  assert.equal(sanitizeCustom({ id: "x", title: "Сроки", prompt: "Выпиши все даты." }), null);
  assert.equal(sanitizeCustom({ id: ok.id, title: "С", prompt: "Выпиши все даты." }), null);
  assert.equal(sanitizeCustom({ id: ok.id, title: "Сроки", prompt: "коротко" }), null);
  assert.equal(sanitizeCustom({ id: ok.id, title: "Сроки", prompt: "я".repeat(901) }), null);
  const store = new Map();
  saveCustom({ setItem: (k, v) => store.set(k, v) }, [ok]);
  const back = loadCustom({ getItem: (k) => store.get(k) ?? null });
  assert.equal(back.length, 1);
  assert.equal(back[0].prompt, ok.prompt);
  assert.deepEqual(loadCustom({ getItem: () => "не json" }), []);
});
