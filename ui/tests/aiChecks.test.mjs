import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const esbuild = createRequire(import.meta.url)("esbuild");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nh4-ui-")), "ai.mjs");
await esbuild.build({ stdin: { contents: 'export * from "./aiChecks.ts"; export * from "./aiLimits.ts";', resolveDir: path.resolve("src"), loader: "ts" }, bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const { cleanModelText, checkProposal, wordDiff, outputTokensFor } = await import(pathToFileURL(out).href);

test("answer sizes match the host's AiLimits values", () => {
  assert.equal(outputTokensFor("proofread", 100), 256);
  assert.equal(outputTokensFor("proofread", 6000), 3964);
  assert.equal(outputTokensFor("rewrite", 24000), 4096);
  assert.equal(outputTokensFor("analyze", 24000), 1536);
  assert.equal(outputTokensFor("structure", 20000), 6000);
  assert.equal(outputTokensFor("summarize", 5), 600);
  assert.ok(outputTokensFor("shorten", 6000) < outputTokensFor("expand", 6000));
});

test("model wrappers are removed only when the source did not have them", () => {
  assert.deepEqual(cleanModelText("Вот исправленный текст:\n\nПривет, мир.", "Превет мир"), { text: "Привет, мир.", notes: ["убрано вступление модели"] });
  assert.equal(cleanModelText("```\nкод\n```", "код").text, "код");
  assert.equal(cleanModelText("```\nкод\n```", "```\nкод\n```").text, "```\nкод\n```");
  assert.equal(cleanModelText("[B1] текст", "текст").text, "текст");
  assert.equal(cleanModelText("[B1] текст", "[B1] текст").text, "[B1] текст");
  assert.equal(cleanModelText("«Готовый текст»", "готовый текст").text, "Готовый текст");
});

test("a faithful proofreading passes every check", () => {
  const checks = checkProposal("proofread", "Встреча 12 марта в 14:30, звоните +7 495 123-45-67 или на a@b.ru", "Встреча 12 марта в 14:30, звоните +7 495 123-45-67 или на a@b.ru.");
  assert.deepEqual(checks.map((c) => c.level), ["ok"]);
});

test("changed or invented numbers are errors for proofreading, only warnings for expanding", () => {
  const source = "Сумма 1500 рублей до 12 марта";
  const bad = checkProposal("proofread", source, "Сумма 2500 рублей до 12 марта");
  assert.ok(bad.some((c) => c.level === "error" && c.text.includes("1500")));
  assert.ok(bad.some((c) => c.level === "error" && c.text.includes("2500")));
  const grown = checkProposal("expand", source, "Сумма 1500 рублей до 12 марта, то есть примерно за 3 недели");
  assert.ok(grown.some((c) => c.level === "warn" && c.text.includes("3")));
  assert.ok(!grown.some((c) => c.level === "error"));
});

test("dropped links, tables and pictures are errors", () => {
  const source = "см. https://example.test/a\n| a | b |\n| c | d |\n![схема](https://x.test/p.png)";
  const lost = checkProposal("rewrite", source, "см. страницу\n| a | b |\n");
  assert.ok(lost.some((c) => c.text.startsWith("Пропали ссылки")));
  assert.ok(lost.some((c) => c.text.startsWith("Изменилась таблица")));
  assert.ok(lost.some((c) => c.text.startsWith("Изменились изображения")));
});

test("size and language sanity checks", () => {
  const source = "Это достаточно длинный русский текст для проверки объёма ответа.";
  assert.ok(checkProposal("proofread", source, "Коротко.").some((c) => c.level === "warn" && c.text.startsWith("Объём")));
  assert.ok(checkProposal("shorten", source, source + " и ещё").some((c) => c.text.startsWith("Результат не короче")));
  assert.ok(checkProposal("rewrite", source, "This is a sufficiently long English text for checking the volume.").some((c) => c.text.startsWith("Язык ответа")));
});

test("analysis and summaries are not compared with the source", () => {
  assert.deepEqual(checkProposal("analyze", "a 1", "{}"), []);
  assert.deepEqual(checkProposal("summarize", "a 1", "short"), []);
});

test("word diff marks only what changed and rebuilds both texts", () => {
  const before = "Это тест с ошибкой в слове";
  const after = "Это тест без ошибки в слове";
  const parts = wordDiff(before, after);
  assert.equal(parts.filter((p) => p.kind !== "ins").map((p) => p.text).join(""), before);
  assert.equal(parts.filter((p) => p.kind !== "del").map((p) => p.text).join(""), after);
  assert.ok(parts.some((p) => p.kind === "del" && p.text.includes("с")));
  assert.ok(parts.some((p) => p.kind === "ins" && p.text.includes("без")));
  assert.equal(wordDiff("а ".repeat(2000), "б ".repeat(2000)), null);
});

test("an almost unchanged shorten, expand or continue result is flagged (the small model echoes its input)", () => {
  const source = "Слово ".repeat(80).trim();
  assert.ok(checkProposal("shorten", source, source.slice(0, Math.floor(source.length * 0.95))).some((c) => c.text.includes("сократился всего")));
  assert.ok(checkProposal("expand", source, source + " ещё").some((c) => c.text.includes("почти не расширен")));
  assert.ok(checkProposal("continue", source, source).some((c) => c.text.startsWith("Продолжения нет")));
  assert.ok(!checkProposal("continue", source, source + " Новая мысль продолжает текст дальше в том же духе и добавляет несколько слов.").some((c) => c.text.startsWith("Продолжения нет")));
});
