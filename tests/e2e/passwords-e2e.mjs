// Note passwords: protect, lock, wrong and right password, nothing readable on disk, search blind to the text, remove the password.
// Usage: node tests/e2e/passwords-e2e.mjs <NotepadHub4.exe (Debug)> <data-v3.zip>
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
const PORT = 9381;
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


  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const filesWith = (needle) => walk(root).filter((f) => { try { return fs.readFileSync(f, "utf8").includes(needle); } catch { return false; } });
  const menu = async (name) => { await page.locator("summary[aria-label='Дополнительные действия заметки']").click(); await page.locator(".note-menu .note-toolbar-menu").getByRole("button", { name }).click(); };
  const SECRET = "Секретный текст про лодку";
  await addNote("Тайна", SECRET);
  await sleep(1200);
  check("before the password the text is on disk (so the next check means something)", filesWith("про лодку").length >= 1);
  await menu(/Защитить паролем/);
  await page.getByRole("dialog").getByLabel("Новый пароль").fill("лето2026");
  await page.getByRole("dialog").getByLabel("Повторите пароль").fill("другой");
  await page.getByRole("button", { name: "Готово" }).click();
  check("different passwords are refused", /не совпадают/.test(await page.getByRole("dialog").innerText()));
  await page.getByRole("dialog").getByLabel("Повторите пароль").fill("лето2026");
  await page.getByRole("button", { name: "Готово" }).click();
  await sleep(2500);
  check("the note keeps working after the password is set (text visible, lock mark in the list)", (await page.locator(".bn-editor").first().innerText()).includes("про лодку") && (await page.locator(".notes-list li", { hasText: "Тайна" }).locator("svg.lucide-lock").count()) >= 1);
  check("nothing of the text is readable on disk any more", filesWith("про лодку").length === 0, JSON.stringify(filesWith("про лодку")));
  await menu(/Заблокировать сейчас/);
  await sleep(2500);
  check("the locked note shows the lock screen and no text in the page", (await page.locator(".lock-screen").count()) === 1 && !(await page.content()).includes("про лодку"));
  await page.getByRole("button", { name: "Поиск заметок и команд" }).click();
  await page.locator("#global-search").fill("лодку");
  await sleep(600);
  check("the search does not find the text of a protected note", (await page.locator(".search-result").count()) === 0 || !(await page.locator(".search-modal").innerText()).includes("Тайна"));
  await page.keyboard.press("Escape");
  await page.getByLabel("Пароль заметки").fill("не тот пароль");
  await page.getByRole("button", { name: "Открыть", exact: true }).click();
  await sleep(1500);
  const lockMsg = await page.locator(".lock-error").innerText().catch(() => "none"); check("a wrong password is refused with a message", /Неверный пароль/.test(lockMsg) && (await page.locator(".lock-screen").count()) === 1, lockMsg);
  await page.getByLabel("Пароль заметки").fill("лето2026");
  await page.getByRole("button", { name: "Открыть", exact: true }).click();
  await sleep(2500);
  check("the right password opens the note", (await page.locator(".lock-screen").count()) === 0 && (await page.locator(".bn-editor").first().innerText()).includes("про лодку"));
  await page.locator(".bn-editor").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" и вёсла");
  await sleep(1800);
  check("an edit of the unlocked note is saved encrypted", filesWith("вёсла").length === 0 && filesWith("NHENC1:").length >= 1);
  await menu(/Снять пароль/);
  await page.getByRole("dialog").getByLabel("Пароль заметки").fill("лето2026");
  await page.getByRole("button", { name: "Готово" }).click();
  await sleep(2500);
  check("after 'Снять пароль' the text is plain on disk again", filesWith("про лодку").length >= 1 && (await page.locator(".bn-editor").first().innerText()).includes("вёсла"));
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
