// Bundles src/hostAdapter.ts with esbuild (shipped with vite) and tests HostSync against a scripted host.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
globalThis.window = { location: { href: "http://localhost/" }, matchMedia: () => ({ matches: false }) };
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nh4-ui-")), "adapter.mjs");
await esbuild.build({
  stdin: { contents: `export * from "./hostAdapter.ts"; export { host } from "./bridge.ts";`, resolveDir: path.resolve("src"), loader: "ts" },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
});
const { HostSync, EDITOR_LIMIT_CHARS, host } = await import(pathToFileURL(out).href);

const para = (text) => [{ type: "paragraph", content: text, children: [] }];
const loaded = (notes) => ({
  state: { schemaVersion: 1, docs: [], contents: {}, activeId: null, folder: "Входящие", folders: ["Входящие"], dark: false, tags: {} },
  boot: { contract: 1, hostVersion: "t", mode: "host", projects: [{ id: "inbox", name: "Входящие", order: 0, isSystem: true, showInTabs: true }], notes, settings: { activeProjectId: "inbox", selectedNoteId: "", theme: "light", sidebarVisible: true } },
  projectIds: new Map([["Входящие", "inbox"]]),
});
const doc = (id, title) => ({ id, title, folder: "Входящие", updated: "", icon: "note" });
const input = (docs, contents) => ({ docs, contents, folders: ["Входящие"], tags: {}, activeId: null, folder: "Входящие", dark: false });

test("one oversized note is reported by name and does not stop the others from being saved", async () => {
  const sent = [];
  host.upsertNote = async (n) => { sent.push(n.id); return { id: n.id, updatedUtc: "" }; };
  host.saveSettings = async () => ({});
  const sync = new HostSync(loaded([]));
  const statuses = [];
  sync.setStatusHandler((s) => statuses.push(s));
  sync.push(input([doc("a", "Огромная"), doc("b", "Нормальная")], { a: para("я".repeat(EDITOR_LIMIT_CHARS + 10)), b: para("обычный текст") }));
  const result = await sync.flush();
  assert.deepEqual(sent, ["b"]);                                   // the normal note was saved
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.match(statuses.at(-1).message, /Огромная/);
  assert.equal(statuses.at(-1).state, "error");
});

test("a host error on one note is isolated and flush returns without waiting for retries", async () => {
  const sent = [];
  host.upsertNote = async (n) => { if (n.id === "bad") throw new Error("диск недоступен"); sent.push(n.id); return { id: n.id, updatedUtc: "" }; };
  host.saveSettings = async () => ({});
  const sync = new HostSync(loaded([]));
  sync.setStatusHandler(() => {});
  const started = Date.now();
  sync.push(input([doc("bad", "Сбойная"), doc("ok1", "Первая"), doc("ok2", "Вторая")], { bad: para("x"), ok1: para("1"), ok2: para("2") }));
  const result = await sync.flush();
  assert.ok(Date.now() - started < 1500, "flush must not wait for the retry timer");
  assert.deepEqual(sent.sort(), ["ok1", "ok2"]);
  assert.deepEqual(result, { ok: false, failed: 1 });
  sync.reset(loaded([]));                                          // stops the background retry timer
});

test("after a fix the failed note is saved on the next push and flush reports ok", async () => {
  let fail = true;
  host.upsertNote = async (n) => { if (fail && n.id === "x") throw new Error("временный сбой"); return { id: n.id, updatedUtc: "" }; };
  host.saveSettings = async () => ({});
  const sync = new HostSync(loaded([]));
  sync.setStatusHandler(() => {});
  const same = input([doc("x", "Заметка")], { x: para("текст") });
  sync.push(same);
  assert.equal((await sync.flush()).ok, false);
  fail = false;
  sync.push(same);                                                 // same content reference: the failed note must still be retried
  assert.deepEqual(await sync.flush(), { ok: true, failed: 0 });
  sync.reset(loaded([]));
});

test("an unchanged library sends nothing", async () => {
  let calls = 0;
  host.upsertNote = async () => { calls++; return { id: "", updatedUtc: "" }; };
  host.saveSettings = async () => ({});
  const contents = { n: para("текст") };
  const l = loaded([{ id: "n", title: "T", projectId: "inbox", tags: "", createdUtc: "", updatedUtc: "", lastOpenedUtc: "", isPinned: false, isArchived: false, isDeleted: false, externalOnly: false, legacySourceGuid: "", sourcePath: "", sourceType: "local", contentType: "text", content: "текст", blocksJson: null }]);
  l.state.contents = contents;
  const sync = new HostSync(l);
  sync.setStatusHandler(() => {});
  sync.push(input([doc("n", "T")], contents));
  assert.deepEqual(await sync.flush(), { ok: true, failed: 0 });
  assert.equal(calls, 0);
});

