import test from "node:test";
import assert from "node:assert/strict";
import { blocksToText, textToBlocks } from "../src/textFormat.ts";

// Property: text -> blocks -> text returns every line unchanged (apart from the BlockNote phantom trailing paragraph).
const samples = {
  plain: "первая строка\nвторая строка\n\nчетвёртая после пустой",
  env: "# комментарий\nAPI_URL=https://example.test/v1\nTOKEN=<redacted>\n#не заголовок без пробела",
  shell: "$ cd /tmp\n- not a list in prose? yes it is\n* star line\n1) paren list\n  indented plain",
  numbered: "1. один\n2. два\n3. три\n\n5. пропуск\n1. сначала",
  checklist: "- [ ] купить\n- [x] сделано\n- [X] тоже сделано",
  nested: "- родитель\n  - ребёнок\n    - внук\n- второй",
  code: "до\n```js\nconst a = 1;\n# not heading here\n```\nпосле",
  unclosedFence: "```python\nprint('нет закрытия')",
  quote: "> цитата\n>без пробела остаётся абзацем",
  headings: "# H1\n## H2\n### H3\n#### четыре решётки — абзац",
  oddIndent: " один пробел\n   три пробела\n\tтаб",
  unicode: "Ёжик 🦔 — «кавычки» ‘’ … ✓",
};

for (const [name, text] of Object.entries(samples)) {
  test(`round trip keeps text: ${name}`, () => {
    const blocks = textToBlocks(text);
    const back = blocksToText(blocks);
    // trailing newline handling: the phantom last empty paragraph is dropped on save
    assert.equal(back, text.replace(/\n$/, ""), `lost or changed text in "${name}"`);
  });
}

test("CRLF input is normalised to LF", () => {
  assert.equal(blocksToText(textToBlocks("a\r\nb\r\nc")), "a\nb\nc");
});

test("empty text gives one empty paragraph", () => {
  const b = textToBlocks("");
  assert.equal(b.length, 1);
  assert.equal(b[0].type, "paragraph");
  assert.equal(blocksToText(b), "");
});

test("structure is recognised only for unambiguous prefixes", () => {
  const b = textToBlocks("# Заголовок\n- пункт\n- [x] готово\n1. раз\n2. два\n> цитата");
  assert.deepEqual(b.map((x) => x.type), ["heading", "bulletListItem", "checkListItem", "numberedListItem", "numberedListItem", "quote"]);
  assert.equal(b[2].props.checked, true);
});

test("nested bullets become children", () => {
  const b = textToBlocks("- a\n  - b\n    - c");
  assert.equal(b.length, 1);
  assert.equal(b[0].children[0].children[0].content, "c");
});

test("rich inline content collapses to its plain text", () => {
  const blocks = [{
    type: "paragraph",
    content: [{ type: "text", text: "жирный ", styles: { bold: true } }, { type: "link", href: "https://example.test", content: [{ type: "text", text: "ссылка", styles: {} }] }],
    children: [],
  }, { type: "paragraph", content: [], children: [] }];
  assert.equal(blocksToText(blocks), "жирный ссылка");
});

test("code block keeps its language and lines", () => {
  const text = blocksToText([{ type: "codeBlock", props: { language: "ts" }, content: "a\nb" }]);
  assert.equal(text, "```ts\na\nb\n```");
});

test("table is serialised as pipe rows", () => {
  const text = blocksToText([{ type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "a", styles: {} }], [{ type: "text", text: "b", styles: {} }]] }] } }]);
  assert.equal(text, "| a | b |");
});

// ---- tables and images
const richSamples = {
  table: "до\n| a | b |\n| c | d |\nпосле",
  tableHeader: "| Имя | Возраст |\n| --- | --- |\n| Аня | 30 |\n| Борис | 41 |",
  tableEscapes: "| a \| b | c |\n| d | e |",
  tableCompactStaysText: "|a|b|\n|c|d|",
  tableMarkdownSeparatorStaysText: "| a | b |\n|---|---|\n| c | d |",
  tableUnevenStaysText: "| a | b |\n| c |",
  image: "до\n![подпись](https://example.test/a.png)\nпосле",
  imageNoAlt: "![](https://example.test/b.jpg)",
  imageAssets: "![схема](https://assets.notepadhub.local/0123abcd.png)",
};
for (const [name, text] of Object.entries(richSamples)) {
  test(`round trip keeps text: ${name}`, () => {
    assert.equal(blocksToText(textToBlocks(text)), text);
  });
}

test("a canonical pipe run becomes a table block with a header when a separator follows the first row", () => {
  const blocks = textToBlocks(richSamples.tableHeader);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "table");
  assert.equal(blocks[0].content.headerRows, 1);
  assert.equal(blocks[0].content.rows.length, 3);
  assert.equal(blocks[0].content.rows[2].cells[0][0].text, "Борис");
});

test("compact or irregular pipe lines are NOT reinterpreted (they stay words)", () => {
  for (const key of ["tableCompactStaysText", "tableMarkdownSeparatorStaysText", "tableUnevenStaysText"])
    assert.ok(textToBlocks(richSamples[key]).every((b) => b.type === "paragraph"), key);
});

test("an image line becomes an image block that keeps its address and caption", () => {
  const [block] = textToBlocks("![схема](https://assets.notepadhub.local/0123abcd.png)");
  assert.equal(block.type, "image");
  assert.equal(block.props.url, "https://assets.notepadhub.local/0123abcd.png");
  assert.equal(block.props.caption, "схема");
});

test("an image block without an address keeps the old placeholder instead of an empty link", () => {
  assert.equal(blocksToText([{ type: "image", props: { name: "x.png" } }]), "[image: x.png]");
});
