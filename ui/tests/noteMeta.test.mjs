import test from "node:test";
import assert from "node:assert/strict";
import { suggestTitle, suggestTags, parseMetaAnswer, META_INSTRUCTION } from "../src/noteMeta.ts";

test("the title is the first heading, else the start of the first sentence, without the final full stop", () => {
  assert.equal(suggestTitle([{ heading: true, text: "Итоги встречи" }, { text: "Обсудили бюджет." }]), "Итоги встречи");
  assert.equal(suggestTitle([{ text: "Кошка — домашнее животное. Вторая фраза." }]), "Кошка — домашнее животное");
  assert.equal(suggestTitle([{ text: "   " }]), "");
});

test("a long first sentence is cut at a word to 60 characters with an ellipsis", () => {
  const t = suggestTitle([{ text: "Очень длинное первое предложение без единой запятой которое тянется и тянется дальше и дальше пока не закончится наконец." }]);
  assert.ok(t.length <= 61 && t.endsWith("…"), t);
  assert.ok(!t.slice(0, -1).endsWith(" "));
});

test("tags are the frequent characteristic words, one form per stem, no stop words", () => {
  const text = "Кошка спит долго. Кошки охотятся ночью, кошка видит в темноте. Охота для кошки естественна, охотничьи привычки сохраняются. Домашние животные, домашняя кошка.";
  const tags = suggestTags(text, 4);
  assert.ok(tags.length >= 1 && tags.length <= 4);
  assert.ok(tags.some((t) => t.startsWith("кошк")), JSON.stringify(tags));
  assert.ok(tags.every((t) => t.length >= 5 && !["который", "является"].includes(t)));
  assert.equal(new Set(tags).size, tags.length);
});

test("a text with no repeated words gets no tags instead of random ones", () => {
  assert.deepEqual(suggestTags("Одна короткая фраза без повторов вообще"), []);
});

test("the model's JSON is read, cleaned and validated", () => {
  assert.deepEqual(parseMetaAnswer('```json\n{"title":"«Сон и охота кошек».","tags":["#Кошки"," Сон ","кошки","","a"]}\n```'), { title: "Сон и охота кошек", tags: ["кошки", "сон"] });
  assert.equal(parseMetaAnswer("нет json"), null);
  assert.equal(parseMetaAnswer('{"title":"ab","tags":[]}'), null);
  assert.equal(parseMetaAnswer('{"title": 5}'), null);
});

test("the instruction asks for JSON and fits the 1000-character limit", () => {
  assert.ok(META_INSTRUCTION.includes('"title"') && META_INSTRUCTION.length < 1000);
});
