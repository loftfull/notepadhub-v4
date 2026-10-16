// End-to-end journey on a COPY of the owner's profile: create -> find -> act -> delete -> clean the trash. Takes a real screenshot at every step.
// Usage: node tests/e2e/journey-e2e.mjs <NotepadHub4.exe (Debug)> <data-v3.zip> <evidence folder>
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(path.join(process.env.USERPROFILE, ".local/share/orca-design-tools/package.json"));
const { chromium } = require("playwright-core");
const [exe, zip, evidence] = process.argv.slice(2);
fs.mkdirSync(evidence, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nh4-e2e-"));
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${root}' -Force`]);
const PORT = 9399;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const TITLE = "Письмо журнала";
const BODY = "Добрый день, Анна Сергеевна!\n\nПишу Вам по поводу нашей встречи. Мы обсудили сроки поставки оборудования - они остаются прежними.\n\nПрошу подтвердить,что Вы согласны с графиком.\n- поставка 12 марта\n- монтаж 15 марта\n\nС уважением\nИван Петров";

let child, browser, page;
const shot = async (name) => { await sleep(600); await page.screenshot({ path: path.join(evidence, name) }); };
try {
  child = spawn(exe, [], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root, NOTEPADHUB_DEBUG_PORT: String(PORT), OLLAMA_HOST: "http://127.0.0.1:1" }, stdio: "ignore" });
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* starting */ } await sleep(250); }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  for (let i = 0; i < 120 && !page; i++) { for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("https://app.notepadhub.local")) page = p; if (!page) await sleep(250); }
  await page.waitForSelector(".topbar", { timeout: 40000 });
  await page.evaluate(() => localStorage.setItem("nh4-ai-provider", "ollama"));   // no model in the journey (the local address is dead): the structure step uses the safe rules
  await page.reload();
  await page.waitForSelector(".topbar", { timeout: 40000 });

  // 1. create
  await page.locator('input[aria-label="Выбрать текстовый файл"]').setInputFiles({ name: TITLE + ".txt", mimeType: "text/plain", buffer: Buffer.from(BODY, "utf8") });
  await page.waitForFunction((t) => document.querySelector(".crumb-title")?.textContent?.includes(t), TITLE, { timeout: 10000 });
  await shot("01-created.png");
  check("1 create: the note is open and listed in the library", (await page.locator(".notes-list button", { hasText: TITLE }).count()) === 1);

  // 2. find: open another note, then find this one by the search
  await page.locator(".notes-list button").first().click();
  await sleep(500);
  await page.getByRole("button", { name: "Поиск заметок и команд" }).click();
  await page.locator("#global-search").fill(TITLE);
  await page.locator(".search-result", { hasText: TITLE }).first().waitFor({ timeout: 10000 });
  await shot("02-found-by-search.png");
  await page.locator(".search-result", { hasText: TITLE }).first().click();
  await page.waitForFunction((t) => document.querySelector(".crumb-title")?.textContent?.includes(t), TITLE, { timeout: 10000 });
  check("2 find: the search opens the note", (await page.locator(".crumb-title").innerText()).includes(TITLE));

  // 3. act: structure
  await page.getByRole("button", { name: "Открыть AI-помощник" }).click();
  await page.getByRole("button", { name: /^Структурировать/ }).first().click();
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Автоформат:/.test(t.textContent ?? "")), null, { timeout: 90000 }).catch(() => {});
  await sleep(800);
  const text = await page.locator(".editor-column:not(.second-column) .bn-editor").innerText();
  await shot("03-structured.png");
  check("3 act: the structure step made a list, a comma space, a dash and kept the words", /поставка 12 марта/.test(text) && /подтвердить, что/.test(text) && !/подтвердить,что/.test(text) && text.includes("С уважением,"), JSON.stringify(text.slice(0, 160)));
  await page.getByRole("button", { name: "Закрыть AI-помощник" }).first().click();

  // 4. delete: confirm, then the note is in the trash
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  await page.locator(".note-menu .note-toolbar-menu").getByRole("button", { name: "В корзину", exact: true }).click();
  await page.locator(".confirm-modal").waitFor({ timeout: 8000 });
  await shot("04-delete-question.png");
  await page.locator(".confirm-modal .form-submit").click();
  await sleep(800);
  await page.locator(".folder-row", { hasText: "Корзина" }).click();
  await page.locator(".trash-list li", { hasText: TITLE }).waitFor({ timeout: 8000 });
  await shot("05-in-trash.png");
  check("4 delete: the note asks first and lands in the trash list", (await page.locator(".trash-list li", { hasText: TITLE }).count()) === 1);

  // 5. clean the trash
  await page.getByRole("button", { name: "Очистить корзину" }).click();
  await page.locator(".confirm-modal").waitFor({ timeout: 8000 });
  await page.locator(".confirm-modal .form-submit").click();
  await sleep(1200);
  await shot("06-trash-empty.png");
  check("5 clean: the trash is empty after the question", (await page.locator(".trash-list li").count()) === 0);
} catch (e) {
  check("journey completed without exceptions", false, String(e.message ?? e).split("\n").slice(0, 4).join(" | "));
} finally {
  try { await browser?.close(); } catch { /* */ }
  if (child) { try { process.kill(child.pid); } catch { /* */ } }
  await sleep(1500);
  if (root.includes("nh4-e2e-")) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* */ } }
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
