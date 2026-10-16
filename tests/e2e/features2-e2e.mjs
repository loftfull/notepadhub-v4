// Real-window check of: autoformat, title and tags from the content, visible tab borders, an OpenAI-compatible service,
// creating a picture through that service, editing a picture of the note.
// Usage: node tests/e2e/features2-e2e.mjs <NotepadHub4.exe (Debug)> <data-v3.zip>
// Fake local servers stand in for Ollama and for the compatible service (on this computer, so no key or consent is needed).
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";

const require = createRequire(path.join(process.env.USERPROFILE, ".local/share/orca-design-tools/package.json"));
const { chromium } = require("playwright-core");
const [exe, zip] = process.argv.slice(2);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nh4-e2e-"));
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${root}' -Force`]);
const assetsDir = path.join(root, "data-v3", "notes-assets");
const PORT = 9381, OLLAMA_PORT = 11557, COMPAT_PORT = 18766;
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runStructure = async () => { if (!(await page.getByRole("button", { name: "Закрыть AI-помощник" }).count())) await page.getByRole("button", { name: "Открыть AI-помощник" }).click(); await page.getByRole("button", { name: /^Структурировать/ }).first().click(); };
const assetCount = () => (fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).length : 0);

function png(w, h) {
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x * 255) / w; raw[o + 1] = (y * 255) / h; raw[o + 2] = 120; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = png(96, 48);

// fake Ollama: a title-and-tags answer when asked for it, otherwise a plain sentence
let formatCalls = 0;
const fakeOllama = http.createServer((req, res) => {
  if (req.url === "/api/tags") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ models: [{ name: "qwen3.5:4b", size: 3400000000, details: { family: "qwen35", parameter_size: "4.2B" } }] })); return; }
  if (req.url === "/api/chat" && req.method === "POST") {
    let raw = ""; req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const meta = raw.includes("tags") && raw.includes("title");
      let answer = meta ? '{"title":"Заголовок от модели","tags":["тест","пример"]}' : "Ответ локальной модели.";
      const systemPrompt = (() => { try { return JSON.parse(raw).messages[0].content; } catch { return ""; } })();   // the host escapes non-ASCII in JSON, so read the parsed prompt
      if (systemPrompt.includes("Оформи всю заметку")) {
        formatCalls += 1;
        console.log("FORMAT CALL", formatCalls);
        const user = JSON.parse(raw).messages.find((m) => m.role === "user").content;
        const text = user.split("<note-content>")[1].split("</note-content>")[0].trim();
        // first call: the same words with a heading over the second paragraph; second call: a rewrite that loses the words
        answer = formatCalls === 1 ? text.split("\n\n").map((part, i) => (i === 1 ? "## " + part.split(" ").slice(0, 3).join(" ") + "\n\n" + part : part)).join("\n\n") : "Кошки спят.";
      }
      res.write(JSON.stringify({ message: { content: answer } }) + "\n");
      res.end(JSON.stringify({ done: true, done_reason: "stop" }) + "\n");
    });
    return;
  }
  res.writeHead(404); res.end();
});
// fake OpenAI-compatible service on this computer
const compatSeen = { models: 0, chat: 0, images: 0 };
const fakeCompat = http.createServer((req, res) => {
  if (req.url === "/v1/models") { compatSeen.models++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "fake-model" }, { id: "fake-embed-model" }] })); return; }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    compatSeen.chat++;
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"choices":[{"delta":{"content":"Ответ внешнего сервиса."}}]}\n\n'); res.end("data: [DONE]\n\n"); });
    return;
  }
  if (req.url === "/v1/images/generations" && req.method === "POST") {
    compatSeen.images++;
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })); });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => fakeOllama.listen(OLLAMA_PORT, "127.0.0.1", r));
await new Promise((r) => fakeCompat.listen(COMPAT_PORT, "127.0.0.1", r));

