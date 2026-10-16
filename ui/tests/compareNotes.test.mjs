import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/loadTs.mjs";
const { compareNotes, paragraphCloseness } = await loadTs("../src/compareNotes.ts");

test("identical notes are all the same and 100 percent similar", () => {
  const r = compareNotes(["Раз.", "Два."], ["Раз.", "Два."]);
  assert.deepEqual(r.rows.map((x) => x.kind), ["same", "same"]);
  assert.equal(r.similarity, 1);
});

test("an added and a removed paragraph are one-sided rows in the right place", () => {
  const r = compareNotes(["Первый абзац про кошек.", "Третий абзац про собак."], ["Первый абзац про кошек.", "Новый абзац совсем о другом.", "Третий абзац про собак."]);
  assert.deepEqual(r.rows.map((x) => x.kind), ["same", "right-only", "same"]);
  assert.equal(r.rightOnly, 1);
  const r2 = compareNotes(["А.", "Лишний абзац слева.", "Б."], ["А.", "Б."]);
  assert.deepEqual(r2.rows.map((x) => x.kind), ["same", "left-only", "same"]);
});

test("an edited paragraph is a changed pair with word-level parts on each side", () => {
  const r = compareNotes(["Кошки спят до шестнадцати часов в сутки."], ["Кошки спят до двенадцати часов в сутки."]);
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.kind, "changed");
  assert.ok(row.leftParts.some((p) => p.kind === "del" && p.text.includes("шестнадцати")));
  assert.ok(row.rightParts.some((p) => p.kind === "ins" && p.text.includes("двенадцати")));
  assert.ok(!row.leftParts.some((p) => p.kind === "ins"));
});

test("unrelated paragraphs are not forced into a pair", () => {
  const r = compareNotes(["Про кошек и их привычки."], ["Совершенно иная тема: бюджет на следующий год."]);
  assert.deepEqual(r.rows.map((x) => x.kind).sort(), ["left-only", "right-only"]);
  assert.ok(paragraphCloseness("Про кошек и их привычки.", "Совершенно иная тема: бюджет на год.") < 0.4);
});

test("case and spacing do not make paragraphs different; empty notes compare equal", () => {
  assert.equal(compareNotes(["Один   Абзац"], ["один абзац"]).rows[0].kind, "same");
  assert.equal(compareNotes([], []).similarity, 1);
});

test("every paragraph of both notes appears exactly once in the rows", () => {
  const left = ["a1 текст", "b2 текст", "c3 текст", "d4 текст"], right = ["b2 текст", "x9 новое", "d4 текст", "e5 конец"];
  const r = compareNotes(left, right);
  const l = r.rows.flatMap((x) => (x.kind === "right-only" ? [] : [x.leftIndex]));
  const rr = r.rows.flatMap((x) => (x.kind === "left-only" ? [] : [x.rightIndex]));
  assert.deepEqual(l.sort(), [0, 1, 2, 3]);
  assert.deepEqual(rr.sort(), [0, 1, 2, 3]);
});
