import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/loadTs.mjs";
const { parseInline, parseMarkdown, stripMarkdown, toInlineContent, hasMarkdown } = await loadTs("../src/aiMarkdown.ts");

test("headings lose their # and keep their level", () => {
  const blocks = parseMarkdown("## Итоги\n\nТекст.\n\n#### Глубже");
  assert.deepEqual(blocks.map((b) => b.kind === "h" ? b.level : b.kind), [2, "p", 3]);
  assert.equal(stripMarkdown("## Итоги\nТекст"), "Итоги\nТекст");
});

test("inline marks become styles, not characters", () => {
  assert.deepEqual(parseInline("a **b** *c* `d` [e](https://x.test/y)"), [
    { text: "a " }, { text: "b", bold: true }, { text: " " }, { text: "c", italic: true }, { text: " " },
    { text: "d", code: true }, { text: " " }, { text: "e", href: "https://x.test/y" },
  ]);
});

test("snake_case and a lone star stay text", () => {
  assert.equal(stripMarkdown("my_var_name и 2 * 3 = 6"), "my_var_name и 2 * 3 = 6");
});

test("only http(s) and mailto links are kept", () => {
  assert.equal(stripMarkdown("[клик](javascript:alert(1))"), "[клик](javascript:alert(1))");
  assert.equal(toInlineContent("[ok](https://a.test)")[0].type, "link");
});

test("lists and code are recognised", () => {
  const blocks = parseMarkdown("- раз\n- два\n\n1. один\n2. два\n\n```\n# не заголовок\n```");
  assert.deepEqual(blocks.map((b) => b.kind), ["ul", "ol", "code"]);
  assert.equal(stripMarkdown("- раз\n- два"), "• раз\n• два");
});

test("inline content carries styles for Apply", () => {
  assert.deepEqual(toInlineContent("**жирный** текст"), [
    { type: "text", text: "жирный", styles: { bold: true } },
    { type: "text", text: " текст", styles: {} },
  ]);
});

test("hasMarkdown tells prose from markup", () => {
  assert.equal(hasMarkdown("## Заголовок"), true);
  assert.equal(hasMarkdown("Обычное предложение."), false);
});