const MESSY_BODY = [
  "Кошки — домашние животные, которых люди держат уже тысячи лет. Кошки не только спят: они следят за территорией, прислушиваются к шагам, ловят отражения на стене и устраивают охоту на любой шуршащий предмет, даже если это просто бумажный шарик. Иногда они замирают на несколько минут, глядя в одну точку, а потом резко бросаются за невидимой добычей через всю комнату. Хозяева привыкают к этим странностям и считают их частью характера питомца, хотя учёные объясняют их инстинктами хищника. Они спят до шестнадцати часов в сутки и просыпаются в основном для охоты. Ночью зрение кошек намного лучше человеческого. Они общаются звуками, позами и запахами, а не только мяуканьем. Некоторые породы лучше переносят одиночество, другие требуют постоянного внимания. Дикие предки кошек жили в пустынях, поэтому домашние пьют мало воды. Кошки метят территорию запахом и царапинами. Котята учатся охоте, играя с братьями и сёстрами, а взрослые кошки редко играют друг с другом.",
  "Привычки:",
  "Кошки любят прятаться в закрытых коробках и узких местах, потому что так чувствуют себя защищёнными от неожиданностей.",
  "- Сон — кошки спят в тёплых и тихих местах",
  "- Охота — кошки охотятся ночью и на рассвете",
].join("\n");

