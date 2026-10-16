// 30 real tasks for the AI assistant on texts copied from the internet (Wikipedia), through the real window and the REAL local model.
// Usage: node tests/e2e/ai-eval-e2e.mjs <NotepadHub4.exe (Debug)> <data-v3.zip> <corpus-dir> <out.jsonl>
// For each task: pick the action in the panel, wait for the proposal, record the raw answer, then (for edits) press Apply, read the
// sheet, press Ctrl+Z and check the note came back. For insights: insert as insight, check the heading, undo.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(path.join(process.env.USERPROFILE, ".local/share/orca-design-tools/package.json"));
const { chromium } = require("playwright-core");
const [exe, zip, corpusDir, outFile] = process.argv.slice(2);
const PORT = 9371;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nh4-e2e-"));
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${root}' -Force`]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (k) => fs.readFileSync(path.join(corpusDir, k + ".txt"), "utf8").trim();

// deterministic typos: every 11th long word gets one mistake (drop, swap or double a letter)
function injectTypos(text) {
  const kinds = ["drop", "swap", "double"];
  let n = 0, k = 0;
  const typos = [];
  const out = text.replace(/[A-Za-zА-Яа-яЁё]{6,}/g, (word) => {
    n += 1;
    if (n % 11 !== 0) return word;
    const i = 2 + (k % Math.max(1, word.length - 4));
    const kind = kinds[k++ % 3];
    const bad = kind === "drop" ? word.slice(0, i) + word.slice(i + 1) : kind === "swap" ? word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2) : word.slice(0, i) + word[i] + word.slice(i);
    typos.push({ good: word, bad });
    return bad;
  });
  return { text: out, typos };
}

const TEXTS = { A: "A_cat", B: "B_internet", C: "C_borscht", D: "D_solar", E: "E_ai", F: "F_coffee" };
const FIX = "Исправить", REWRITE = "Переписать", SHORTEN = "Сжать", EXPAND = "Расширить", CONT = "Продолжить", STRUCT = "Структурировать";
const SUM = "Краткое содержание", KEY = "Ключевые пункты", QST = "Вопросы для размышления", TOC = "Оглавление", ANALYSIS = "Структурный анализ";
// id, text, kind (edit | insight | custom), label (chip) or instruction
const TASKS = [
  [1, "A", "edit", FIX, "typo"], [2, "A", "edit", SHORTEN], [3, "A", "insight", SUM], [4, "A", "insight", KEY], [5, "A", "edit", STRUCT],
  [6, "B", "edit", FIX, "typo"], [7, "B", "edit", REWRITE], [8, "B", "insight", SUM], [9, "B", "insight", QST], [10, "B", "insight", TOC],
  [11, "C", "edit", FIX, "typo"], [12, "C", "edit", EXPAND], [13, "C", "insight", KEY], [14, "C", "custom", "Составь список ингредиентов борща маркированным списком, только из текста."], [15, "C", "edit", CONT],
  [16, "D", "edit", FIX, "typo"], [17, "D", "edit", SHORTEN], [18, "D", "insight", SUM], [19, "D", "insight", ANALYSIS], [20, "D", "custom", "Выпиши все числа и единицы измерения из текста маркированным списком."],
  [21, "E", "edit", FIX, "typo"], [22, "E", "custom", "Перепиши текст так, чтобы его понял школьник, сохрани все факты."], [23, "E", "insight", KEY], [24, "E", "insight", QST], [25, "E", "edit", SHORTEN],
  [26, "F", "edit", FIX, "typo"], [27, "F", "edit", SHORTEN], [28, "F", "insight", SUM], [29, "F", "edit", REWRITE], [30, "F", "custom", "Extract the five most important facts as a numbered list, in English."],
];

let child, browser, page;
async function connect() {
  child = spawn(exe, [], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root, NOTEPADHUB_DEBUG_PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* starting */ } await sleep(250); }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  for (let i = 0; i < 120 && !page; i++) { for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("https://app.notepadhub.local")) page = p; if (!page) await sleep(250); }
  page.on("dialog", (d) => d.accept());
}
const sheetText = async () => (await page.locator(".bn-editor").innerText()).replace(/ /g, " ").replace(/\s+/g, " ").trim();
const norm = (t) => t.replace(/ /g, " ").replace(/\s+/g, " ").trim();

async function addNote(title, text) {
  await page.locator('input[aria-label="Выбрать текстовый файл"]').setInputFiles({ name: title + ".txt", mimeType: "text/plain", buffer: Buffer.from(text, "utf8") });
  await page.waitForFunction((t) => document.querySelector(".crumb-title")?.textContent?.includes(t), title, { timeout: 10000 });
  await sleep(500);
}

