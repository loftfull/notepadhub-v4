// [[links]]: parsing, aliases, title matching, backlinks, per-note cache.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nh4-ui-")), "links.mjs");
await esbuild.build({ entryPoints: [path.resolve("src/wikiLinks.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const { extractLinks, buildLinkIndex, normTitle, wikiLinkText } = await import(pathToFileURL(out).href);

const para = (text) => [{ type: "paragraph", content: text, children: [] }];

test("extracts links, ignores duplicates and malformed brackets", () => {
  const links = extractLinks("См. [[Проект А]], ещё [[проект  а]] и [[Идеи|мои идеи]]; [[ ]] и [[a\nb]] не ссылки, [одна скобка] тоже.");
  assert.deepEqual(links.map((l) => l.target), ["Проект А", "Идеи"]);
});

test("title matching is case- and whitespace-insensitive", () => {
  assert.equal(normTitle("  Проект   А "), normTitle("проект а"));
});

test("backlinks point from the mentioning note to the target, self links are ignored", () => {
  const docs = [{ id: "a", title: "Проект А" }, { id: "b", title: "Дневник" }, { id: "c", title: "Старое", deletedAt: 1 }];
  const contents = { a: para("Сам на себя [[Проект А]]"), b: para("Работал над [[проект а]] и [[Нет такой]]"), c: para("[[Проект А]]") };
  const index = buildLinkIndex(docs, contents);
  assert.deepEqual(index.backlinks("a").map((l) => l.id), ["b"]);
  assert.match(index.backlinks("a")[0].snippet, /проект а/i);
  assert.deepEqual(index.outgoing("b").map((l) => [l.target, l.id]), [["проект а", "a"], ["Нет такой", null]]);
});

test("inserted link text strips brackets and pipes from the title", () => {
  assert.equal(wikiLinkText("A [x] | b"), "[[A x b]]");
});

test("parsing is cached per blocks array (typing in one note does not re-parse the others)", () => {
  const docs = [{ id: "a", title: "A" }];
  const blocks = para("[[B]]");
  const first = buildLinkIndex(docs, { a: blocks }).outgoing("a");
  const second = buildLinkIndex(docs, { a: blocks }).outgoing("a");
  assert.equal(first[0].snippet, second[0].snippet);
});

const { renameLinkInBlocks, renameLinkInText } = await import(pathToFileURL(out).href);

test("renaming rewrites links, keeps aliases, ignores other titles", () => {
  const r = renameLinkInText("см. [[Старое]], [[старое|подпись]] и [[Другое]]", "Старое", "Новое");
  assert.equal(r.text, "см. [[Новое]], [[Новое|подпись]] и [[Другое]]");
  assert.equal(r.count, 2);
});

test("renaming walks styled runs, link labels and nested children; untouched blocks keep identity", () => {
  const blocks = [
    { type: "paragraph", content: [{ type: "text", text: "до [[Старое]] после", styles: { bold: true } }], children: [
      { type: "paragraph", content: "вложенный [[Старое]]", children: [] },
    ] },
    { type: "paragraph", content: "без ссылок", children: [] },
  ];
  const r = renameLinkInBlocks(blocks, "Старое", "Новое");
  assert.equal(r.count, 2);
  assert.equal(r.blocks[0].content[0].text, "до [[Новое]] после");
  assert.deepEqual(r.blocks[0].content[0].styles, { bold: true });
  assert.equal(r.blocks[0].children[0].content, "вложенный [[Новое]]");
  const same = renameLinkInBlocks(blocks, "Нет такой", "X");
  assert.equal(same.blocks, blocks);
  assert.equal(same.count, 0);
});

test("titles with brackets or pipes resolve the same way on both sides of the index", () => {
  assert.equal(normTitle("Заметка [[ссылка]] | хвост"), normTitle("Заметка ссылка хвост"));
  const index = buildLinkIndex([{ id: "a", title: "Заметка [x] | y" }, { id: "b", title: "B" }], { a: para(""), b: para("см. [[Заметка x y]]") });
  assert.deepEqual(index.backlinks("a").map((l) => l.id), ["b"]);
});