let child, browser, page;
try {
  child = spawn(exe, [], { env: { ...process.env, NOTEPADHUB_DATA_ROOT: root, NOTEPADHUB_DEBUG_PORT: String(PORT), OLLAMA_HOST: `http://127.0.0.1:${OLLAMA_PORT}` }, stdio: "ignore" });
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* starting */ } await sleep(250); }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  for (let i = 0; i < 120 && !page; i++) { for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("https://app.notepadhub.local")) page = p; if (!page) await sleep(250); }
  page.on("dialog", (d) => d.accept());
  await page.evaluate(() => localStorage.setItem("nh4-ai-provider", "ollama"));   // the tests use the fake local model; the app itself starts on the free online service
  await page.reload();
  await page.waitForSelector(".topbar", { timeout: 40000 });
  await page.locator('input[aria-label="Выбрать текстовый файл"]').setInputFiles({ name: "Кошки.txt", mimeType: "text/plain", buffer: Buffer.from(MESSY_BODY, "utf8") });
  await page.waitForSelector(".bn-editor", { state: "visible", timeout: 10000 });
  await sleep(600);

  // ---- tabs: visible borders
  const tab = await page.evaluate(() => { const e = document.querySelector(".tab-wrap.is-active"); if (!e) return null; const s = getComputedStyle(e); return { shadow: s.boxShadow, radius: s.borderTopLeftRadius, right: s.borderRightWidth }; });
  const tab2 = await page.evaluate(() => { const e = [...document.querySelectorAll(".tab-wrap:not(.is-active)")][0]; if (!e) return null; const s = getComputedStyle(e); return { right: s.borderRightWidth, color: s.borderRightColor }; });
  check("the open tab is lit by an accent line on top (business style, square corners)", tab && tab.shadow.includes("rgb(0, 103, 192)") && tab.radius === "0px" && parseFloat(tab.right) > 0, JSON.stringify(tab));
  check("the other tabs are separated by a visible thin divider", !tab2 || (parseFloat(tab2.right) > 0 && tab2.color !== "rgba(0, 0, 0, 0)"), JSON.stringify(tab2));

  // ---- autoformat: the model lays the note out and every word must stay; a rewrite is refused and the safe layout is used instead
  const before = await page.locator(".bn-editor").innerText();
  const counts = () => page.evaluate(() => ({ headings: document.querySelectorAll(".bn-editor [data-content-type='heading']").length, paragraphs: document.querySelectorAll(".bn-editor [data-content-type='paragraph']").length, bold: [...document.querySelectorAll(".bn-editor strong, .bn-editor [data-style-type='bold']")].map((n) => n.textContent) }));
  const c0 = await counts();
  await runStructure();
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Оформлено ИИ|оставлено безопасное|Автоформат:/.test(t.textContent ?? "")), null, { timeout: 40000 }).catch(() => {});
  await sleep(600);
  const c1 = await counts();
  console.log("DEBUG blocks:", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".bn-editor [data-content-type]")].map((n) => n.getAttribute("data-content-type") + ":" + (n.textContent ?? "").slice(0, 28)))));
  const toast = await page.locator(".toast").allInnerTexts();
  check("the model's faithful layout is applied (new heading) and announced", c1.headings > c0.headings && toast.some((t) => t.includes("Оформлено ИИ") && t.includes("слова сохранены")), JSON.stringify({ c0, c1, toast }));
  await page.locator(".bn-editor").click();
  await page.keyboard.press("Control+z");
  await sleep(800);
  check("one Ctrl+Z takes the whole model layout back", (await page.locator(".bn-editor").innerText()) === before);
  await runStructure();
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /безопасное оформление/.test(t.textContent ?? "")), null, { timeout: 40000 }).catch(() => {});
  await sleep(600);
  const c2 = await counts();
  const toast2 = await page.locator(".toast").allInnerTexts();
  check("a rewrite by the model is refused: the words stay and the safe layout is used", toast2.some((t) => t.includes("безопасное оформление")) && (await page.locator(".bn-editor").innerText()).replace(/ /g, " ").includes("Кошки — домашние животные, которых люди держат"), JSON.stringify(toast2));
  check("the safe layout makes the colon line a heading, splits the long paragraph and bolds the uniform list", c2.headings > c0.headings && c2.paragraphs >= c0.paragraphs && c2.bold.includes("Сон") && c2.bold.includes("Охота"), JSON.stringify(c2));
  await page.locator(".bn-editor").click();
  await page.keyboard.press("Control+z");
  await sleep(600);

  // ---- title and tags from the content
  await page.locator("summary[aria-label='Дополнительные действия заметки']").click();
  await page.getByRole("button", { name: /Название и метки по содержимому/ }).click();
  await page.waitForSelector("#meta-title", { timeout: 10000 });
  const instant = await page.locator(".form-modal input").first().inputValue();
  check("a title is suggested at once from the text", instant.length >= 3, JSON.stringify(instant));
  await page.waitForFunction(() => document.querySelector("#meta-title")?.closest("form")?.innerText.includes("Подобрано моделью"), null, { timeout: 60000 }).catch(() => {});
  console.log("META STATUS:", JSON.stringify(await page.locator(".form-modal-heading p").first().innerText().catch(() => "")));
  const modelTitle = await page.locator(".form-modal input").first().inputValue();
  const modelTags = await page.locator(".form-modal input").nth(1).inputValue();
  check("the local model improves the title and tags", modelTitle === "Заголовок от модели" && modelTags.includes("тест"), JSON.stringify({ modelTitle, modelTags }));
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await sleep(800);
  check("the note gets the title and the tags", (await page.locator(".crumb-title").innerText()).includes("Заголовок от модели") && (await page.locator(".tag-pill").count()) > 0);

  // ---- an OpenAI-compatible service
  await page.getByRole("button", { name: "Открыть AI-помощник" }).click();
  await page.locator(".ais-model > summary").click();
  await page.getByRole("radio", { name: "Онлайн" }).click();
  await page.getByLabel("Сервис", { exact: true }).selectOption("custom");
  await page.getByLabel("Адрес сервиса").fill(`http://127.0.0.1:${COMPAT_PORT}/v1`);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".ais-model select option")].some((o) => o.textContent?.includes("fake-model")), null, { timeout: 20000 }).catch(() => {});
  console.log("COMPAT STATUS:", JSON.stringify(await page.locator(".ais-compat").innerText().catch(() => "no panel")), "| error:", JSON.stringify(await page.locator(".ai-error").allInnerTexts()));
  const options = await page.locator("select[aria-label='Выбрать модель'] option").allInnerTexts();
  check("the service's models are listed and non-chat models are dropped", options.some((o) => o.includes("fake-model")) && !options.some((o) => o.includes("embed")), JSON.stringify(options));
  check("settings of a service on this computer are accepted without a key", compatSeen.models >= 1);
  await page.locator(".ais-model > summary").click().catch(() => {});
  await page.getByRole("radio", { name: "Вся заметка" }).click();
  await page.getByRole("button", { name: "Исправить", exact: true }).click();
  await page.waitForSelector(".ais-proposal", { timeout: 30000 });
  const answer = await page.locator(".ais-proposal .ai-proposal-text").getAttribute("data-raw");
  check("an answer arrives from the compatible service", (answer ?? "").includes("Ответ внешнего сервиса") && compatSeen.chat >= 1, JSON.stringify(answer));
  await page.getByRole("button", { name: "Отклонить" }).click();
  await page.getByRole("button", { name: "Закрыть AI-помощник" }).first().click();

  // ---- create a picture through the service, then edit it
  const a0 = assetCount();
  await page.locator("summary[aria-label='Изображения: создать или править']").click();
  await page.getByRole("button", { name: /Создать изображение/ }).first().click();
  await page.waitForSelector("#img-gen-title", { timeout: 10000 });
  await page.locator(".image-modal textarea").fill("акварельная кошка на подоконнике");
  await page.locator(".image-modal select").nth(1).selectOption("service");
  await page.locator(".image-modal input[placeholder^='например: dall-e']").fill("fake-image");
  await page.locator(".image-modal input[type=checkbox]").check();
  await page.getByRole("button", { name: /^Создать$/ }).click();
  await page.waitForSelector(".image-result img", { timeout: 30000 }).catch(() => {});
  check("a picture is created through the service and stored by the host", (await page.locator(".image-result img").count()) === 1 && compatSeen.images === 1 && assetCount() === a0 + 1, `images=${compatSeen.images} assets=${assetCount() - a0}`);
  await page.getByRole("button", { name: /Вставить в заметку/ }).click();
  await sleep(1000);
  const imgs = await page.evaluate(() => [...document.querySelectorAll(".bn-editor img")].map((n) => n.getAttribute("src")));
  check("the picture is in the sheet, shown from the host's own address", imgs.length === 1 && imgs[0].startsWith("https://assets.notepadhub.local/"), JSON.stringify(imgs));

  await page.locator("summary[aria-label='Изображения: создать или править']").click();
  await page.getByRole("button", { name: /Править изображение/ }).first().click();
  await page.waitForSelector("#img-edit-title", { timeout: 10000 });
  await page.waitForSelector(".image-stage canvas", { timeout: 15000 });
  const sizeBefore = await page.locator(".image-size").innerText();
  await page.getByRole("button", { name: "Повернуть вправо" }).click();
  await sleep(500);
  const sizeAfter = await page.locator(".image-size").innerText();
  check("the editor shows the picture and rotation swaps its sides", sizeBefore.includes("96×48") && sizeAfter.includes("48×96"), `${sizeBefore} | ${sizeAfter}`);
  const a1 = assetCount();
  await page.getByRole("button", { name: "Применить к заметке" }).click();
  await sleep(1500);
  const imgs2 = await page.evaluate(() => [...document.querySelectorAll(".bn-editor img")].map((n) => n.getAttribute("src")));
  check("the edited picture is stored as a new file and replaces the old one in the note", assetCount() === a1 + 1 && imgs2.length === 1 && imgs2[0] !== imgs[0], `assets +${assetCount() - a1}`);
  const shown = await page.evaluate(() => { const i = document.querySelector(".bn-editor img"); return i ? { w: i.naturalWidth, h: i.naturalHeight } : null; });
  check("the edited picture really is rotated (48×96)", shown && shown.w === 48 && shown.h === 96, JSON.stringify(shown));
} catch (e) {
  check("scenario completed without exceptions", false, String(e.message ?? e).split("\n").slice(0, 6).join(" | "));
} finally {
  try { await browser?.close(); } catch { /* */ }
  try { fakeOllama.close(); fakeCompat.close(); } catch { /* */ }
  if (child) { try { process.kill(child.pid); } catch { /* */ } }
  await sleep(1500);
  if (root.includes("nh4-e2e-")) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { console.log("temp profile left:", root); } }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
