import test from "node:test";
import assert from "node:assert/strict";
import { autoFormat, splitParagraph, fixTypography, boldLeadTerm, describeReport, wordSimilarity, isFormattingOnly } from "../src/autoFormat.ts";

const p = (text) => ({ type: "paragraph", props: {}, content: text });
const h = (text, level = 1) => ({ type: "heading", props: { level }, content: text });
const li = (text) => ({ type: "bulletListItem", props: {}, content: text });
const long = "Первое предложение про кошек и их повадки. Второе предложение про сон и еду. Третье предложение о том, как они охотятся. Четвёртое предложение о звуках, которые они издают. Пятое предложение про зрение в темноте. Шестое предложение про социальные связи между животными. Седьмое предложение завершает мысль о привычках.";

test("a short line with a colon over a real paragraph becomes a heading, the colon goes away", () => {
  const { blocks, report } = autoFormat([h("Кошки"), p("Привычки:"), p(long)]);
  assert.equal(blocks[1].type, "heading");
  assert.equal(blocks[1].content, "Привычки");
  assert.equal(blocks[1].props.level, 2);
  assert.equal(report.headings, 1);
});

test("a plain short line without a colon is NOT made a heading (that was the source of nonsense)", () => {
  const { blocks } = autoFormat([p("Иван Петров"), p(long)]);
  assert.equal(blocks[0].type, "paragraph");
});

test("a normal sentence is never a heading", () => {
  const { blocks } = autoFormat([p("Это обычное предложение, которое заканчивается точкой."), p(long)]);
  assert.equal(blocks[0].type, "paragraph");
});

test("long paragraphs are split at sentence ends, about three sentences each, no text is lost", () => {
  const text = [long, long, long, long].join(" ");
  const parts = splitParagraph(text);
  assert.ok(parts.length >= 3);
  assert.equal(parts.join(" "), text);
  assert.ok(parts.every((x) => x.length > 100 && x.length < 650));
  assert.deepEqual(splitParagraph(long), [long]);
});

test("initials and abbreviations do not end a sentence", () => {
  const text = ("В словаре В. И. Даля сказано иначе, чем у других авторов, и т. д. приведены примеры. " + long).trim();
  const parts = splitParagraph(text);
  assert.ok(parts.every((x) => !/В\.$/.test(x) && !/\bт\.$/.test(x)));
});

test("a clear hard-wrapped run is glued, a single break and sentences are not", () => {
  const run = [p("Эта строка оборвана на середине предложения, которое тянется и"), p("продолжается на следующей строке, где оно ещё не заканчивается и"), p("наконец завершается на третьей строке этого абзаца.")];
  const { blocks, report } = autoFormat(run);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, "Эта строка оборвана на середине предложения, которое тянется и продолжается на следующей строке, где оно ещё не заканчивается и наконец завершается на третьей строке этого абзаца.");
  assert.equal(report.paragraphsMerged, 2);
  assert.equal(autoFormat([p("Эта строка оборвана на середине предложения и"), p("продолжается на следующей строке до точки.")]).blocks.length, 2);
  const kept = autoFormat([p("Эта строка закончена точкой и всё понятно."), p("новая строка с маленькой буквы тоже остаётся")]);
  assert.equal(kept.blocks.length, 2);
});

test("empty paragraphs are removed and the blocks keep their order", () => {
  const { blocks, report } = autoFormat([h("Тема"), p(""), p("   "), p("Текст.")]);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph"]);
  assert.equal(report.removedEmpty, 2);
});

test("typography: dashes, ellipsis, spaces, straight quotes become guillemets in Russian", () => {
  assert.deepEqual(fixTypography('Он сказал - "хорошо"...  Да ,  верно', true).text, "Он сказал — «хорошо»… Да, верно");
  assert.equal(fixTypography('Страницы 5 - 10 и "одна кавычка', true).text, 'Страницы 5 - 10 и "одна кавычка');   // a range is not a dash, an odd quote is left alone
  assert.equal(fixTypography('He said "ok" - fine', false).text, 'He said "ok" — fine');
});

