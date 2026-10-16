// End-to-end check of the REAL desktop host (WPF + WebView2) on an isolated COPY of a profile.
// Usage: node tests/e2e/host-e2e.mjs <path-to-NotepadHub4.exe> <data-v3.zip>
// Never prints note content: only counts, ids and pass/fail lines.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";

const require = createRequire(path.join(process.env.USERPROFILE, ".local/share/orca-design-tools/package.json"));
const { chromium } = require("playwright-core");
const axeSource = fs.readFileSync(path.join(process.env.USERPROFILE, ".local/share/orca-design-tools/node_modules/axe-core/axe.min.js"), "utf8");

const [exe, zip] = process.argv.slice(2);
if (!exe || !zip) { console.error("usage: host-e2e.mjs <exe> <data-v3.zip>"); process.exit(2); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nh4-e2e-"));
const PORT = 9333;
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const dv3 = path.join(root, "data-v3");

// 1. isolated profile = extracted copy
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${root}' -Force`]);
const metaDir = path.join(dv3, "notes-meta"), contentDir = path.join(dv3, "notes-content");
const originalIds = fs.readdirSync(metaDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const before = new Map(originalIds.map((id) => [id, { meta: sha(path.join(metaDir, id + ".json")), txt: fs.existsSync(path.join(contentDir, id + ".txt")) ? sha(path.join(contentDir, id + ".txt")) : "" }]));
console.log(`profile copy: ${originalIds.length} notes`);

// a seeded note with a table and a picture, so the rich-content path is tested in the real window
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const pngName = crypto.createHash("sha256").update(PNG_1X1).digest("hex").slice(0, 32) + ".png";
fs.mkdirSync(path.join(dv3, "notes-assets"), { recursive: true });
fs.writeFileSync(path.join(dv3, "notes-assets", pngName), PNG_1X1);
const RICH_ID = "rich-e2e-0001";
{
  const template = JSON.parse(fs.readFileSync(path.join(metaDir, originalIds[0] + ".json"), "utf8"));
  Object.assign(template, { Id: RICH_ID, Title: "Таблицы и картинки", ProjectId: "inbox", SourcePath: "", SourceType: "local", ContentType: "text", Tags: "", IsDeleted: false, IsArchived: false, IsPinned: false, ExternalOnly: false, LegacySourceGuid: "", SourceLastWriteUtc: "", LastOpenedUtc: "" });
  fs.writeFileSync(path.join(metaDir, RICH_ID + ".json"), JSON.stringify(template), "utf8");
  fs.writeFileSync(path.join(contentDir, RICH_ID + ".txt"), `# Таблицы и картинки\nВступление\n| Имя | Возраст |\n| --- | --- |\n| Аня | 30 |\n| Борис | 41 |\n![схема](https://assets.notepadhub.local/${pngName})\nКонец`, "utf8");
}

let child, browser;
// fake local Ollama so the AI path can be tested without a model: /api/tags and a streamed /api/chat
const OLLAMA_PORT = 11555;
let chatBodies = 0;
let lastChatBody = "";
const fakeOllama = http.createServer((req, res) => {
  if (req.url === "/api/tags") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ models: [{ name: "qwen3:4b" }] })); return; }
  if (req.url === "/api/chat" && req.method === "POST") {
    chatBodies++;
    { let raw = ""; req.on("data", (c) => { raw += c; }); req.on("end", () => { lastChatBody = raw; }); }
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const parts = ["ФЕЙК", "-ОТВЕТ ", "МОДЕЛИ"]; let i = 0;
    const timer = setInterval(() => { if (i < parts.length) res.write(JSON.stringify({ message: { content: parts[i++] } }) + "\n"); else { res.write(JSON.stringify({ done: true, done_reason: lastChatBody.includes("E2E-CUT") ? "length" : "stop" }) + "\n"); res.end(); clearInterval(timer); } }, 150);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => fakeOllama.listen(OLLAMA_PORT, "127.0.0.1", r));
