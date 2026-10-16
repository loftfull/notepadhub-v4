// One batched visual inspection of the real host on a COPY of a profile: three window sizes + the three menus.
// Usage: node tests/e2e/layout-shots.mjs <NotepadHub4.exe> <data-v3.zip> <out-dir>
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(path.join(process.env.USERPROFILE, ".local/share/orca-design-tools/package.json"));
const { chromium } = require("playwright-core");
const [exe, zip, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nh4-e2e-"));
const PORT = 9335;
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${root}' -Force`]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child, browser;
try {
  child = spawn(exe, [], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root, NOTEPADHUB_DEBUG_PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* starting */ } await sleep(500); }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  let page;
  for (let i = 0; i < 60 && !page; i++) { for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("https://app.notepadhub.local")) page = p; await sleep(500); }
  await page.waitForSelector(".tab", { timeout: 30000 });
  // geometry facts for the report: heights of the three rows and where the sheet starts
  const facts = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height), left: Math.round(b.left), w: Math.round(b.width) }; };
    return { topbar: r(".topbar"), tabs: r(".document-tabs"), bar: r(".topbar-note"), sheet: r(".editor-card"), crumbs: r(".note-crumbs"), title: r(".crumb-title"), viewport: { w: innerWidth, h: innerHeight } };
  });
  console.log("geometry@default", JSON.stringify(facts));
  for (const [name, w, h] of [["wide", 1440, 900], ["medium", 1000, 720], ["narrow", 640, 760]]) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    const g = await page.evaluate(() => { const b = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : null; }; return { sheetTop: b(".editor-card"), overflowX: document.documentElement.scrollWidth > innerWidth }; });
    console.log(`${name} ${w}x${h}`, JSON.stringify(g));
    if (name === "wide") {
      for (const [label, selector] of [["menu-library", "summary[aria-label='Файлы и данные']"], ["menu-note", "summary[aria-label='Дополнительные действия заметки']"], ["menu-tabs", "summary[aria-label^='Все заметки раздела']"]]) {
        await page.locator(selector).click();
        await sleep(300);
        await page.screenshot({ path: path.join(outDir, `${label}.png`) });
        await page.keyboard.press("Escape");
        await page.mouse.click(700, 600);       // outside click closes the menu
        await sleep(200);
      }
    }
    if (name === "wide") {
      await page.getByRole("button", { name: /Поиск заметок и команд/ }).click();
      await page.locator("#global-search").fill("а");
      await sleep(400);
      await page.screenshot({ path: path.join(outDir, "search-open.png") });
      await page.keyboard.press("Escape");
      await sleep(200);
    }
    if (name === "wide") {
      await page.getByRole("button", { name: "Открыть AI-помощник" }).click();
      await sleep(1500);
      await page.screenshot({ path: path.join(outDir, "ai-light.png") });
      await page.getByRole("button", { name: "Переключить тему" }).click();
      await sleep(400);
      await page.screenshot({ path: path.join(outDir, "ai-dark.png") });
      await page.getByRole("button", { name: "Переключить тему" }).click();
      await page.getByRole("button", { name: "Закрыть AI-помощник" }).first().click();
    }
    if (name === "wide") {
      await page.getByRole("button", { name: "Переключить тему" }).click();
      await sleep(400);
      await page.screenshot({ path: path.join(outDir, "dark.png") });
      await page.getByRole("button", { name: "Переключить тему" }).click();
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride");
  }
} finally {
  try { await browser?.close(); } catch { /* */ }
  if (child) { try { process.kill(child.pid); } catch { /* */ } }
  await sleep(2500);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { console.log("temp profile left:", root); }
}