test("terms are bolded only in a uniform list, never in a lone item", () => {
  const lone = autoFormat([li("Сон — кошки спят до шестнадцати часов в сутки"), li("просто пункт без термина в начале списка")]).blocks;
  assert.equal(typeof lone[0].content, "string");
  const uniform = autoFormat([li("Сон — кошки спят до шестнадцати часов в сутки"), li("Охота — кошки охотятся ночью и на рассвете")]).blocks;
  assert.equal(uniform[0].content[0].styles.bold, true);
});

test("a lead term in a list item becomes bold", () => {
  const r = boldLeadTerm("Кошка — домашнее животное из семейства кошачьих");
  assert.equal(r.content[0].text, "Кошка");
  assert.equal(r.content[0].styles.bold, true);
  assert.equal(boldLeadTerm("Просто предложение без термина в начале списка"), null);
  assert.equal(boldLeadTerm("12 — число, а не термин, поэтому без выделения"), null);
});

test("only one level-1 title is kept", () => {
  const { blocks } = autoFormat([h("Заголовок"), p(long), h("Ещё один")]);
  assert.equal(blocks[2].props.level, 2);
});

test("tables, pictures and styled text are left alone", () => {
  const table = { type: "table", content: { rows: [] } };
  const image = { type: "image", props: { url: "https://x/y.png" } };
  const styled = { type: "paragraph", props: {}, content: [{ type: "text", text: "Короткая жирная строка", styles: { bold: true } }] };
  const { blocks } = autoFormat([table, image, styled, p(long)]);
  assert.equal(blocks[0], table === blocks[0] ? table : blocks[0]);
  assert.equal(blocks[1].type, "image");
  assert.equal(blocks[2].type, "paragraph");
});

test("the second run changes nothing (idempotent) and says so", () => {
  const once = autoFormat([h("Кошки"), p("Привычки:"), p(long), li("Сон — кошки спят до шестнадцати часов в сутки"), li("Охота — кошки охотятся ночью и на рассвете")]);
  const twice = autoFormat(once.blocks);
  assert.deepEqual(twice.blocks, once.blocks);
  assert.match(describeReport(twice.report), /менять нечего|правок знаков/);
});

test("a model that only formats is accepted, one that rewrites, shortens or invents is not", () => {
  const src = "Кошки спят до 16 часов в сутки. Охота идёт ночью. Зрение в темноте лучше человеческого.";
  const formatted = "## Кошки"+String.fromCharCode(10,10)+"Кошки спят до **16 часов** в сутки."+String.fromCharCode(10,10)+"- Охота идёт ночью."+String.fromCharCode(10)+"- Зрение в темноте лучше человеческого.";
  assert.equal(isFormattingOnly(src, formatted).ok, true);
  assert.equal(isFormattingOnly(src, "Кошки много спят и охотятся.").ok, false);
  assert.equal(isFormattingOnly(src, src + " Кроме того, кошки любят молоко и рыбу, а ещё мышей и птиц, которых ловят.").ok, false);
  assert.equal(isFormattingOnly(src, src.replace("16", "12")).ok, false);
  assert.ok(wordSimilarity(src, src) === 1);
});

test("a pasted block with blank lines inside gives no empty lines", () => {
  const { blocks, report } = autoFormat([p("Первая строка текста.\n\n\nВторая строка текста."), { type: "bulletListItem", content: "" }, { type: "heading", props: { level: 2 }, content: "   " }, p(" ")]);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => String(b.content).trim() !== ""));
  assert.equal(report.removedEmpty, 3);
});

test("hard-wrapped lines of one pasted block are glued, even a single break", () => {
  const { blocks } = autoFormat([p("Кошки спят до шестнадцати часов в сутки и просыпаются\nв основном для охоты на рассвете и в сумерках.")]);
  assert.equal(blocks.length, 1);
  assert.match(String(blocks[0].content), /просыпаются в основном/);
});

