import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const esbuild = createRequire(import.meta.url)("esbuild");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nh4-ui-")), "shortcuts.mjs");
await esbuild.build({ entryPoints: [path.resolve("src/shortcuts.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const { matchShortcut, SHORTCUT_HELP } = await import(pathToFileURL(out).href);

const ev = (code, extra = {}) => ({ code, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...extra });

test("shortcuts are matched by physical key, so the Russian layout works (key is not consulted at all)", () => {
  assert.equal(matchShortcut(ev("KeyF", { key: "а" })), "find");
  assert.equal(matchShortcut(ev("KeyH", { key: "р" })), "replace");
  assert.equal(matchShortcut(ev("KeyW", { key: "ц" })), "closeTab");
  assert.equal(matchShortcut(ev("KeyL", { key: "д" })), "link");
  assert.equal(matchShortcut(ev("KeyK", { key: "л" })), "search");
});

test("zoom works from the main row and the numpad", () => {
  for (const [code, action] of [["Equal", "zoomIn"], ["NumpadAdd", "zoomIn"], ["Minus", "zoomOut"], ["NumpadSubtract", "zoomOut"], ["Digit0", "zoomReset"], ["Numpad0", "zoomReset"]])
    assert.equal(matchShortcut(ev(code)), action);
});

test("Ctrl + plus (Shift+=) zooms in", () => {
  assert.equal(matchShortcut(ev("Equal", { shiftKey: true })), "zoomIn");
});

test("tabs, new note and help", () => {
  assert.equal(matchShortcut(ev("Tab")), "nextTab");
  assert.equal(matchShortcut(ev("Tab", { shiftKey: true })), "prevTab");
  assert.equal(matchShortcut(ev("KeyN")), "newNote");
  assert.equal(matchShortcut({ code: "F1", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }), "help");
});

test("printing is matched by the physical key, so the Russian layout works too", () => {
  assert.equal(matchShortcut(ev("KeyP")), "print");
  assert.equal(matchShortcut(ev("KeyP", { key: "з" })), "print");
  assert.equal(matchShortcut(ev("KeyP", { ctrlKey: false })), null);
});

test("plain typing, Alt combinations and unknown chords are left alone", () => {
  assert.equal(matchShortcut(ev("KeyF", { ctrlKey: false })), null);
  assert.equal(matchShortcut(ev("KeyF", { altKey: true })), null);
  assert.equal(matchShortcut(ev("KeyF", { shiftKey: true })), null);
  assert.equal(matchShortcut(ev("KeyQ")), null);
});

test("every shortcut in the handler is documented in the help list", () => {
  const text = JSON.stringify(SHORTCUT_HELP);
  for (const key of ["Ctrl N", "Ctrl W", "Ctrl S", "Ctrl K", "Ctrl F", "Ctrl H", "Ctrl L", "Ctrl J", "Ctrl P", "F1"]) assert.ok(text.includes(key), key);
});