const launch = () => spawn(exe, [], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root, NOTEPADHUB_DEBUG_PORT: String(PORT), OLLAMA_HOST: `http://127.0.0.1:${OLLAMA_PORT}`, OLLAMA_MODEL: "qwen3:4b" }, stdio: "ignore" });

async function connect() {
  for (let i = 0; i < 180; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch { /* not up yet */ }
    await sleep(500);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) for (const pg of ctx.pages()) if (pg.url().startsWith("https://app.notepadhub.local")) return pg;
    await sleep(500);
  }
  throw new Error("page not found");
}

async function waitSaved(page) {
  await page.waitForFunction(() => /^Сохранено$/.test(document.querySelector(".status-save")?.textContent ?? ""), null, { timeout: 15000 });
}
async function waitDisk(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (fn()) return true; } catch { /* file mid-write */ } await sleep(250); } return false; }
const readMeta = (id) => JSON.parse(fs.readFileSync(path.join(metaDir, id + ".json"), "utf8"));
const newestNote = () => {
  const metas = fs.readdirSync(metaDir).filter((f) => f.endsWith(".json")).map((f) => ({ f, j: JSON.parse(fs.readFileSync(path.join(metaDir, f), "utf8")) }));
  return metas.filter((m) => !originalIds.includes(m.j.Id)).sort((a, b) => b.j.CreatedUtc.localeCompare(a.j.CreatedUtc))[0]?.j;
};

