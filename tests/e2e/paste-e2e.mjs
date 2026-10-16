// Real-window check: copied rich content (headings, bold, lists, tables, links and pictures) pastes with its formatting and its pictures.
// Usage: node tests/e2e/paste-e2e.mjs <NotepadHub4.exe (Debug)> <data-v3.zip>
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const require = createRequire(path.join(process.env.USERPROFILE, ".local/share/orca-design-tools/package.json"));
const { chromium } = require("playwright-core");
const [exe, zip] = process.argv.slice(2);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nh4-e2e-"));
const PORT = 9361, IMG_PORT = 18765;
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${root}' -Force`]);
const assetsDir = path.join(root, "data-v3", "notes-assets");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
let imageHits = 0;
const imgServer = http.createServer((req, res) => {
  if (req.url === "/pic.png") { imageHits++; res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.concat([PNG, Buffer.from("web")])); return; }   // different bytes from the embedded one: stored separately
  if (req.url === "/notimage.png") { res.writeHead(200, { "content-type": "text/html" }); res.end("<script>alert(1)</script>"); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => imgServer.listen(IMG_PORT, "127.0.0.1", r));

const DATA_URI = "data:image/png;base64," + PNG.toString("base64");
const HTML = `<h2>Заголовок статьи</h2><p>Обычный текст, <strong>жирное слово</strong>, <em>курсив</em> и <a href="https://example.com/page">ссылка</a>.</p>
<ul><li>первый пункт</li><li>второй пункт</li></ul>
<table><tbody><tr><th>Имя</th><th>Возраст</th></tr><tr><td>Аня</td><td>30</td></tr></tbody></table>
<p><img src="${DATA_URI}" alt="встроенная"></p>
<p><img src="http://127.0.0.1:${IMG_PORT}/pic.png" alt="из сети"></p>
<p><img src="http://127.0.0.1:${IMG_PORT}/notimage.png" alt="не картинка"></p>`;

let child, browser;
try {
  child = spawn(exe, [], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root, NOTEPADHUB_DEBUG_PORT: String(PORT), NOTEPADHUB_ALLOW_LOCAL_IMAGES: "1" }, stdio: "ignore" });
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* starting */ } await sleep(250); }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  let page;
  for (let i = 0; i < 120 && !page; i++) { for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("https://app.notepadhub.local")) page = p; if (!page) await sleep(250); }
  await page.waitForSelector(".topbar", { timeout: 30000 });
  await page.locator(".new-note-button").click();
  await page.waitForSelector(".bn-editor", { state: "visible", timeout: 10000 });
  const before = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).length : 0;
  await page.evaluate(() => { window.__notices = []; window.addEventListener("nh4-notice", (e) => window.__notices.push(e.detail)); });
  page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e.message ?? e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERROR:", m.text().slice(0, 200)); });
  await page.locator(".bn-editor [data-content-type='paragraph']").first().click();

  await page.evaluate((html) => {
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    dt.setData("text/plain", "Заголовок статьи\nОбычный текст");
    const target = document.querySelector(".bn-editor [contenteditable=true]") ?? document.querySelector(".bn-editor");
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, HTML);
  await sleep(3500);

  const state = await page.evaluate(() => {
    const ed = document.querySelector(".bn-editor");
    return {
      heading: [...ed.querySelectorAll("[data-content-type='heading']")].some((n) => n.textContent.includes("Заголовок статьи")),
      bold: [...ed.querySelectorAll("strong, [data-style-type='bold'], b")].some((n) => n.textContent === "жирное слово"),
      italic: [...ed.querySelectorAll("em, [data-style-type='italic'], i")].some((n) => n.textContent === "курсив"),
      link: [...ed.querySelectorAll("a")].some((n) => n.getAttribute("href") === "https://example.com/page"),
      bullets: ed.querySelectorAll("[data-content-type='bulletListItem']").length,
      table: ed.querySelectorAll("table").length,
      images: [...ed.querySelectorAll("img")].map((n) => n.getAttribute("src")),
    };
  });
  check("pasted heading stays a heading", state.heading);
  check("pasted bold and italic stay formatted", state.bold && state.italic);
  check("pasted link keeps its address", state.link);
  check("pasted list stays a list (2 items)", state.bullets === 2, `items=${state.bullets}`);
  check("pasted table stays a table", state.table === 1, `tables=${state.table}`);
  const stored = (fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).length : 0) - before;
  check("embedded (data:) picture is stored by the host", stored >= 1, `new asset files=${stored}`);
  check("picture from the web is downloaded and stored by the host", stored >= 2 && imageHits === 1, `new asset files=${stored}, server hits=${imageHits}`);
  check("a link that is not a picture is not stored", stored === 2, `new asset files=${stored}`);
  check("every picture in the sheet is shown from the host's own address", state.images.length >= 2 && state.images.every((s) => s && s.startsWith("https://assets.notepadhub.local/")), JSON.stringify(state.images.map((s) => (s ?? "").slice(0, 60))));
} catch (e) {
  check("scenario completed without exceptions", false, String(e.message ?? e).split("\n").slice(0, 6).join(" | "));
} finally {
  try { await browser?.close(); } catch { /* */ }
  try { imgServer.close(); } catch { /* */ }
  if (child) { try { process.kill(child.pid); } catch { /* */ } }
  await sleep(1500);
  if (root.includes("nh4-e2e-")) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { console.log("temp profile left:", root); } }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
