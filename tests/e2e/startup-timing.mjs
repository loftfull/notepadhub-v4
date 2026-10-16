// Measures how long the real window takes from process start to a usable home page (3 cold launches on a COPY of a profile).
// Usage: node tests/e2e/startup-timing.mjs <NotepadHub4.exe (Debug build: needs the debug port)> <data-v3.zip>
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(path.join(process.env.USERPROFILE, ".local/share/orca-design-tools/package.json"));
const { chromium } = require("playwright-core");
const [exe, zip] = process.argv.slice(2);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nh4-e2e-"));
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${root}' -Force`]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9351;

for (let run = 1; run <= 3; run++) {
  const t0 = performance.now();
  const child = spawn(exe, [], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root, NOTEPADHUB_DEBUG_PORT: String(PORT) }, stdio: "ignore" });
  let browser, tCdp = 0, tPage = 0, tHome = 0, tTabs = 0;
  try {
    for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* starting */ } await sleep(50); }
    tCdp = performance.now() - t0;
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    let page;
    for (let i = 0; i < 400 && !page; i++) { for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("https://app.notepadhub.local")) page = p; if (!page) await sleep(50); }
    tPage = performance.now() - t0;
    await page.waitForSelector(".tab-wrap", { timeout: 60000 });
    tHome = performance.now() - t0;
    await page.waitForSelector(".tab", { timeout: 60000 });
    tTabs = performance.now() - t0;
    const perf = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return n ? { domInteractive: Math.round(n.domInteractive), loadEnd: Math.round(n.loadEventEnd) } : null; });
    console.log(`run ${run}: debug port ${Math.round(tCdp)} ms, page ${Math.round(tPage)} ms, home visible ${Math.round(tHome)} ms, tabs ${Math.round(tTabs)} ms, page timing ${JSON.stringify(perf)}`);
  } finally {
    try { await browser?.close(); } catch { /* */ }
    try { process.kill(child.pid); } catch { /* */ }
    await sleep(2500);
  }
}
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { console.log("temp profile left:", root); }
