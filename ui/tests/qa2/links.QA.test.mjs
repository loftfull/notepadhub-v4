// QA2: переименование ссылок. Запуск из папки ui: node --test tests/qa2/links.QA.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nh4-qa2-"));
const out = path.join(dir, "links.mjs");
await esbuild.build({ entryPoints: [path.resolve("src/wikiLinks.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const { renameLinkInBlocks, buildLinkIndex, wikiLinkText } = await import(pathToFileURL(out).href);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("QA2-L1: переименование в заголовок с '|' не должно рвать ссылку", () => {
  const blocks = [{ type: "paragraph", content: [{ type: "text", text: "см. [[Старое]]", styles: {} }], children: [] }];
  const r = renameLinkInBlocks(blocks, "Старое", "Вопросы | ответы");
  const docs = [{ id: "a", title: "Вопросы | ответы" }, { id: "b", title: "Другая" }];
  const idx = buildLinkIndex(docs, { a: [], b: r.blocks });
  assert.equal(idx.outgoing("b")[0]?.id, "a", "ссылка после переименования не ведёт на заметку: " + JSON.stringify(idx.outgoing("b")));
});

test("QA2-L2: вставленная ссылка на заметку с '|' в названии должна находить заметку", () => {
  const text = wikiLinkText("Вопросы | ответы");
  const blocks = [{ type: "paragraph", content: [{ type: "text", text, styles: {} }], children: [] }];
  const idx = buildLinkIndex([{ id: "a", title: "Вопросы | ответы" }, { id: "b", title: "B" }], { a: [], b: blocks });
  assert.equal(idx.outgoing("b")[0]?.id, "a");
});

test("QA2-L3: ссылки в ячейках таблицы переименовываются", () => {
  const table = { type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "[[Старое]]", styles: {} }]] }] }, children: [] };
  const r = renameLinkInBlocks([table], "Старое", "Новое");
  assert.equal(r.count, 1);
});

test("QA2-L4: WIKILINK_RE не тормозит на длинных строках (ReDoS)", () => {
  const { extractLinks } = { extractLinks: null };
  const re = /\[\[([^\[\]\n|]{1,120}?)(?:\|([^\[\]\n]{1,120}))?\]\]/g;
  for (const s of ["[[a".repeat(100000), "[[" + "a".repeat(300000), "[[a|" + "b".repeat(300000), "[[a]".repeat(100000)]) {
    const t = Date.now(); [...s.matchAll(re)]; assert.ok(Date.now() - t < 1000, "медленно: " + (Date.now() - t) + " мс");
  }
});

test("QA2-L5: A->B затем B->A (обмен) не зацикливается и не теряет ссылки", () => {
  const blocks = [{ type: "paragraph", content: [{ type: "text", text: "[[A]] и [[B]]", styles: {} }], children: [] }];
  const r1 = renameLinkInBlocks(blocks, "A", "B");   // отдельный проход: уже существующая [[B]] остаётся, ссылки сольются
  assert.equal(r1.blocks[0].content[0].text, "[[B]] и [[B]]");
});
