import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const esbuild = createRequire(import.meta.url)("esbuild");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nh4-ui-")), "search.mjs");
await esbuild.build({ entryPoints: [path.resolve("src/searchNotes.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const { searchNotes } = await import(pathToFileURL(out).href);

const para = (text) => [{ type: "paragraph", content: text, children: [] }];
const docs = [
  { id: "1", title: "Отчёт по проекту", lastOpenedAt: 1 },
  { id: "2", title: "Идеи", lastOpenedAt: 5 },
  { id: "3", title: "Корзина", deletedAt: 1 },
];
const contents = { 1: para("Итоги квартала"), 2: para("Нужно написать отчёт по проекту до пятницы"), 3: para("отчёт") };

test("title matches rank above body matches, deleted notes never appear", () => {
  const hits = searchNotes(docs, contents, {}, "отчёт");
  assert.deepEqual(hits.map((h) => h.doc.id), ["1", "2"]);
  assert.match(hits[1].snippet, /отчёт/);
});

test("every word must match (AND), tags are searched", () => {
  assert.deepEqual(searchNotes(docs, contents, {}, "отчёт пятницы").map((h) => h.doc.id), ["2"]);
  assert.deepEqual(searchNotes(docs, contents, { 1: "работа" }, "работа").map((h) => h.doc.id), ["1"]);
});

test("empty query lists notes by recent use", () => {
  assert.deepEqual(searchNotes(docs, contents, {}, "").map((h) => h.doc.id), ["2", "1"]);
});

test("a note gets up to three different snippets and a match count; splitHighlight marks the words", async () => {
  const { searchNotes: search, splitHighlight } = await import(pathToFileURL(out).href);
  const long = para("Кошки спят. " + "слово ".repeat(40) + " Кошки охотятся. " + "слово ".repeat(40) + " Кошки едят.");
  const hits = search([{ id: "9", title: "Звери", lastOpenedAt: 1 }], { 9: long }, {}, "кошки");
  assert.equal(hits[0].snippets.length, 3);
  assert.equal(hits[0].matches, 3);
  const parts = splitHighlight("Кошки спят, кошки едят", "кошки");
  assert.deepEqual(parts.filter((p) => p.hit).map((p) => p.text), ["Кошки", "кошки"]);
  assert.equal(parts.map((p) => p.text).join(""), "Кошки спят, кошки едят");
});