test("a letter keeps greeting, body and signature apart", () => {
  const body = "Пишу вам по поводу договора от десятого марта: мы просим продлить срок поставки на две недели и согласовать новый график.";
  const { blocks, report } = autoFormat([p("Уважаемый Иван Петрович,"), p(body), p("С уважением"), p("Анна Смирнова"), p("менеджер")]);
  assert.equal(blocks.length, 5);
  assert.equal(blocks[0].type, "paragraph");
  assert.equal(String(blocks[2].content), "С уважением,");
  assert.equal(blocks[3].type, "paragraph");
  assert.ok(report.letterParts >= 3);
});

test("a greeting that ends with a colon is not turned into a heading", () => {
  const { blocks } = autoFormat([p("Уважаемые коллеги:"), p("Сообщаю вам, что собрание переносится на следующую пятницу по причине отпуска руководителя и занятости зала.")]);
  assert.equal(blocks[0].type, "paragraph");
});

test("typed list marks become real lists", () => {
  const { blocks, report } = autoFormat([p("- яблоки"), p("- груши"), p("1) один"), p("2) два")]);
  assert.deepEqual(blocks.map((b) => b.type), ["bulletListItem", "bulletListItem", "numberedListItem", "numberedListItem"]);
  assert.equal(report.listsMade, 4);
  assert.equal(autoFormat([p("- одна строка")]).blocks[0].type, "paragraph");
});

test("pictures are centred and not wider than the column; text around stays", () => {
  const img = { type: "image", props: { url: "x.png", previewWidth: 1400 } };
  const { blocks, report } = autoFormat([p("До"), img, p("После")]);
  assert.equal(blocks[1].props.textAlignment, "center");
  assert.equal(blocks[1].props.previewWidth, 720);
  assert.equal(report.images, 1);
  assert.equal(blocks.length, 3);
});

test("the second run changes nothing", () => {
  const first = autoFormat([p("Здравствуйте, Иван!"), p("Вот текст - с тире, и ещё \"кавычки\" внутри."), p("Спасибо"), p("Анна")]);
  const second = autoFormat(first.blocks);
  assert.equal(Object.entries(second.report).reduce((a, [k, v]) => a + (k === "letterParts" ? 0 : v), 0), 0);
});

test("a long line broken before a lowercase word is glued even when it is the only break", () => {
  const { blocks, report } = autoFormat([p("Мы обсудили сроки поставки оборудования и стоимость монтажа, которые остаются"), p("прежними до конца квартала."), p("Следующий абзац начинается с заглавной.")]);
  assert.equal(blocks.length, 2);
  assert.equal(report.paragraphsMerged, 1);
  assert.equal(autoFormat([p("Короткая строка"), p("с продолжением")]).blocks.length, 2);
});

test("justified text is aligned to the left", () => {
  const { blocks } = autoFormat([{ type: "paragraph", props: { textAlignment: "justify" }, content: "Обычный текст." }]);
  assert.equal(blocks[0].props.textAlignment, "left");
});

test("typed Markdown headings become real headings without the marks", () => {
  const { blocks } = autoFormat([p("## Итоги встречи"), p("Обсудили бюджет и сроки поставки оборудования на следующий квартал.")]);
  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[0].content, "Итоги встречи");
  assert.equal(blocks[0].props.level, 2);
});

test("a note of commands, paths and settings is left alone except empty lines", () => {
  const lines = ["cd C:\Projects\app", "npm run build", "", "API_KEY=abc123", "git commit -m \"fix - one\"", "ls -la", "- не список"];
  const { blocks, report } = autoFormat(lines.map(p));
  assert.equal(report.technical, 1);
  assert.equal(blocks.length, 6);
  assert.equal(blocks[3].content, "git commit -m \"fix - one\"");
  assert.equal(blocks[5].type, "paragraph");
});
