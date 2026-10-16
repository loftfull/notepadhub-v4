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

  // ---- the library: projects on top, notes below, one block of sections, settings at the bottom
  const lib = await page.evaluate(() => { const q = (sel) => document.querySelector(sel)?.getBoundingClientRect(); const top = (sel) => Math.round(q(sel)?.top ?? -1); return { caption: document.querySelector(".sidebar-caption")?.textContent?.trim(), hasNewButton: !!document.querySelector(".new-note-button"), oldCaption: /БИБЛИОТЕКА/i.test(document.querySelector(".sidebar")?.innerText ?? ""), projects: top(".projects-section"), notes: top(".notes-section"), sections: top(".sections-grid"), settings: top(".sidebar-footer > .settings-menu"), tiles: [...document.querySelectorAll(".section-tile span")].map((e) => e.textContent.trim()), notesScrollbar: getComputedStyle(document.querySelector(".notes-list")).scrollbarWidth, topbarSettings: !!document.querySelector(".topbar summary[aria-label='Настройки приложения']") }; });
  check("projects come first, the notes under them, then the block of sections, then the settings", lib.caption === "Проекты" && lib.projects < lib.notes && lib.notes < lib.sections && lib.sections < lib.settings, JSON.stringify(lib));
  check("no 'БИБЛИОТЕКА ЗАМЕТОК' caption, no 'Новая заметка' button in the library", !lib.oldCaption && !lib.hasNewButton);
  check("favourites, recent, archive and trash are one block", JSON.stringify(lib.tiles) === JSON.stringify(["Избранное", "Недавние", "Архив", "Корзина"]));
  check("the notes list has no scrollbar line, the settings are in the library and not in the top bar", lib.notesScrollbar === "none" && !lib.topbarSettings);

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
  check("opening the AI panel turns the library into a visible icon column", aiRail.width >= 44 && aiRail.railWidth > 30 && aiRail.buttons === 4 && (await toggles()) === 1, JSON.stringify(aiRail));
  await page.getByRole("button", { name: "Закрыть AI-помощник" }).first().click();
  await sleep(500);

  // ---- new note: no name yet
  await page.getByRole("button", { name: "Быстро создать заметку" }).click();
  await sleep(700);
  const tabText = await page.locator(".tab-wrap.is-active .tab").innerText();
  const crumb = await page.locator(".crumb-title").innerText();
  const h1 = await page.locator(".bn-editor [data-content-type='heading']").first().innerText();
  check("a new note is called 'Заметка N' and its heading is empty with a hint", /^Заметка \d+$/.test(tabText.trim()) && crumb.includes(tabText.trim()) && h1.trim() === "", JSON.stringify({ tabText, crumb, h1 }));

  // ---- favourites and recent
  await addNote("Избранная", "Первый абзац избранной заметки.");
  await noteMenu("Закрепить");
  await sleep(500);
  check("a pinned note shows a star on its tab", (await page.locator(".tab-wrap .tab-pin").count()) >= 1);
  await page.locator(".section-tile", { hasText: "Избранное" }).click();
  await sleep(500);
  check("the library has 'Избранное' and it lists the pinned note", (await page.locator(".notes-list button", { hasText: "Избранная" }).count()) === 1);
  await page.locator(".section-tile", { hasText: "Недавние" }).click();
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
  await page.locator(".section-tile", { hasText: "Корзина" }).click();
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

  // ---- the service line: save state, tags, full words, zoom; no preview button; settings instead of "Файлы и данные"
  await page.locator(".folder-row", { hasText: "Импорт Windows" }).click();
  await page.locator(".notes-list button").first().click();
  await sleep(600);
  const bar = await page.locator(".statusbar").innerText();
  check("the bottom line says 'Сохранено' and spells the words and the signs in full (слов, знак)", /Сохранено/.test(bar) && /\d+ слов/.test(bar) && /\d+ знак/.test(bar) && !/Сохраняется на этом/.test(bar), bar.replace(/\s+/g, " ").slice(0, 120));
  check("the top bar no longer shows the save label, the tag pill or a preview button", (await page.locator(".topbar .save-label, .topbar .tag-pill").count()) === 0 && (await page.getByRole("button", { name: /Предпросмотр|Редактировать$/ }).count()) === 0);
  await page.getByRole("button", { name: "Метки заметки" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("работа, идеи");
  await page.getByRole("button", { name: "Готово" }).click();
  await sleep(600);
  check("the note tags are shown in the bottom line", (await page.locator(".statusbar .status-tag").allInnerTexts()).join(",") === "работа,идеи");
  check("'Файлы и данные' moved into the application settings", (await page.locator("summary[aria-label='Файлы и данные']").count()) === 0 && (await page.locator("summary[aria-label='Настройки приложения']").count()) === 1);
  await page.locator("summary[aria-label='Настройки приложения']").click();
  const settings = await page.locator(".settings-menu .note-toolbar-menu").innerText();
  check("the settings menu holds files, backups, theme and shortcuts", /Открыть файлы/.test(settings) && /резервную копию/.test(settings) && /тема/i.test(settings) && /Сочетания клавиш/.test(settings));
  await page.keyboard.press("Escape");
  await page.locator(".settings-menu summary").click();

  // ---- zoom: buttons, keys and Ctrl + wheel
  await page.locator(".editor-column:not(.second-column) .bn-editor").click();
  await page.getByRole("button", { name: "Увеличить масштаб текста" }).click();
  check("the zoom plus button grows the text", (await page.locator(".status-zoom-value").innerText()).includes("110%"));
  await page.mouse.move(700, 400);
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -100); await page.keyboard.up("Control");
  await sleep(300);
  check("Ctrl + wheel zooms the text", (await page.locator(".status-zoom-value").innerText()).includes("120%"));
  await page.getByRole("button", { name: "Уменьшить масштаб текста" }).click();
  await page.locator(".status-zoom-value").click();
  check("the percent resets the zoom to 100%", (await page.locator(".status-zoom-value").innerText()).includes("100%"));

  // ---- the tab strip scrolls sideways
  const strip = async () => page.evaluate(() => { const e = document.querySelector(".tabs-scroller"); return { sl: Math.round(e.scrollLeft), over: e.scrollWidth > e.clientWidth }; });
  check("with many tabs the strip has scroll arrows", (await strip()).over && (await page.locator(".tabs-arrow").count()) === 2);
  const before = (await strip()).sl;
  await page.locator(".tabs-scroller").hover();
  await page.mouse.wheel(0, 200);
  await sleep(400);
  const afterWheel = (await strip()).sl;
  await page.getByRole("button", { name: "Прокрутить вкладки вправо" }).click();
  await sleep(700);
  const afterRight = (await strip()).sl;
  await page.getByRole("button", { name: "Прокрутить вкладки влево" }).click();
  await sleep(700);
  const afterLeft = (await strip()).sl;
  check("the mouse wheel and the arrows move the tabs right and left", afterWheel > before && afterRight > afterWheel - 1 && afterLeft < afterRight, JSON.stringify({ before, afterWheel, afterRight, afterLeft }));

  // ---- "Заметка N": numbers follow the order of the automatically named notes
  const autoTitles = async () => (await page.locator(".tab-wrap .tab").allInnerTexts()).map((t) => t.trim()).filter((t) => /^Заметка \d+$/.test(t));
  await page.locator(".folder-row", { hasText: "Входящие" }).click();
  const base = (await autoTitles()).length;
  const seq = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => `Заметка ${i + 1}`));
  for (let i = 0; i < 3; i++) { await page.getByRole("button", { name: "Быстро создать заметку" }).click(); await sleep(500); }
  await page.locator(".folder-row", { hasText: "Входящие" }).click();
  await sleep(400);
  check("three new notes continue the numbering without gaps", JSON.stringify((await autoTitles()).sort()) === seq(base + 3), JSON.stringify(await autoTitles()));
  await page.locator(".tab-wrap", { hasText: "Заметка 2" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /В корзину/ }).click();
  await page.locator(".confirm-modal .form-submit").click();
  await sleep(700);
  check("after one is trashed the rest close up with no gap", JSON.stringify((await autoTitles()).sort()) === seq(base + 2), JSON.stringify(await autoTitles()));
  await page.locator(".tab-wrap", { hasText: "Заметка 1" }).first().locator(".tab").click();
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  await page.locator(".note-menu .note-toolbar-menu").getByRole("button", { name: "Переименовать" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Мой план");
  await page.getByRole("button", { name: "Готово" }).click();
  await sleep(800);
  check("after a rename the numbers close up again", JSON.stringify((await autoTitles()).sort()) === seq(base + 1), JSON.stringify(await autoTitles()));

  // ---- an empty note counts nothing; two long notes side by side never push the window past the screen
  await page.getByRole("button", { name: "Быстро создать заметку" }).click();
  await sleep(600);
  check("an empty note says '0 слов · 0 знаков'", /0 слов/.test(await page.locator(".statusbar").innerText()) && /0 знаков/.test(await page.locator(".statusbar").innerText()), (await page.locator(".statusbar").innerText()).replace(/\s+/g, " ").slice(0, 100));
  await page.locator(".folder-row", { hasText: "Импорт Windows" }).click();
  await page.locator(".notes-list button").nth(1).click();
  await sleep(500);
  await page.getByRole("button", { name: "Две заметки на экране" }).click();
  await sleep(900);
  const fit = await page.evaluate(() => ({ doc: document.scrollingElement.scrollHeight, vh: innerHeight }));
  check("two notes side by side keep the window inside the screen", fit.doc <= fit.vh + 1, JSON.stringify(fit));
  await page.getByRole("button", { name: "Закрыть правую заметку" }).click();
  await sleep(400);

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
