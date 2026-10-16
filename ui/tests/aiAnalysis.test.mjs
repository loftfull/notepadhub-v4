import assert from "node:assert/strict";
import test from "node:test";
import { parseAiAnalysis } from "../src/aiAnalysis.ts";

const source = { marker: "B2", blockId: "block-exact", label: "Подтвердить бюджет" };
const result = {
  summary: [{ text: "Обсуждается запуск.", citations: ["B2"] }],
  keyFacts: [],
  decisions: [],
  actionItems: [{ text: "Подтвердить бюджет", owner: "не указан", dueDate: "не указана", citations: ["B2"] }],
  risks: [],
  openQuestions: [{ text: "Кто отвечает?", citations: [] }],
};

test("parses structured analysis and keeps exact source mappings", () => {
  const parsed = parseAiAnalysis(JSON.stringify(result), [source]);
  assert.ok(parsed);
  assert.equal(parsed.summary[0].citations[0], source);
  assert.equal(parsed.actionItems[0].owner, "не указан");
  assert.equal(parsed.actionItems[0].dueDate, "не указана");
});

test("drops fabricated and unknown citation markers", () => {
  const text = JSON.stringify({ ...result, summary: [{ text: "Факт", citations: ["B2", "B999", "B0"] }] });
  const parsed = parseAiAnalysis(text, [source]);
  assert.deepEqual(parsed?.summary[0].citations, [source]);
});

test("accepts a fenced JSON response and falls back for prose or malformed structure", () => {
  assert.ok(parseAiAnalysis(`\`\`\`json\n${JSON.stringify(result)}\n\`\`\``, [source]));
  assert.equal(parseAiAnalysis("Обычный текстовый анализ [B2].", [source]), null);
  assert.equal(parseAiAnalysis(JSON.stringify({ ...result, actionItems: [{ text: "Сделать", citations: ["B2"] }] }), [source]), null);
});
