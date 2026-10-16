// Ideas taken over from the analogue (Obsidian), docs/design/2026-10-16-analogue-obsidian.md: history back/forward, notes list with date groups,
// sort and a first line, the note menu in groups, the outline of headings, the count of backlinks in the bottom line.
// Usage: node tests/e2e/ideas-e2e.mjs <NotepadHub4.exe (Debug)> <data-v3.zip>
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
const PORT = 9374;
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child, browser, page;
const addNote = async (title, body) => {
  await page.locator('input[aria-label="Выбрать текстовый файл"]').setInputFiles({ name: title + ".txt", mimeType: "text/plain", buffer: Buffer.from(body, "utf8") });
  await page.waitForFunction((t) => document.querySelector(".crumb-title")?.textContent?.includes(t), title, { timeout: 10000 });
  await sleep(500);
};
const crumb = async () => (await page.locator(".crumb-title").innerText()).trim();
try {
  child = spawn(exe, [], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root, NOTEPADHUB_DEBUG_PORT: String(PORT), OLLAMA_HOST: "http://127.0.0.1:1" }, stdio: "ignore" });
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* starting */ } await sleep(250); }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  for (let i = 0; i < 120 && !page; i++) { for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("https://app.notepadhub.local")) page = p; if (!page) await sleep(250); }
  await page.waitForSelector(".topbar", { timeout: 40000 });

  await addNote("Цель", "Это заметка, на которую будут ссылаться.");
  await addNote("Ссылающаяся", "Смотрите [[Цель]] для подробностей.");
  await addNote("Третья", "Просто третья заметка с текстом для начала.");

  // ---- history: the buttons are gone (undo and redo are in the top bar), Alt + arrows still walk through the opened notes
  check("the top bar has no back/forward note buttons", (await page.getByRole("button", { name: /Назад к предыдущей заметке|Вперёд к следующей заметке/ }).count()) === 0);
  await page.keyboard.press("Alt+ArrowLeft");
  await sleep(600);
  check("Alt + left opens the note opened before", (await crumb()) === "Ссылающаяся", await crumb());
  await page.keyboard.press("Alt+ArrowLeft");
  await sleep(600);
  check("Alt + left goes one more step back", (await crumb()) === "Цель", await crumb());
  await page.keyboard.press("Alt+ArrowRight");
  await sleep(600);
  check("Alt + right returns to the next note", (await crumb()) === "Ссылающаяся", await crumb());

  // ---- notes list: date groups, sort, first line
  await page.getByRole("button", { name: /Сортировка: по названию/ }).count();
  const groups = await page.locator(".notes-group").allInnerTexts();
  check("the notes list is grouped by the day of the last change ('Сегодня' first)", groups.length >= 1 && /сегодня/i.test(groups[0]), JSON.stringify(groups));
  await page.locator(".notes-group button", { hasText: "Сегодня" }).click();
  await sleep(300);
  check("a group folds", (await page.locator(".notes-list li:not(.notes-group)", { hasText: "Третья" }).count()) === 0);
  await page.locator(".notes-group button", { hasText: "Сегодня" }).click();
  await page.getByRole("button", { name: /Показывать начало текста/ }).click();
  await sleep(300);
  const snippet = await page.locator(".notes-list li", { hasText: "Третья" }).locator(".note-snippet").innerText().catch(() => "");
  check("the first line of the text shows under the title on request", /Просто третья заметка/.test(snippet), snippet);
  await page.getByRole("button", { name: /Показывать начало текста/ }).click();
  await page.getByRole("button", { name: /Сортировка: по изменению/ }).click();
  await sleep(300);
  const names = await page.locator(".notes-list .note-name").allInnerTexts();
  const sorted = [...names].sort((a, b) => a.localeCompare(b, "ru"));
  check("sorting by name removes the groups and orders the notes", (await page.locator(".notes-group").count()) === 0 && JSON.stringify(names) === JSON.stringify(sorted), JSON.stringify(names.slice(0, 4)));
  await page.getByRole("button", { name: /Сортировка: по названию/ }).click();

  // ---- the note menu in groups
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  const menu = page.locator(".note-menu .note-toolbar-menu");
  const items = await menu.locator("button").allInnerTexts();
  const last = items[items.length - 1] ?? "";
  check("the note menu has the find/replace, copy-link and Explorer items", ["Найти в заметке", "Заменить", "Копировать ссылку на заметку", "Показать в Проводнике", "Содержание и свойства"].every((t) => items.some((x) => x.includes(t))), JSON.stringify(items));
  check("the menu is in groups and 'В корзину' is last, red and alone", (await menu.locator(".note-toolbar-menu-divider").count()) >= 5 && last.includes("В корзину") && (await menu.locator("button.destructive-action").last().innerText()).includes("В корзину"));
  await menu.getByRole("button", { name: /Копировать ссылку на заметку/ }).click();
  await sleep(1000);
  check("'Копировать ссылку' tells what was copied", /\[\[.+\]\]/.test(await page.locator(".toast").first().innerText().catch(() => "")), await page.locator(".toast").first().innerText().catch(() => ""));
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  await page.locator(".note-menu .note-toolbar-menu").getByRole("button", { name: /Найти в заметке/ }).click();
  await sleep(500);
  check("'Найти в заметке' opens the search bar of the note", (await page.locator(".find-bar, [role=search].find-bar, .findbar").count()) >= 1 || (await page.getByPlaceholder(/Найти/).count()) >= 1);
  await page.keyboard.press("Escape");

  // ---- the outline in the inspector
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  await page.locator(".note-menu .note-toolbar-menu").getByRole("button", { name: /Содержание и свойства/ }).click();
  await page.locator(".outline-list li").first().waitFor({ timeout: 5000 });
  check("the inspector lists the headings of the note", (await page.locator(".outline-list li").count()) >= 1, (await page.locator(".outline-list").innerText()).slice(0, 60));
  await page.locator(".outline-list button").first().click();
  await sleep(300);

  // ---- backlinks in the bottom line
  await page.locator(".notes-list button", { hasText: "Цель" }).first().click();
  await sleep(700);
  check("the bottom line counts the notes that link here", /Обратных ссылок: 1/.test(await page.locator(".statusbar").innerText()), (await page.locator(".statusbar").innerText()).replace(/\s+/g, " ").slice(0, 120));

  // ---- the search results: counts, highlighted words, up to three snippets of a note (idea of the Notebook Navigator)
  await page.getByRole("button", { name: "Поиск заметок и команд" }).click();
  await page.locator("#global-search").fill("заметка");
  await page.locator(".search-result").first().waitFor({ timeout: 5000 });
  const head = await page.locator(".search-results-label").innerText();
  check("the search says how many matches in how many notes", /Найдено: \d+ совпад\S* в \d+ замет/.test(head), head.replace(/\s+/g, " "));
  check("the matched words are highlighted and every result has its match count", (await page.locator(".search-result mark").count()) >= 1 && (await page.locator(".search-result .search-matches").count()) >= 1);
  await page.keyboard.press("Escape");

  // ---- calendar: days with notes are marked, a day shows its notes; one button folds all the groups
  await page.getByRole("button", { name: "Свернуть или развернуть все группы" }).click();
  await sleep(300);
  check("one button folds all the date groups", (await page.locator(".notes-group button[aria-expanded='true']").count()) === 0 && (await page.locator(".notes-group").count()) >= 2);
  await page.getByRole("button", { name: "Свернуть или развернуть все группы" }).click();
  await page.getByRole("button", { name: "Календарь: заметки по дням" }).click();
  await page.locator(".calendar-pop").waitFor({ timeout: 5000 });
  check("today is marked in the calendar and has notes", (await page.locator(".calendar-day.is-today.has-notes").count()) === 1);
  await page.locator(".calendar-day.is-today").click();
  await sleep(500);
  const dayNames = await page.locator(".notes-list .note-name").allInnerTexts();
  check("a click on a day lists the notes changed on that day, from every project", await page.locator(".day-chip").count() === 1 && dayNames.includes("Цель") && dayNames.includes("Третья") && !dayNames.includes(".env"), JSON.stringify(dayNames.slice(0, 5)));
  await page.locator(".day-chip").click();
  await sleep(300);
  check("the chip clears the day filter", (await page.locator(".day-chip").count()) === 0);

  // ---- nested projects: tree, count with nested notes, fold, settings switch, drag and drop, saved on disk
  const addProject = async (name, parentRow) => {
    if (parentRow) { await page.locator(".folder-item", { hasText: parentRow }).first().hover(); await page.getByRole("button", { name: `Новый вложенный проект в «${parentRow}»` }).click(); }
    else await page.getByRole("button", { name: "Добавить проект" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill(name);
    await page.getByRole("button", { name: "Готово" }).click();
    await sleep(500);
  };
  await addProject("Работа");
  await addProject("Клиенты", "Работа");
  check("a nested project sits one level deeper than its parent", (await page.locator(".folder-item[data-depth='1']", { hasText: "Клиенты" }).count()) === 1 && (await page.locator(".folder-item[data-depth='0']", { hasText: "Работа" }).count()) === 1);
  await addNote("Договор", "Текст договора с клиентом.");
  await sleep(500);
  const countOf = async (name) => (await page.locator(".folder-item", { hasText: name }).first().locator(".folder-count").innerText()).trim();
  check("the parent counts the notes of its nested projects", (await countOf("Работа")) === "1" && (await countOf("Клиенты")) === "1", `${await countOf("Работа")}/${await countOf("Клиенты")}`);
  await page.locator(".folder-row", { hasText: "Работа" }).click();
  await sleep(400);
  check("selecting the parent lists the notes of the nested project too", (await page.locator(".notes-list .note-name", { hasText: "Договор" }).count()) === 1);
  await page.locator("summary[aria-label='Настройки приложения']").click();
  await page.getByRole("menuitemcheckbox", { name: /Заметки вложенных проектов/ }).click();
  await sleep(400);
  check("the setting 'Заметки вложенных проектов' limits the list to the project itself", (await page.locator(".notes-list .note-name", { hasText: "Договор" }).count()) === 0);
  await page.locator("summary[aria-label='Настройки приложения']").click();
  await page.getByRole("menuitemcheckbox", { name: /Заметки вложенных проектов/ }).click();
  await sleep(300);
  check("and switches back", (await page.locator(".notes-list .note-name", { hasText: "Договор" }).count()) === 1);
  await page.getByRole("button", { name: "Свернуть проект «Работа»" }).click();
  check("a parent folds and hides its nested projects", (await page.locator(".folder-item", { hasText: "Клиенты" }).count()) === 0);
  await page.getByRole("button", { name: "Развернуть проект «Работа»" }).click();
  await page.locator(".folder-item", { hasText: "Клиенты" }).dragTo(page.locator(".projects-section"), { targetPosition: { x: 20, y: (await page.locator(".projects-section").boundingBox()).height - 3 } });
  await sleep(500);
  check("dragging a project to the free place under the list makes it top level", (await page.locator(".folder-item[data-depth='0']", { hasText: "Клиенты" }).count()) === 1);
  await page.locator(".folder-item", { hasText: "Клиенты" }).dragTo(page.locator(".folder-item", { hasText: "Работа" }).first());
  await sleep(500);
  check("dragging a project onto another nests it", (await page.locator(".folder-item[data-depth='1']", { hasText: "Клиенты" }).count()) === 1);
  await page.locator(".folder-item", { hasText: "Работа" }).first().dragTo(page.locator(".folder-item", { hasText: "Клиенты" }).first());
  await page.locator(".toast", { hasText: "нельзя вложить" }).waitFor({ timeout: 4000 }).catch(() => {});
  check("a project cannot be nested inside its own nested project", (await page.locator(".folder-item[data-depth='0']", { hasText: "Работа" }).count()) === 1 && /нельзя вложить/.test(await page.locator(".toast").first().innerText().catch(() => "")));
  if (process.env.NH_SHOT) await page.screenshot({ path: process.env.NH_SHOT });
  const findFile = (dir, name) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { const r = findFile(f, name); if (r) return r; } else if (e.name === name) return f; } return null; };
  await sleep(1500);
  const saved = JSON.parse(fs.readFileSync(findFile(root, "projects.json"), "utf8"));
  const work = saved.find((x) => x.Name === "Работа"), clients = saved.find((x) => x.Name === "Клиенты");
  check("the nesting is saved in projects.json", Boolean(work && clients) && clients.ParentId === work.Id && work.ParentId === "", JSON.stringify(saved.map((x) => [x.Name, x.ParentId])));

  // ---- the automatic name belongs to notes the app named, not to a title the person typed
  await page.getByRole("button", { name: "Быстро создать заметку" }).click();
  await sleep(500);
  await addNote("Заметка 77", "Эту заметку назвал человек.");
  await sleep(800);
  const titles = await page.locator(".notes-list .note-name").allInnerTexts();
  check("a note the person named 'Заметка 77' keeps its name", titles.includes("Заметка 77"), JSON.stringify(titles.filter((x) => x.startsWith("Заметка"))));

  // ---- a pinned note goes to its own group on top; the list can be compact
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  await page.locator(".note-menu .note-toolbar-menu").getByRole("button", { name: "Закрепить", exact: true }).click();
  await sleep(500);
  const groupsNow = await page.locator(".notes-group").allInnerTexts();
  check("pinned notes form the first group of the list", /закреплённые/i.test(groupsNow[0] ?? ""), JSON.stringify(groupsNow));
  await page.locator("summary[aria-label='Настройки приложения']").click();
  await page.getByRole("menuitemcheckbox", { name: /Компактный список/ }).click();
  await sleep(300);
  const rowH = (await page.locator(".notes-list li:not(.notes-group) button").first().boundingBox()).height;
  check("the compact list makes rows lower", rowH <= 27 && (await page.locator(".sidebar.is-dense").count()) === 1, String(rowH));
  await page.locator("summary[aria-label='Настройки приложения']").click();
  await page.getByRole("menuitemcheckbox", { name: /Компактный список/ }).click();

  // ---- ideas of the second analogue (QuickNote AI): all notes, found word lit in the note, modified time, focus mode
  await page.locator(".all-row").click();
  await sleep(500);
  const allNames = await page.locator(".notes-list .note-name").allInnerTexts();
  check("'Все заметки' lists the notes of every project", (await page.locator(".section-label h2").first().innerText()).trim() === "Все заметки" && allNames.includes("Договор") && allNames.includes("Цель"), JSON.stringify(allNames.slice(0, 5)));
  check("the bottom line says when the note was changed", /Изменено/.test(await page.locator(".statusbar").innerText()), (await page.locator(".statusbar").innerText()).replace(/\s+/g, " ").slice(0, 100));
  await page.getByRole("button", { name: "Поиск заметок и команд" }).click();
  await page.locator("#global-search").fill("договора");
  await page.locator(".search-result").first().waitFor({ timeout: 5000 });
  await page.locator(".search-result", { hasText: "Договор" }).first().click();
  await sleep(900);
  check("a note opened from the search shows the found word lit up (find bar prefilled)", (await page.locator(".find-bar .find-input").inputValue().catch(() => "")) === "договора" && /из \d+/.test(await page.locator(".find-count").innerText()), await page.locator(".find-count").innerText().catch(() => "none"));
  await page.keyboard.press("Escape");
  await page.keyboard.press("F11");
  await sleep(400);
  check("F11 turns on the focus mode: panels hidden, editor stays", (await page.locator(".app-shell.is-focus").count()) === 1 && !(await page.locator(".sidebar").isVisible()) && !(await page.locator(".topbar").isVisible()) && (await page.locator(".bn-editor").first().isVisible()));
  if (process.env.NH_SHOT) await page.screenshot({ path: process.env.NH_SHOT.replace(".png", "-focus.png") });
  await page.getByRole("button", { name: /Выйти из режима фокуса/ }).click();
  await sleep(300);
  check("the exit button brings the panels back", (await page.locator(".app-shell.is-focus").count()) === 0 && (await page.locator(".sidebar").isVisible()));

  // ---- the bottom line buttons, the collapse button at the bottom of the sidebar, Notepad parity
  const foot = await page.locator(".sidebar-footer").boundingBox();
  const setBox = await page.locator(".sidebar-footer .settings-menu > summary").boundingBox();
  const colBox = await page.locator(".sidebar-footer .sidebar-collapse").boundingBox();
  check("the collapse button sits at the bottom of the sidebar, right of 'Настройки'", Boolean(foot && colBox && setBox) && colBox.x > setBox.x + setBox.width - 4 && colBox.y > 700 && (await page.locator(".sidebar-toolbar .sidebar-collapse").count()) === 0, JSON.stringify([colBox, setBox]));
  check("the status bar has the buttons Фокус, Сравнение, Метки", (await page.locator(".status-actions .status-action").allInnerTexts()).join("|") === "Фокус|Сравнение|Метки");
  await page.getByRole("button", { name: "Две заметки на экране" }).click();
  await sleep(600);
  check("'Сравнение' in the status bar opens the second note", (await page.locator(".second-card").count()) === 1);
  await page.getByRole("button", { name: "Две заметки на экране" }).click();
  await sleep(400);
  await page.getByRole("button", { name: "Метки заметки" }).click();
  check("'Метки' in the status bar opens the tags dialog", (await page.getByRole("dialog").getByRole("textbox").count()) === 1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Отмена" }).click().catch(() => {});
  await page.getByRole("button", { name: "Режим фокуса" }).click();
  await sleep(300);
  check("'Фокус' in the status bar turns the focus mode on", (await page.locator(".app-shell.is-focus").count()) === 1);
  await page.keyboard.press("F11");
  await sleep(300);
  check("the line and the column of the cursor are shown like in Notepad", /Строка \d+ из \d+, столбец \d+/.test(await page.locator(".statusbar").innerText()), (await page.locator(".statusbar").innerText()).replace(/\s+/g, " ").slice(-90));
  await page.locator(".bn-editor").first().click();
  await page.keyboard.press("F5");
  await sleep(400);
  check("F5 puts the time and the date into the text", /\d\d:\d\d \d\d\.\d\d\.\d{4}/.test(await page.locator(".bn-editor").first().innerText()));
  await page.keyboard.press("Control+g");
  await sleep(300);
  check("Ctrl + G asks for a line number", (await page.getByRole("dialog").getByRole("textbox").count()) === 1 && /Перейти к строке/.test(await page.getByRole("dialog").innerText()));
  await page.getByRole("dialog").getByRole("textbox").fill("1");
  await page.getByRole("button", { name: "Готово" }).click();
  await sleep(300);
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  const menuItems = await page.locator(".note-menu .note-toolbar-menu button").allInnerTexts();
  check("the note menu has 'Сохранить как текст (.txt)', 'Печать…', 'Вставить дату и время', 'Перейти к строке…'", ["Сохранить как текст (.txt)", "Печать", "Вставить дату и время", "Перейти к строке"].every((x) => menuItems.some((y) => y.includes(x))), JSON.stringify(menuItems.slice(0, 12)));
  await page.keyboard.press("Escape");
  await page.locator("summary[aria-label='Настройки приложения']").click();
  await page.getByRole("menuitemcheckbox", { name: /Перенос по словам/ }).click();
  await page.locator("summary[aria-label='Настройки приложения']").click();
  await page.getByRole("menuitemradio", { name: /Шрифт: моноширинный/ }).click();
  await sleep(300);
  check("word wrap off and the monospaced font are applied", (await page.locator(".app-shell.no-wrap.font-mono").count()) === 1);
  await page.locator("summary[aria-label='Настройки приложения']").click();
  await page.getByRole("menuitemcheckbox", { name: /Перенос по словам/ }).click();
  await page.locator("summary[aria-label='Настройки приложения']").click();
  await page.getByRole("menuitemradio", { name: /Шрифт: обычный/ }).click();

  // ---- several notes at once, and dragging a note to a project
  await page.locator(".all-row").click();
  await sleep(400);
  const countNow = async (name) => Number((await page.locator(".folder-item", { hasText: name }).first().locator(".folder-count").innerText()).trim());
  const workBefore = await countNow("Работа");
  const row = (name) => page.locator(".notes-list li:not(.notes-group) button", { hasText: name }).first();
  await row("Третья").click();
  await row("Ссылающаяся").click({ modifiers: ["Control"] });
  await sleep(300);
  check("Ctrl + click picks several notes and shows the bulk bar", (await page.locator(".bulk-bar strong").innerText()).includes("Выбрано: 2"), await page.locator(".bulk-bar strong").innerText().catch(() => "none"));
  await page.getByLabel("Переместить выбранные в проект").selectOption("Работа");
  await sleep(500);
  check("the picked notes move to the chosen project", (await countNow("Работа")) === workBefore + 2 && (await page.locator(".bulk-bar").count()) === 0, `${workBefore} -> ${await countNow("Работа")}`);
  const inboxBefore = await countNow("Входящие");
  await row("Цель").dragTo(page.locator(".folder-item", { hasText: "Входящие" }).first());
  await sleep(500);
  check("dragging a note onto a project moves it there", (await countNow("Входящие")) === inboxBefore + 1, `${inboxBefore} -> ${await countNow("Входящие")}`);
  await row("Третья").click();
  await row("Ссылающаяся").click({ modifiers: ["Shift"] });
  await sleep(300);
  check("Shift + click picks a range", /Выбрано: \d+/.test(await page.locator(".bulk-bar strong").innerText().catch(() => "")));
  await page.getByRole("button", { name: "Снять выбор" }).click();
  check("the bulk bar closes", (await page.locator(".bulk-bar").count()) === 0);
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