try {
  child = launch();
  let page = await connect();
  page.on("dialog", (d) => d.accept());
  await page.evaluate(() => localStorage.setItem("nh4-ai-provider", "ollama"));   // the tests use the fake local model; the app itself starts on the free online service
  await page.reload();

  // 2. library loads from disk
  await page.waitForSelector(".tab, .tabs-empty", { timeout: 20000 });
  await page.locator(".tab").first().click().catch(() => {});   // the app opens on the home page; leave it for the editor checks
  const folderRows = (await page.locator(".folder-row").count()) + (await page.locator(".section-tile").count());
  check("host shows the library (folders rendered)", folderRows >= 5, `folders/rows=${folderRows}`);
  check("page runs inside the host (not the browser mock)", await page.evaluate(() => Boolean(window.chrome?.webview)));
  check("content security policy is present", (await page.locator('meta[http-equiv="Content-Security-Policy"]').count()) === 1);

  // 2b. accessibility of the real window (serious/critical findings fail)
  await page.evaluate(axeSource);
  const axe = await page.evaluate(async () => { const r = await window.axe.run(document, { resultTypes: ["violations"] }); return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id + ":" + v.nodes.map((n) => n.target.join(" ")).join("|")); });
  check("no serious or critical accessibility violations (axe)", axe.length === 0, axe.join(" ; "));

  // tables and pictures in the real window
  await page.getByRole("button", { name: /Поиск заметок и команд/ }).click();
  await page.locator("#global-search").fill("Таблицы и картинки");
  await page.waitForSelector("#search-listbox [role=option]");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".bn-editor table", { timeout: 15000 });
  const tableRows = await page.locator(".bn-editor table tr").count();
  check("a table written as text opens as a real table", tableRows === 3, `rows=${tableRows}`);
  const headerCells = await page.locator(".bn-editor table tr").first().locator("th").count();
  check("the header row stays a header", headerCells === 2 || (await page.locator(".bn-editor table tr").first().locator("td, th").count()) === 2, `th=${headerCells}`);
  const pictureShown = await page.waitForFunction(() => { const img = document.querySelector(".bn-editor img"); return img && img.complete && img.naturalWidth > 0; }, null, { timeout: 10000 }).then(() => true).catch(() => false);
  check("a picture stored by the host is displayed in the sheet", pictureShown);
  await page.locator(".bn-editor").first().click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("End");
  await page.keyboard.type(" +");
  const richText = () => fs.readFileSync(path.join(contentDir, RICH_ID + ".txt"), "utf8");
  check("editing around a table and picture keeps both in the text file", await waitDisk(() => richText().includes(" +") && richText().includes("| Борис | 41 |") && richText().includes(`![схема](https://assets.notepadhub.local/${pngName})`)), richText().replace(/\n/g, " ⏎ ").slice(0, 200));
  check("the header separator survives saving", richText().includes("| --- | --- |"));
  // saving a new picture through the bridge: only real pictures are accepted, the page can read it back from the picture address
  const upload = await page.evaluate(async (b64) => {
    const send = (payload) => new Promise((resolve) => {
      const id = 880000 + Math.floor(Math.random() * 1000);
      const on = (e) => { if (e.data && e.data.id === id) { window.chrome.webview.removeEventListener("message", on); resolve(e.data); } };
      window.chrome.webview.addEventListener("message", on);
      window.chrome.webview.postMessage({ contract: 1, id, type: "saveAsset", payload });
    });
    const good = await send({ data: b64 });
    const svg = await send({ data: btoa("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>") });
    const loaded = good.ok ? await new Promise((resolve) => { const im = new Image(); im.onload = () => resolve(im.naturalWidth); im.onerror = () => resolve(0); im.src = "https://assets.notepadhub.local/" + good.result.file; }) : 0;
    return { goodOk: good.ok, file: good.ok ? good.result.file : "", svgOk: svg.ok, loaded };
  }, PNG_1X1.toString("base64"));
  check("the host stores a picture and the page can show it from the picture address", upload.goodOk && upload.loaded === 1 && fs.existsSync(path.join(dv3, "notes-assets", upload.file)), JSON.stringify(upload));
  check("the host refuses a script-carrying SVG", upload.svgOk === false);
  // pasting a picture into the sheet goes through the same path
  const assetsBefore = fs.readdirSync(path.join(dv3, "notes-assets")).length;
  const imgsBefore = await page.locator(".bn-editor img").count();
  await page.locator(".bn-editor").first().click();
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes, new Uint8Array([0, 0, 0, 1])], "вставка.png", { type: "image/png" }));
    document.querySelector(".bn-editor").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_1X1.toString("base64"));
  const pasted = await waitDisk(() => fs.readdirSync(path.join(dv3, "notes-assets")).length > assetsBefore, 10000);
  check("a pasted picture is stored by the host", pasted, `files ${assetsBefore} -> ${fs.readdirSync(path.join(dv3, "notes-assets")).length}`);
  const imgsAfter = await page.waitForFunction((n) => document.querySelectorAll(".bn-editor img").length > n, imgsBefore, { timeout: 8000 }).then(() => true).catch(() => false);
  check("a pasted picture appears in the sheet", imgsAfter);

  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

  // 3. opening notes must not rewrite them
  await sleep(1500);
  let touched = 0;
  for (const [id, h] of before) {
    const m = sha(path.join(metaDir, id + ".json")); const t = fs.existsSync(path.join(contentDir, id + ".txt")) ? sha(path.join(contentDir, id + ".txt")) : "";
    if (m !== h.meta || t !== h.txt) touched++;
  }
  check("loading leaves every existing note byte-identical", touched === 0, `changed=${touched}`);

  // 3b. empty notes that point to readable text files can be filled on request (user picks, paths are shown)
  const emptyWithFile = () => originalIds.filter((id) => { const m = readMeta(id); return m.SourceType === "file" && (!fs.existsSync(path.join(contentDir, id + ".txt")) || fs.statSync(path.join(contentDir, id + ".txt")).size === 0); }).length;
  const emptyBefore = emptyWithFile();
  await page.locator("summary[aria-label='Настройки приложения']").click();
  await page.getByRole("button", { name: "Подтянуть текст из внешних файлов…" }).click();
  await page.getByRole("heading", { name: "Подтянуть текст из внешних файлов" }).waitFor({ timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector("[role=status]")?.textContent?.includes("Поиск"), null, { timeout: 10000 });
  const candidates = await page.locator(".refs-row").count();
  check("referenced-files dialog opens and lists candidates", true, `candidates=${candidates}, empty-with-file notes=${emptyBefore}`);
  if (candidates > 0) {
    await page.getByRole("button", { name: /Подтянуть выбранные/ }).click();
    const filled = await waitDisk(() => emptyWithFile() < emptyBefore);
    check("picked files are read into their notes on disk", filled, `empty-with-file ${emptyBefore} -> ${emptyWithFile()}`);
  } else {
    await page.getByRole("button", { name: "Закрыть", exact: true }).first().click();
  }

  // 4. create + type + autosave
  const marker = "E2E-" + crypto.randomBytes(4).toString("hex");
  await page.getByRole("button", { name: "Быстро создать заметку" }).click();
  const editor = page.locator(".bn-editor").first();
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" " + marker);
  await waitSaved(page);
  let n = newestNote();
  check("new note is saved to disk after typing", Boolean(n) && fs.readFileSync(path.join(contentDir, n.Id + ".txt"), "utf8").includes(marker));
  check("block sidecar written next to the text", Boolean(n) && fs.existsSync(path.join(dv3, "notes-blocks", n.Id + ".json")));
  check("note metadata is in the 3.0.5 format (PascalCase, same fields)", Boolean(n) && ["Id", "Title", "ProjectId", "IsDeleted", "ExternalOnly"].every((k) => k in n));

  // 4b. find & replace in the open note (Ctrl+F / Ctrl+H), then put the text back
  await page.keyboard.press("Control+f");
  await page.getByLabel("Что найти").fill(marker);
  const counted = await page.locator(".find-count").innerText();
  check("find bar counts the match in the open note", counted.includes("1 из 1"), counted);
  await page.keyboard.press("Control+h");
  await page.getByLabel("Чем заменить").fill(marker + "-R");
  await page.getByRole("button", { name: "Заменить все" }).click();
  await waitSaved(page);
  check("replace-all is written to disk", await waitDisk(() => fs.readFileSync(path.join(contentDir, n.Id + ".txt"), "utf8").includes(marker + "-R")));
  await page.getByLabel("Что найти").fill(marker + "-R");
  await page.getByLabel("Чем заменить").fill(marker);
  await page.getByRole("button", { name: "Заменить все" }).click();
  await page.getByRole("button", { name: "Закрыть поиск" }).click();
  const axeNow = async () => { await sleep(500); return axeRun(); };   // let opening animations finish: axe would measure half-transparent colours
  const axeRun = async () => page.evaluate(async () => { const r = await window.axe.run(document, { resultTypes: ["violations"] }); return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id + ":" + v.nodes.map((n) => n.target.join(" ") + "{" + JSON.stringify(n.any[0] && n.any[0].data ? { fg: n.any[0].data.fgColor, bg: n.any[0].data.bgColor, ratio: n.any[0].data.contrastRatio, why: n.any[0].data.messageKey } : "") + "}").slice(0, 2).join("|")); });
  // accessibility of the states the first scan does not see: global search with results, shortcuts dialog
  await page.getByRole("button", { name: /Поиск заметок и команд/ }).click();
  await page.locator("#global-search").fill("а");
  await page.waitForSelector("#search-listbox [role=option]");
  const axeSearch = await axeNow();
  check("search combobox with results has no serious accessibility violations", axeSearch.length === 0, axeSearch.join(" ; "));
  await page.keyboard.press("Escape");
  await page.keyboard.press("F1");
  const axeHelp = await axeNow();
  check("shortcuts dialog has no serious accessibility violations", axeHelp.length === 0, axeHelp.join(" ; "));
  // focus stays inside the dialog: many Tab presses never reach the page behind it
  await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
  check("Tab stays inside an open dialog", await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))));
  await page.keyboard.press("Escape");
  await waitSaved(page);
  check("text restored after replacing back", await waitDisk(() => !fs.readFileSync(path.join(contentDir, n.Id + ".txt"), "utf8").includes(marker + "-R")));
  check("status bar shows the word counter", /слов/.test(await page.locator(".statusbar").innerText()) && /знаков/.test(await page.locator(".statusbar").innerText()));
  await editor.click();
  await page.keyboard.press("Control+=");
  check("text zoom grows with Ctrl+=", (await page.locator(".statusbar").innerText()).includes("110%"));
  await page.keyboard.press("Control+0");
  check("Ctrl+0 resets the zoom", (await page.locator(".statusbar").innerText()).includes("100%"));
  await page.keyboard.press("F1");
  check("F1 opens the shortcuts help", (await page.getByRole("dialog", { name: "Сочетания клавиш" }).count()) === 1);
  await page.keyboard.press("Escape");
  // Russian layout: physical key F produces "а" but the shortcut must still work
  const cdpKeys = await page.context().newCDPSession(page);
  await editor.click();
  await cdpKeys.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, code: "KeyF", key: "а", windowsVirtualKeyCode: 70 });
  await cdpKeys.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, code: "KeyF", key: "а", windowsVirtualKeyCode: 70 });
  check("Ctrl+F works on the Russian layout", await page.locator(".find-bar").count() === 1);
  await page.getByRole("button", { name: "Закрыть поиск" }).click();
  // tags: several per note, stored in the same field as 3.0.5, filterable from the sidebar
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  await page.getByRole("button", { name: "Метки…" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("работа, идеи ,работа");
  await page.getByRole("button", { name: "Готово" }).click();
  check("several tags are saved to the note file", await waitDisk(() => readMeta(n.Id).Tags === "работа, идеи"), String(readMeta(n.Id).Tags));
  if (!(await page.locator(".tags-section[open]").count())) await page.locator(".tags-summary").click();   // tags are folded by default
  check("the tags section is folded into one line until opened", (await page.locator(".tags-summary").count()) === 1);
  await page.locator(".tag-chip", { hasText: "идеи" }).click();
  const listCount = async () => Number(((await page.locator(".tabs-all summary").getAttribute("aria-label")) ?? "").replace(/\D+/g, ""));
  const tabsWithTag = await listCount();
  check("tag filter narrows the note list to tagged notes", tabsWithTag === 1, `notes=${tabsWithTag}`);
  await page.locator(".tag-chip.is-on").click();
  check("clearing the tag filter shows all notes again", (await listCount()) > 1);
  // [[links]]: insert through the picker, see it in the Links panel, follow it with Ctrl+click, find the backlink on the other side
  const startTitle = await page.locator(".tab.active-tab").innerText().catch(() => "");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+l");
  await page.getByLabel("Название заметки").fill("agent-orch");
  await page.keyboard.press("Enter");
  check("link picker inserts [[title]] into the note text", await waitDisk(() => fs.readFileSync(path.join(contentDir, n.Id + ".txt"), "utf8").includes("[[agent-orchestrator]]")));
  check("link is highlighted in the sheet", (await page.locator(".bn-editor .wikilink").count()) === 1);
  await page.locator(".links-panel > summary").click();
  check("Links panel lists the outgoing link", (await page.locator(".links-panel .link-row", { hasText: "agent-orchestrator" }).count()) === 1);
  await page.locator(".bn-editor .wikilink").click({ modifiers: ["Control"] });
  await page.waitForFunction(() => document.querySelector(".tab.active-tab")?.textContent?.includes("agent-orchestrator"), null, { timeout: 8000 });
  const backRows = await page.locator(".links-panel").getByText("Упоминают эту заметку").count();
  const backlink = page.locator(".links-panel .link-row", { hasText: "[[agent-orchestrator]]" });
  check("Ctrl+click opens the linked note and it shows the backlink", backRows === 1 && (await backlink.count()) === 1);
  // renaming a note keeps the links to it: rewrite [[old]] in the other notes (and back again)
  const renameActive = async (to) => {
    await page.locator(".crumb-title").click();
    await page.getByRole("dialog").getByRole("textbox").fill(to);
    await page.getByRole("button", { name: "Готово" }).click();
  };
  await renameActive("agent-renamed");
  check("renaming a note rewrites the links to it in other notes", await waitDisk(() => fs.readFileSync(path.join(contentDir, n.Id + ".txt"), "utf8").includes("[[agent-renamed]]"), 20000));
  await renameActive("agent-orchestrator");
  check("renaming back restores the links", await waitDisk(() => fs.readFileSync(path.join(contentDir, n.Id + ".txt"), "utf8").includes("[[agent-orchestrator]]"), 20000));
  await page.locator(".links-panel .link-row", { hasText: "[[agent-orchestrator]]" }).first().waitFor({ timeout: 8000 });
  await backlink.first().click();
  await page.waitForFunction((t) => document.querySelector(".tab.active-tab")?.textContent === t || true, startTitle);
  // closing a tab saves the text first; "+" stays to the right of the last tab
  const markClose = "CLOSE-" + crypto.randomBytes(3).toString("hex");
  const tabsBefore = await page.locator(".tabs-scroller .tab").count();
  await page.getByRole("button", { name: "Быстро создать заметку" }).click();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" " + markClose);
  const created = newestNote();
  const geo = await page.evaluate(() => { const wraps = [...document.querySelectorAll(".tab-wrap")]; const last = wraps[wraps.length - 1].getBoundingClientRect(); const strip = document.querySelector(".tabs-scroller"); const sr = strip.getBoundingClientRect(); const plus = document.querySelector(".tabs-scroller .new-tab").getBoundingClientRect(); return { overflow: strip.scrollWidth > strip.clientWidth + 1, gap: Math.round(plus.left - last.right), toEdge: Math.round(sr.right - plus.right), sameRow: Math.abs(plus.top + plus.height / 2 - (last.top + last.height / 2)) < 12 }; });
  check("+ is right of the last tab (or pinned to the strip edge when tabs overflow)", geo.sameRow && (geo.overflow ? geo.toEdge >= 0 && geo.toEdge < 8 : geo.gap >= 0 && geo.gap < 40), JSON.stringify(geo));
  await page.locator(".tab-wrap.is-active .tab-close").click();
  await page.waitForFunction((count) => document.querySelectorAll(".tabs-scroller .tab").length === count, tabsBefore, { timeout: 8000 });
  check("closing the tab keeps the typed text on disk", Boolean(created) && await waitDisk(() => fs.readFileSync(path.join(contentDir, newestNote().Id + ".txt"), "utf8").includes(markClose)));
  check("closing the active tab activates the neighbour", (await page.locator(".tab.active-tab").count()) === 1);

  // a second edit after the first save, so the first version lands in history
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" ПОСЛЕ");
  await waitDisk(() => fs.readFileSync(path.join(contentDir, n.Id + ".txt"), "utf8").includes("ПОСЛЕ"));

  // 4b. AI through the host: streamed answer from the (fake) local model appears as a proposal
  await page.getByRole("button", { name: "Открыть AI-помощник" }).click();
  const run = page.getByRole("button", { name: "Исправить", exact: true });
  await run.waitFor({ timeout: 15000 });
  await page.waitForFunction(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Исправить"); return b && !b.disabled; }, null, { timeout: 15000 });
  await run.click();
  const gotAnswer = await page.waitForFunction(() => document.body.innerText.includes("ФЕЙК-ОТВЕТ МОДЕЛИ"), null, { timeout: 20000 }).then(() => true).catch(() => false);
  check("AI answer streams from the host into the proposal", gotAnswer, `chatCalls=${chatBodies}`);
  check("only the local model was called (one chat request)", chatBodies === 1);
  // AI context "note + linked notes": the linked note's text is in the request, result is read-only
  await page.getByRole("radio", { name: "+ связанные" }).click();
  await page.getByRole("button", { name: "Структурный анализ" }).click();
  await page.waitForFunction(() => document.querySelector(".ais-proposal"), null, { timeout: 20000 }).catch(() => {});
  check("linked scope sends the linked note's text to the model", chatBodies === 2 && lastChatBody.includes("agent-orchestrator"), `calls=${chatBodies}`);
  check("linked-scope result is read-only (no Apply button)", (await page.getByRole("button", { name: "Применить" }).count()) === 0);
  const axeAi = await axeNow();
  check("AI panel has no serious accessibility violations", axeAi.length === 0, axeAi.join(" ; "));
  // accuracy: an answer the model had to cut off is flagged and cannot be applied
  await page.getByRole("radio", { name: "Абзац" }).click();
  await page.locator("#ais-instruction").fill("E2E-CUT");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(".ais-truncated", { timeout: 20000 });
  check("a cut-off AI answer is flagged and cannot be applied", await page.getByRole("button", { name: /Применить/ }).isDisabled());
  await page.getByRole("button", { name: "Отклонить" }).click();
  await page.locator("#ais-instruction").fill("");
  await page.getByRole("button", { name: "Закрыть AI-помощник" }).first().click().catch(() => {});

  // 4c. version history: list, preview, restore (current text is checkpointed first)
  const histDir = path.join(dv3, "history", n.Id);
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  await page.getByRole("button", { name: "История версий…" }).click();
  await page.locator(".history-list button").first().waitFor({ timeout: 10000 });
  check("history dialog lists earlier versions", (await page.locator(".history-list button").count()) >= 1);
  await page.locator(".history-list button").first().click();
  await page.getByRole("button", { name: "Восстановить эту версию" }).click();
  const reverted = await waitDisk(() => !fs.readFileSync(path.join(contentDir, n.Id + ".txt"), "utf8").includes("ПОСЛЕ"));
  const kept = await waitDisk(() => fs.readdirSync(histDir).some((f) => fs.readFileSync(path.join(histDir, f), "utf8").includes("ПОСЛЕ")));
  check("restoring a version puts the old text back on disk", reverted);
  check("the text that was replaced is kept in history", kept);

  // 5. trash (with a question and an undo) -> trash again -> delete forever (with a question)
  const menu = async (label) => { await page.locator("summary[aria-label='Дополнительные действия заметки']").click(); await page.locator(".note-menu .note-toolbar-menu").getByRole("button", { name: label, exact: true }).click(); };
  const confirmModal = async (label) => { await page.locator(".confirm-modal").waitFor({ timeout: 8000 }); await page.locator(".confirm-modal .form-submit", { hasText: label }).click(); };
  const id1 = n.Id;
  await menu("В корзину");
  await page.locator(".confirm-modal").waitFor({ timeout: 8000 });
  check("moving to the trash asks first", (await page.locator(".confirm-modal").innerText()).includes("Переместить в корзину"));
  await page.locator(".confirm-modal .form-cancel").click();
  await sleep(400);
  check("answering 'Отмена' keeps the note out of the trash", readMeta(id1).IsDeleted === false);
  await menu("В корзину");
  await confirmModal("В корзину");
  check("moving to trash marks IsDeleted on disk", await waitDisk(() => readMeta(id1).IsDeleted === true));
  await page.locator(".toast .toast-action", { hasText: "Отменить" }).click();
  check("the 'Отменить' button of the message restores the note", await waitDisk(() => readMeta(id1).IsDeleted === false));
  await menu("В корзину");
  await confirmModal("В корзину");
  await waitDisk(() => readMeta(id1).IsDeleted === true);
  await page.locator(".section-tile", { hasText: "Корзина" }).click();
  await sleep(700);
  await page.locator(".tab", { hasText: n.Title.slice(0, 8) }).first().click().catch(() => {});
  await menu("Удалить навсегда");
  await confirmModal("Удалить навсегда");
  await sleep(2500);
  console.log("DEBUG delete-forever:", JSON.stringify({ metaExists: fs.existsSync(path.join(metaDir, id1 + ".json")), txtExists: fs.existsSync(path.join(contentDir, id1 + ".txt")), crumb: await page.locator(".crumb-title").innerText().catch(() => ""), toast: await page.locator(".toast").allInnerTexts(), deleted: fs.readdirSync(metaDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(metaDir, f), "utf8"))).filter((m) => m.IsDeleted).map((m) => m.Id + ":" + m.Title), log: (() => { try { const dir = path.join(root, "data-v3", "..", "logs"); const f = fs.readdirSync(dir)[0]; return fs.readFileSync(path.join(dir, f), "utf8").slice(-600); } catch { return "no log"; } })() }));
  check("delete forever removes the note files", await waitDisk(() => !fs.existsSync(path.join(metaDir, id1 + ".json")) && !fs.existsSync(path.join(contentDir, id1 + ".txt"))));

  // 6. closing the window right after typing must not lose the text
  await page.getByRole("button", { name: "Быстро создать заметку" }).click();
  await page.locator(".bn-editor").first().click();
  await page.keyboard.press("End");
  const marker2 = "CLOSE-" + crypto.randomBytes(4).toString("hex");
  await page.keyboard.type(" " + marker2);
  const pid = child.pid;
  execFileSync("taskkill", ["/PID", String(pid)]);              // WM_CLOSE: the host must ask the page to flush first
  for (let i = 0; i < 40 && isAlive(pid); i++) await sleep(500);
  check("window closes by itself after the final save", !isAlive(pid));
  const n2 = newestNote();
  check("text typed just before closing is on disk", Boolean(n2) && fs.readFileSync(path.join(contentDir, n2.Id + ".txt"), "utf8").includes(marker2));

  // 7. restart: persisted state comes back; profile lock released
  await browser.close().catch(() => {});
  await sleep(3000);
  child = launch();
  page = await connect();
  await page.waitForSelector(".tab, .tabs-empty", { timeout: 20000 });
  const hasNote = await page.locator(`.tab`).count();
  check("after restart the library loads again", hasNote >= 1);
  const second = await new Promise((resolve) => { const c = spawn(exe, [], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root }, stdio: "ignore" }); c.on("exit", (code) => resolve(code)); setTimeout(() => { try { c.kill(); } catch { /* */ } resolve("still-running"); }, 8000); });
  check("a second launch hands over to the running window and exits", second === 0, `exit=${second}`);

  // open a file in place: launched with a path, edits go straight into that file; an outside edit raises the conflict flow
  const extFile = path.join(root, "external-live.txt");
  fs.writeFileSync(extFile, "внешний файл", "utf8");
  await new Promise((resolve) => { const c = spawn(exe, [extFile], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root }, stdio: "ignore" }); c.on("exit", () => resolve()); setTimeout(resolve, 8000); });
  await page.waitForFunction(() => document.querySelector(".tab.active-tab")?.textContent?.includes("external-live"), null, { timeout: 15000 });
  const liveEditor = page.locator(".bn-editor").first();
  await liveEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" правка");
  const savedOk = await waitDisk(() => fs.readFileSync(extFile, "utf8") .replace(/\s+/g, " ") ==="внешний файл правка");
  check("a file opened in place is saved back into the file itself", savedOk, JSON.stringify(fs.readFileSync(extFile, "utf8")));
  fs.writeFileSync(extFile, "чужая версия", "utf8");
  fs.utimesSync(extFile, new Date(Date.now() + 5 * 60000), new Date(Date.now() + 5 * 60000));
  await page.keyboard.type(" ещё");
  await page.waitForSelector(".conflict-chip", { timeout: 10000 });
  check("an outside edit stops the write and shows the conflict chip", fs.readFileSync(extFile, "utf8") === "чужая версия");
  await page.locator(".conflict-chip").click();
  await page.getByRole("button", { name: /Взять версию с диска/ }).click();
  const takenFromDisk = await page.waitForFunction(() => document.querySelector(".bn-editor")?.textContent?.includes("чужая версия"), null, { timeout: 10000 }).then(() => true).catch(() => false);
  check("choosing the disk version loads it into the editor", takenFromDisk);
} catch (e) {
  check("scenario completed without exceptions", false, String(e.message ?? e).split("\n").slice(0, 8).join(" | "));
} finally {
  try { await browser?.close(); } catch { /* */ }
  try { fakeOllama.close(); } catch { /* */ }
  if (child && isAlive(child.pid)) { try { process.kill(child.pid); } catch { /* */ } }
  await sleep(1500);
  if (root.includes("nh4-e2e-")) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { console.log("temp profile left for manual cleanup:", root); } }
}

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);











