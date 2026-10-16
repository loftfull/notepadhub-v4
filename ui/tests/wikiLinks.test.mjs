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
const { extractLinks, buildLinkIndex, normTitle, wikiLinkText, planLinkRenames } = await import(pathToFileURL(out).href);

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

test("renaming rewrites links inside table cells and keeps an untouched table identical", () => {
  const cell = (text) => [{ type: "text", text, styles: {} }];
  const table = {
    type: "table",
    content: { type: "tableContent", rows: [{ cells: [cell("см. [[Старое]]"), cell("обычный текст")] }, { cells: [cell("[[Старое|подпись]]"), cell("[[Другое]]")] }] },
    children: [],
  };
  const r = renameLinkInBlocks([table], "Старое", "Новое");
  assert.equal(r.count, 2);
  assert.equal(r.blocks[0].content.rows[0].cells[0][0].text, "см. [[Новое]]");
  assert.equal(r.blocks[0].content.rows[1].cells[0][0].text, "[[Новое|подпись]]");
  assert.equal(r.blocks[0].content.rows[0].cells[1][0].text, "обычный текст");
  assert.equal(r.blocks[0].content.rows[1].cells[1][0].text, "[[Другое]]");
  const same = renameLinkInBlocks([table], "Нет такой", "X");
  assert.equal(same.blocks[0], table);
  assert.equal(same.count, 0);
});

test("дубли заголовков: ссылка ведёт на последнюю открытую заметку, выбор детерминирован", () => {
  const docs = [
    { id: "stale", title: "Дубликат", lastOpenedAt: 100 },
    { id: "fresh", title: "дубликат ", lastOpenedAt: 500 },   // то же имя после нормализации, открыта позже
    { id: "never", title: "Дубликат" },                        // без lastOpenedAt — не перетягивает
    { id: "other", title: "Другая" },
  ];
  const index = buildLinkIndex(docs, {});
  assert.equal(index.byTitle.get("дубликат"), "fresh");
  assert.equal(index.byTitle.get("другая"), "other");
  // перестройка индекса в том же порядке даёт тот же выбор
  assert.equal(buildLinkIndex(docs, {}).byTitle.get("дубликат"), "fresh");
});

test("дубли без сведений об открытии: стабильно выбирается первая заметка", () => {
  const docs = [
    { id: "a", title: "Заметка" },
    { id: "b", title: "заметка" },
  ];
  assert.equal(buildLinkIndex(docs, {}).byTitle.get("заметка"), "a");
});

test("удалённая заметка не выигрывает дубль заголовка", () => {
  const docs = [
    { id: "live", title: "Имя", lastOpenedAt: 10 },
    { id: "trashed", title: "Имя", lastOpenedAt: 999, deletedAt: "2026-10-16" },
  ];
  assert.equal(buildLinkIndex(docs, {}).byTitle.get("имя"), "live");
});

test("planLinkRenames: переписывает [[ссылки]] у других заметок и обновляет settled", () => {
  const settled = new Map([["n1", "Старое"]]);
  const live = [{ id: "n1", title: "Новое" }, { id: "n2", title: "Читатель" }];
  const contents = { n2: para("См. [[Старое]] и [[Другое]].") };
  const plan = planLinkRenames(live, contents, settled);
  assert.equal(plan.total, 1);
  assert.deepEqual(Object.keys(plan.updates), ["n2"]);
  assert.equal(plan.updates.n2[0].content, "См. [[Новое]] и [[Другое]].");
  assert.equal(settled.get("n1"), "Новое");
});

test("planLinkRenames: без устоявшегося «до» ничего не делает, но запоминает заголовки", () => {
  const settled = new Map();
  const live = [{ id: "n1", title: "A" }, { id: "n2", title: "B" }];
  const plan = planLinkRenames(live, { n2: para("[[A]]") }, settled);
  assert.equal(plan.total, 0);
  assert.deepEqual(plan.updates, {});
  assert.equal(settled.get("n1"), "A");
  assert.equal(settled.get("n2"), "B");
});

test("planLinkRenames: write-through не переписывается, неоднозначное переименование пропускается", () => {
  const settled = new Map([["n1", "Старое"]]);
  const live = [
    { id: "n1", title: "Новое" },
    { id: "n2", title: "Читатель", writeThrough: true },
    { id: "n3", title: "Старое" },           // старое название занято другой живой заметкой
  ];
  const contents = { n2: para("[[Старое]]"), n3: para("[[Старое]]") };
  const plan = planLinkRenames(live, contents, settled);
  assert.equal(plan.total, 0);
  assert.deepEqual(plan.updates, {});
});

test("planLinkRenames: цепочка переименований за один проход применяется последовательно", () => {
  const settled = new Map([["n1", "Alpha"], ["n2", "Beta"]]);
  const live = [{ id: "n1", title: "Gamma" }, { id: "n2", title: "Delta" }, { id: "n3", title: "Читатель" }];
  const contents = { n3: para("[[Alpha]] и [[Beta]]") };
  const plan = planLinkRenames(live, contents, settled);
  assert.equal(plan.total, 2);
  // второе переименование применено поверх результата первого (updates как источник), а не исходного текста
  assert.equal(plan.updates.n3[0].content, "[[Gamma]] и [[Delta]]");
});
