// Real-window check of: the free online model as the default, flat business tabs, trash with a question and an undo,
// the right-click tab menu, two notes on the screen (transfer, compare, swap) and "Спросить" (an answer as an insight).
// Usage: node tests/e2e/features3-e2e.mjs <NotepadHub.exe (Debug)> <data-v3.zip>
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
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${root}' -Force`]);
const metaDir = path.join(root, "data-v3", "notes-meta"), contentDir = path.join(root, "data-v3", "notes-content");
const PORT = 9391, OLLAMA_PORT = 11558;
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitDisk = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (fn()) return true; } catch { /* mid-write */ } await sleep(250); } return false; };
const metaOf = (title) => { for (const f of fs.readdirSync(metaDir).filter((x) => x.endsWith(".json"))) { const j = JSON.parse(fs.readFileSync(path.join(metaDir, f), "utf8")); if (j.Title === title) return j; } return null; };
const textOf = (id) => { try { return fs.readFileSync(path.join(contentDir, id + ".txt"), "utf8"); } catch { return ""; } };

const fakeOllama = http.createServer((req, res) => {
  if (req.url === "/api/tags") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ models: [{ name: "qwen3.5:4b", size: 3400000000, details: { family: "qwen35", parameter_size: "4.2B" } }] })); return; }
  if (req.url === "/api/chat" && req.method === "POST") { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/x-ndjson" }); res.write(JSON.stringify({ message: { content: "Ответ по заметке: всё верно." } }) + "\n"); res.end(JSON.stringify({ done: true, done_reason: "stop" }) + "\n"); }); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => fakeOllama.listen(OLLAMA_PORT, "127.0.0.1", r));

let child, browser, page;
const addNote = async (title, body) => {
  await page.locator('input[aria-label="Выбрать текстовый файл"]').setInputFiles({ name: title + ".txt", mimeType: "text/plain", buffer: Buffer.from(body, "utf8") });
  await page.waitForFunction((t) => document.querySelector(".crumb-title")?.textContent?.includes(t), title, { timeout: 10000 });
  await sleep(600);
};
const openTab = async (title) => { const ok = await page.evaluate((t) => { const b = [...document.querySelectorAll(".tab")].find((x) => (x.textContent ?? "").trim() === t); if (b) { b.click(); return true; } return false; }, title); await sleep(500); return ok; };

try {
  child = spawn(exe, [], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root, NOTEPADHUB_DEBUG_PORT: String(PORT), OLLAMA_HOST: `http://127.0.0.1:${OLLAMA_PORT}` }, stdio: "ignore" });
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* starting */ } await sleep(250); }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  for (let i = 0; i < 120 && !page; i++) { for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("https://app.notepadhub.local")) page = p; if (!page) await sleep(250); }
  page.on("dialog", (d) => d.accept());
  await page.waitForSelector(".topbar", { timeout: 40000 });

  // ---- the free online service is the default
  await page.getByRole("button", { name: "Быстро создать заметку" }).click();
  await page.waitForSelector(".bn-editor", { state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "Открыть AI-помощник" }).click();
  await page.waitForFunction(() => document.querySelector(".ais-model-text")?.textContent?.includes("Pollinations"), null, { timeout: 20000 }).catch(() => {});
  const online = await page.evaluate(() => ({ radio: document.querySelector(".ais-service [role=radio][aria-checked=true]")?.textContent ?? "", chip: document.querySelector(".ais-model-text")?.textContent ?? "" }));
  check("the free online service is the default (Pollinations, no key)", online.chip.includes("Pollinations") && online.radio.includes("Онлайн"), JSON.stringify(online));
  await page.getByRole("button", { name: "Закрыть AI-помощник" }).first().click();
  // the rest of the run uses the fake local model
  await page.evaluate(() => localStorage.setItem("nh4-ai-provider", "ollama"));
  await page.reload();
  await page.waitForSelector(".topbar", { timeout: 40000 });

  await addNote("Альфа", "Первая заметка про кошек.\nКошки спят до шестнадцати часов в сутки.\nОхота идёт ночью.");
  await addNote("Бета", "Вторая заметка про собак.\nСобаки любят прогулки.");
  await addNote("Гамма", "Третья заметка про птиц.\nПтицы поют по утрам.\nОхота у них днём.");
  const listed = await page.locator(".notes-list button span").allInnerTexts();
  check("the library lists the notes of the section by name", ["Альфа", "Бета", "Гамма"].every((t) => listed.includes(t)), JSON.stringify(listed.slice(-4)));
  await page.locator(".notes-list button", { hasText: "Бета" }).click();
  await page.waitForFunction(() => document.querySelector(".crumb-title")?.textContent?.includes("Бета"), null, { timeout: 8000 }).catch(() => {});
  check("a click on a name in the list opens that note", (await page.locator(".crumb-title").innerText()).includes("Бета"));

  // ---- flat business tabs
  const tabs = await page.evaluate(() => [...document.querySelectorAll(".tab-wrap")].map((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return { l: r.left, r: r.right, border: parseFloat(s.borderRightWidth), radius: s.borderTopLeftRadius }; }));
  const gaps = tabs.slice(1).map((t, i) => Math.round(t.l - tabs[i].r));
  check("tabs sit side by side without gaps", tabs.length >= 3 && gaps.every((g) => g <= 1), JSON.stringify(gaps));
  check("each tab has a thin divider and square corners (business style)", tabs.every((t) => t.border > 0 && t.radius === "0px"), JSON.stringify(tabs.slice(0, 2)));

  // ---- trash: a question, an answer 'no', an answer 'yes', an undo, the Delete key, the right-click menu
  await openTab("Альфа");
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  await page.locator(".note-menu .note-toolbar-menu").getByRole("button", { name: "В корзину", exact: true }).click();
  await page.locator(".confirm-modal").waitFor({ timeout: 8000 });
  check("the trash button asks before moving the note", (await page.locator(".confirm-modal").innerText()).includes("«Альфа»"));
  await page.locator(".confirm-modal .form-cancel").click();
  await sleep(500);
  check("'Отмена' leaves the note where it was", metaOf("Альфа")?.IsDeleted === false);
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  await page.locator(".note-menu .note-toolbar-menu").getByRole("button", { name: "В корзину", exact: true }).click();
  await page.locator(".confirm-modal .form-submit").click();
  check("after the answer the note is in the trash on disk", await waitDisk(() => metaOf("Альфа")?.IsDeleted === true));
  check("another note is opened instead of the trashed one", !(await page.locator(".crumb-title").innerText()).includes("Альфа"));
  check("the trash counter in the library shows it", (await page.locator(".section-tile", { hasText: "Корзина" }).locator("b").innerText()).trim() === "1");
  await page.locator(".toast .toast-action").click();
  check("'Отменить' in the message brings the note back", await waitDisk(() => metaOf("Альфа")?.IsDeleted === false));
  await openTab("Бета");
  await page.locator(".tab", { hasText: "Бета" }).first().focus();
  await page.keyboard.press("Delete");
  await page.locator(".confirm-modal").waitFor({ timeout: 8000 });
  await page.locator(".confirm-modal .form-submit").click();
  check("the Delete key on a tab moves the note to the trash after a question", await waitDisk(() => metaOf("Бета")?.IsDeleted === true));
  await page.locator(".toast .toast-action").click();
  await waitDisk(() => metaOf("Бета")?.IsDeleted === false);
  await page.locator(".tab-wrap", { hasText: "Гамма" }).first().click({ button: "right" });
  const menuItems = await page.locator(".tab-menu button").allInnerTexts();
  check("a right click on a tab opens a menu with close, open on the right and trash", menuItems.some((t) => t.includes("Закрыть")) && menuItems.some((t) => t.includes("Открыть справа")) && menuItems.some((t) => t.includes("В корзину")), JSON.stringify(menuItems));

  await page.keyboard.press("Escape");
  await sleep(300);
  check("Escape closes the tab menu", (await page.locator(".tab-menu").count()) === 0);

  // ---- two notes on the screen
  await openTab("Альфа");
  await page.locator(".tab-wrap", { hasText: "Гамма" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /Открыть справа/ }).click();
  await page.waitForSelector(".split-bar", { timeout: 8000 });
  await sleep(800);
  const sides = await page.evaluate(() => ({ left: document.querySelector(".editor-column:not(.second-column) .bn-editor")?.innerText ?? "", right: document.querySelector(".second-column .bn-editor")?.innerText ?? "" }));
  check("two notes are shown side by side (Альфа left, Гамма right)", sides.left.includes("кошек") && sides.right.includes("птиц"), JSON.stringify(sides).slice(0, 160));
  // select a paragraph on the left and move it to the right
  await page.locator(".editor-column:not(.second-column) [data-content-type='paragraph']", { hasText: "Кошки спят" }).first().click({ clickCount: 3 });
  await page.getByRole("button", { name: /Копировать вправо/ }).click();
  await sleep(1200);
  const rightNow = await page.evaluate(() => document.querySelector(".second-column .bn-editor")?.innerText ?? "");
  check("the selected text is moved into the right note", rightNow.includes("Кошки спят до шестнадцати часов"), rightNow.slice(0, 120));
  const gamma = metaOf("Гамма");
  check("the right note is saved to disk with the moved text", gamma && await waitDisk(() => textOf(gamma.Id).includes("Кошки спят до шестнадцати часов")));
  check("the left note keeps its text (copy, not cut)", (await page.evaluate(() => document.querySelector(".editor-column:not(.second-column) .bn-editor")?.innerText ?? "")).includes("Кошки спят до шестнадцати часов"));
  // compare
  await page.getByRole("button", { name: "Сравнить" }).click();
  await page.waitForSelector("#cmp-title", { timeout: 8000 });
  const rows = await page.evaluate(() => ({ same: document.querySelectorAll(".cmp-row.is-same").length, leftOnly: document.querySelectorAll(".cmp-row.is-left-only").length, rightOnly: document.querySelectorAll(".cmp-row.is-right-only").length, changed: document.querySelectorAll(".cmp-row.is-changed").length, head: document.querySelector("#cmp-title + p")?.textContent ?? "" }));
  check("the comparison shows the shared moved paragraph and the differences", rows.same >= 1 && rows.leftOnly + rows.rightOnly + rows.changed >= 2, JSON.stringify(rows));
  await page.locator(".cmp-row.is-left-only .cmp-mid button, .cmp-row.is-changed .cmp-mid button").first().click();
  await sleep(600);
  check("a paragraph can be copied across from the comparison", (await page.locator(".toast").allInnerTexts()).some((t) => t.includes("Абзац добавлен")));
  await page.locator(".compare-modal .form-submit").click();
  // swap and close
  await page.getByRole("button", { name: "Поменять заметки местами" }).click();
  await sleep(1200);
  check("swapping puts Гамма on the left and Альфа on the right", (await page.locator(".crumb-title").innerText()).includes("Гамма") && (await page.evaluate(() => document.querySelector(".second-column .bn-editor")?.innerText ?? "")).includes("кошек"));
  // each side has its own picker
  await page.getByLabel("Справа", { exact: true }).selectOption({ label: "Бета" });
  await sleep(1000);
  const pickedRight = await page.evaluate(() => document.querySelector(".second-column .bn-editor")?.innerText ?? "");
  const betaText = textOf(metaOf("Бета").Id);
  check("a chosen note appears on the right", pickedRight.length > 0 && betaText.length > 0 && pickedRight.includes(betaText.split(/\s+/).filter((w) => w.length > 4)[0] ?? ""), pickedRight.slice(0, 60));
  await page.getByLabel("Слева", { exact: true }).selectOption({ label: "Альфа" });
  await sleep(1200);
  check("a chosen note appears on the left, the right one stays", (await page.locator(".crumb-title").innerText()).includes("Альфа") && (await page.getByLabel("Справа", { exact: true }).inputValue()) === metaOf("Бета").Id);
  await page.getByRole("button", { name: "Закрыть правую заметку" }).click();
  await sleep(500);
  check("closing the right note returns to one note", (await page.locator(".split-bar").count()) === 0);

  // ---- an answer to a question is inserted as an insight, the note text is not touched
  await openTab("Альфа");
  await page.getByRole("button", { name: "Открыть AI-помощник" }).click();
  await page.locator("#ais-instruction").fill("Сколько часов в сутки спят кошки?");
  const beforeText = await page.locator(".bn-editor").innerText();
  await page.getByRole("button", { name: "Задать вопрос по заметке" }).click();
  await page.waitForSelector(".ais-proposal", { timeout: 30000 });
  check("the answer is offered as an insight, not as a replacement of the text", (await page.getByRole("button", { name: "Вставить как инсайт" }).count()) === 1 && (await page.locator(".ai-accept").innerText()).includes("инсайт"));
  await page.getByRole("button", { name: "Вставить как инсайт" }).click();
  await sleep(1200);
  const afterText = await page.locator(".bn-editor").innerText();
  check("the answer is added below the text and the original is intact", afterText.startsWith(beforeText.slice(0, 40)) && afterText.includes("Ответ: Сколько часов") && afterText.includes("Ответ по заметке"));
} catch (e) {
  check("scenario completed without exceptions", false, String(e.message ?? e).split("\n").slice(0, 6).join(" | "));
} finally {
  try { await browser?.close(); } catch { /* */ }
  try { fakeOllama.close(); } catch { /* */ }
  if (child) { try { process.kill(child.pid); } catch { /* */ } }
  await sleep(1500);
  if (root.includes("nh4-e2e-")) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { console.log("temp profile left:", root); } }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
