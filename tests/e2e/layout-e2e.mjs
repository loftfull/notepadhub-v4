// Layout rules of the owner (docs/OWNER_REQUIREMENTS.md): one collapse button, a narrow icon column instead of a hidden library, favourites and recent
// in the library, an empty name for a new note, the trash as a list with row buttons, the command palette with keys and a count.
// Usage: node tests/e2e/layout-e2e.mjs <NotepadHub4.exe (Debug)> <data-v3.zip>
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
const PORT = 9373;
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child, browser, page;
const addNote = async (title, body) => {
  await page.locator('input[aria-label="Выбрать текстовый файл"]').setInputFiles({ name: title + ".txt", mimeType: "text/plain", buffer: Buffer.from(body, "utf8") });
  await page.waitForFunction((t) => document.querySelector(".crumb-title")?.textContent?.includes(t), title, { timeout: 10000 });
  await sleep(500);
};
const noteMenu = async (name) => {
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  await page.locator(".note-menu .note-toolbar-menu").getByRole("button", { name, exact: false }).first().click();
};
try {
  child = spawn(exe, [], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root, NOTEPADHUB_DEBUG_PORT: String(PORT), OLLAMA_HOST: "http://127.0.0.1:1" }, stdio: "ignore" });
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* starting */ } await sleep(250); }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  for (let i = 0; i < 120 && !page; i++) { for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("https://app.notepadhub.local")) page = p; if (!page) await sleep(250); }
  await page.waitForSelector(".topbar", { timeout: 40000 });

  // ---- the collapse button is one; the collapsed library is an icon column
  const toggles = async () => page.locator("button[aria-label$='библиотеку']").count();
  check("there is exactly one collapse/expand button for the library", (await toggles()) === 1);
  await page.locator("button[aria-label='Свернуть библиотеку']").click();
  await sleep(400);
  const rail = await page.evaluate(() => { const r = document.querySelector(".rail"); const s = document.querySelector(".sidebar"); return { railShown: !!r && getComputedStyle(r).display !== "none", width: Math.round(s.getBoundingClientRect().width), body: getComputedStyle(document.querySelector(".sidebar-body")).display }; });
  check("collapsed library is a narrow icon column (not hidden)", rail.railShown && rail.width >= 44 && rail.width <= 64 && rail.body === "none", JSON.stringify(rail));
  check("still exactly one toggle button while collapsed", (await toggles()) === 1);
  await page.locator("button[aria-label='Развернуть библиотеку']").click();
  await sleep(400);
  check("the same button brings the library back", (await page.locator(".sidebar-body").evaluate((e) => getComputedStyle(e).display)) !== "none");

  // ---- opening the assistant folds the library into the column (R1)
  await page.getByRole("button", { name: "Открыть AI-помощник" }).click();
  await sleep(600);
  const aiRail = await page.evaluate(() => { const s = document.querySelector(".sidebar"); const r = document.querySelector(".rail"); const rb = r?.getBoundingClientRect(); return { width: Math.round(s.getBoundingClientRect().width), railWidth: Math.round(rb?.width ?? 0), buttons: r?.querySelectorAll("button").length ?? 0 }; });
  check("opening the AI panel turns the library into a visible icon column", aiRail.width >= 44 && aiRail.railWidth > 30 && aiRail.buttons === 5 && (await toggles()) === 1, JSON.stringify(aiRail));
  await page.getByRole("button", { name: "Закрыть AI-помощник" }).first().click();
  await sleep(500);

  // ---- new note: no name yet
  await page.locator(".new-note-button").click();
  await sleep(700);
  const tabText = await page.locator(".tab-wrap.is-active .tab").innerText();
  const crumb = await page.locator(".crumb-title").innerText();
  const h1 = await page.locator(".bn-editor [data-content-type='heading']").first().innerText();
  check("a new note is called 'Без названия' and its heading is empty with a hint", tabText.trim() === "Без названия" && crumb.includes("Без названия") && h1.trim() === "", JSON.stringify({ tabText, crumb, h1 }));

  // ---- favourites and recent
  await addNote("Избранная", "Первый абзац избранной заметки.");
  await noteMenu("Закрепить");
  await sleep(500);
  check("a pinned note shows a star on its tab", (await page.locator(".tab-wrap .tab-pin").count()) >= 1);
  await page.locator(".folder-row", { hasText: "Избранное" }).click();
  await sleep(500);
  check("the library has 'Избранное' and it lists the pinned note", (await page.locator(".notes-list button", { hasText: "Избранная" }).count()) === 1);
  await page.locator(".folder-row", { hasText: "Недавние" }).click();
  await sleep(400);
  check("the library has 'Недавние' and the opened note is there", (await page.locator(".notes-list button", { hasText: "Избранная" }).count()) === 1);
  await page.locator("button[aria-label='Свернуть библиотеку']").click();
  await sleep(300);
  await page.locator(".rail-button[aria-label='Избранное']").click();
  await page.locator(".rail-pop button", { hasText: "Избранная" }).waitFor({ timeout: 5000 });
  check("a click on the star in the column lists favourites", (await page.locator(".rail-pop button").count()) >= 1);
  await page.locator(".rail-pop button", { hasText: "Избранная" }).click();
  await page.locator("button[aria-label='Развернуть библиотеку']").click();
  await sleep(300);

  // ---- the trash: the question names the period, the list has row buttons, restore can be undone
  await addNote("Лишняя", "Эта заметка пойдёт в корзину.");
  await noteMenu("В корзину");
  await page.locator(".confirm-modal").waitFor({ timeout: 8000 });
  check("the delete question says the note can be restored within 30 days", (await page.locator(".confirm-modal").innerText()).includes("30 дней"));
  await page.locator(".confirm-modal .form-submit").click();
  await sleep(600);
  await page.locator(".folder-row", { hasText: "Корзина" }).click();
  await page.locator(".trash-view").waitFor({ timeout: 8000 });
  const row = page.locator(".trash-list li", { hasText: "Лишняя" });
  check("the trash is a list in the main area with date, days left and row buttons", (await row.count()) === 1 && /удалена/.test(await row.innerText()) && /осталось \d+ дн/.test(await row.innerText()) && (await row.getByRole("button", { name: /Восстановить/ }).count()) === 1);
  await row.getByRole("button", { name: /Восстановить/ }).click();
  await sleep(500);
  check("restoring from the row removes it from the list and offers 'Отменить'", (await page.locator(".trash-list li", { hasText: "Лишняя" }).count()) === 0 && (await page.locator(".toast-action").count()) === 1);
  await page.locator(".toast-action").click();
  await sleep(500);
  check("'Отменить' puts it back into the trash", (await page.locator(".trash-list li", { hasText: "Лишняя" }).count()) === 1);
  await page.getByRole("button", { name: "Очистить корзину" }).click();
  await page.locator(".confirm-modal .form-submit").click();
  await sleep(1200);
  check("'Очистить корзину' empties the list", (await page.locator(".trash-list li").count()) === 0 && /пуста/.test(await page.locator(".trash-view header p").innerText()));

  // ---- command palette: keys, recent, counter
  await page.getByRole("button", { name: "Поиск заметок и команд" }).click();
  await page.locator("#global-search").fill(">");
  await page.locator(".command-result").first().waitFor({ timeout: 5000 });
  check("the palette shows real keys and a counter", (await page.locator(".search-shortcut").count()) >= 1 && /\d+ из \d+/.test(await page.locator(".search-count").innerText()));
  await page.locator(".command-result", { hasText: "Переименовать" }).first().click();
  await sleep(500);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Поиск заметок и команд" }).click();
  await page.locator("#global-search").fill(">");
  await page.locator(".command-result").first().waitFor({ timeout: 5000 });
  check("a command used lately comes first and is marked", (await page.locator(".command-result").first().innerText()).includes("Переименовать") && (await page.locator(".search-recent").count()) >= 1);
  await page.keyboard.press("Escape");

  // ---- the picture field in the AI panel
  await page.getByRole("button", { name: "Открыть AI-помощник" }).click();
  await sleep(500);
  check("the AI panel has a field to describe a picture and a primary 'Исправить'", (await page.getByLabel("Описание картинки").count()) === 1 && (await page.locator(".ais-chip.is-primary", { hasText: "Исправить" }).count()) === 1);
} catch (e) {
  check("scenario completed without exceptions", false, String(e.message ?? e).split("\n").slice(0, 5).join(" | "));
} finally {
  try { await browser?.close(); } catch { /* */ }
  if (child) { try { process.kill(child.pid); } catch { /* */ } }
  await sleep(1500);
  if (root.includes("nh4-e2e-")) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { console.log("temp profile left:", root); } }
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
