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
  const out = outDir;
  const scan = async (label) => {
    await page.screenshot({ path: path.join(out, label + ".png") });
    const hits = await page.evaluate(() => {
      const card = document.querySelector(".editor-card").getBoundingClientRect();
      const res = [];
      for (const e of document.querySelectorAll("body *")) {
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(e);
        const blue = (c) => { const m = c.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?/); if (!m) return false; const [R, G, B] = [+m[1], +m[2], +m[3]]; const A = m[4] === undefined ? 1 : +m[4]; return A > 0.3 && B > 150 && B > R + 40 && B >= G; };
        const lines = [];
        for (const side of ["Top", "Right", "Bottom", "Left"]) if (parseFloat(cs["border" + side + "Width"]) > 0 && blue(cs["border" + side + "Color"])) lines.push("border" + side);
        if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 && blue(cs.outlineColor)) lines.push("outline");
        if ((r.height <= 4 || r.width <= 4) && blue(cs.backgroundColor)) lines.push("bg-thin");
        if (lines.length && r.right > card.left - 20 && r.left < card.right + 20 && r.bottom > card.top - 60) res.push((e.className && String(e.className).slice(0, 60)) + "<" + e.tagName + "> " + lines.join(",") + " @" + Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height));
      }
      return res;
    });
    console.log("== " + label, JSON.stringify(hits, null, 1));
  };
  await scan("idle");
  await page.locator(".bn-editor").first().click();
  await sleep(300);
  await scan("focused");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await sleep(500);
  await scan("slash");
  await page.keyboard.press("Escape");
  await page.locator(".bn-editor").first().hover();
  await sleep(300);
  await scan("hover");
} finally {
  try { await browser?.close(); } catch { /* */ }
  if (child) { try { process.kill(child.pid); } catch { /* */ } }
  await sleep(2500);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { console.log("temp profile left:", root); }
}