const results = [];
const noteIds = {};
try {
  await connect();
  await page.waitForSelector(".topbar", { timeout: 40000 });

  // one clean note and one note with typos per text
  const typoInfo = {};
  for (const [letter, key] of Object.entries(TEXTS)) {
    const clean = read(key);
    await addNote(`${letter} чистый`, clean);
    const ty = injectTypos(clean);
    typoInfo[letter] = ty;
    await addNote(`${letter} опечатки`, ty.text);
  }
  fs.writeFileSync(outFile + ".typos.json", JSON.stringify(typoInfo, null, 1));

  const modelInfo = { name: "" };
  for (const [id, letter, kind, label, flag] of TASKS) {
    const rec = { id, letter, kind, label: kind === "custom" ? label.slice(0, 60) : label, typo: flag === "typo" };
    const t0 = Date.now();
    try {
      const title = `${letter} ${flag === "typo" ? "опечатки" : "чистый"}`;
      const opened = await page.evaluate((t) => { const b = [...document.querySelectorAll(".tab")].find((x) => (x.textContent ?? "").trim() === t); if (b) { b.click(); return true; } return false; }, title);
      if (!opened) throw new Error("note tab not found: " + title);
      await page.waitForSelector(".bn-editor", { state: "visible", timeout: 10000 });
      await sleep(700);
      if (!(await page.locator(".crumb-title").innerText()).trim().startsWith(title)) throw new Error("wrong note open: " + title);
      const before = await sheetText();
      rec.sourceChars = before.length;
      if (!(await page.locator(".ai-assistant").count())) await page.getByRole("button", { name: "Открыть AI-помощник" }).click();
      await page.getByRole("radio", { name: "Вся заметка" }).click();

      if (kind === "custom") {
        await page.locator("#ais-instruction").fill(label);
        await page.locator("#ais-instruction").press("Control+Enter");
      } else {
        await page.getByRole("button", { name: label, exact: true }).click();
      }
      await page.waitForSelector(".ais-proposal, .ai-error", { timeout: 300000 });
      rec.seconds = Math.round((Date.now() - t0) / 100) / 10;
      const err = await page.locator(".ai-error").allInnerTexts();
      if (err.length && !(await page.locator(".ais-proposal").count())) { rec.error = err.join(" | "); results.push(rec); fs.appendFileSync(outFile, JSON.stringify(rec) + "\n"); continue; }
      rec.output = await page.locator(".ais-proposal .ai-proposal-text").getAttribute("data-raw");
      rec.truncated = (await page.locator(".ais-truncated").count()) > 0;
      rec.appChecks = await page.locator(".ais-checks li").allInnerTexts();
      rec.cleaned = (await page.locator(".ais-cleaned").allInnerTexts()).join(" ");
      rec.modelLine = (await page.locator(".ais-proposal header small").first().innerText()).trim();
      modelInfo.name = rec.modelLine;

      // apply and undo
      const apply = page.locator(".ai-accept");
      if (kind !== "custom" && (await apply.count()) && !(await apply.isDisabled())) {
        await apply.click();
        await sleep(1200);
        const after = await sheetText();
        rec.applied = true;
        rec.sheetAfter = after;
        rec.sheetChanged = after !== before;
        rec.hasInsightHeading = kind === "insight" ? (await page.locator(".bn-editor [data-content-type='heading']", { hasText: label }).count()) > 0 : undefined;
        await page.keyboard.press("Control+z");
        await sleep(800);
        const undone = await sheetText();
        rec.undoRestored = undone === before;
        if (!rec.undoRestored) { await page.getByRole("button", { name: "Отменить", exact: true }).click(); await sleep(600); rec.undoRestored = (await sheetText()) === before; rec.undoNeededButton = true; }
      }
      await page.getByRole("button", { name: "Отклонить" }).click().catch(() => {});
    } catch (e) {
      rec.error = String(e.message ?? e).split("\n")[0].slice(0, 200);
      rec.seconds = Math.round((Date.now() - t0) / 100) / 10;
      await page.getByRole("button", { name: "Отклонить" }).click().catch(() => {});
    }
    results.push(rec);
    fs.appendFileSync(outFile, JSON.stringify(rec) + "\n");
    console.log(`task ${id}/${TASKS.length} ${rec.label}: ${rec.error ? "ERROR " + rec.error : rec.seconds + " s, " + (rec.output ?? "").length + " chars, applied=" + rec.applied + ", undo=" + rec.undoRestored}`);
  }
  console.log("MODEL:", modelInfo.name);
} catch (e) {
  console.log("FATAL", String(e.message ?? e).split("\n")[0]);
} finally {
  try { await browser?.close(); } catch { /* */ }
  if (child) { try { process.kill(child.pid); } catch { /* */ } }
  await sleep(1500);
  if (root.includes("nh4-e2e-")) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { console.log("temp profile left:", root); } }
}
console.log("DONE", results.length);
