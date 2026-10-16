import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/loadTs.mjs";
const { addPromptRecipe, deletePromptRecipe, MAX_PROMPT_RECIPES, parsePromptLibrary, serializePromptLibrary, updatePromptRecipe, } = await loadTs("../src/promptLibrary.ts");

const recipe = { id: "r1", name: "Сводка", instruction: "Сожми текст." };

test("loads valid library and rejects malformed or legacy values", () => {
  const serialized = serializePromptLibrary([recipe]);
  assert.equal(serialized.ok, true);
  assert.deepEqual(parsePromptLibrary(serialized.value).value, [recipe]);
  assert.equal(parsePromptLibrary("{\"schemaVersion\":0,\"recipes\":[] }").ok, false);
  assert.equal(parsePromptLibrary("not-json").ok, false);
  assert.equal(parsePromptLibrary(JSON.stringify([recipe])).ok, false);
});

test("adds, updates and deletes bounded recipes", () => {
  const added = addPromptRecipe([], recipe);
  assert.deepEqual(added.value, [recipe]);
  const updated = updatePromptRecipe([recipe], { ...recipe, name: "Обновлённая сводка" });
  assert.equal(updated.value[0].name, "Обновлённая сводка");
  assert.deepEqual(deletePromptRecipe(updated.value, recipe.id).value, []);
  assert.equal(addPromptRecipe(Array.from({ length: MAX_PROMPT_RECIPES }, (_, index) => ({ ...recipe, id: `r${index}` })), recipe).ok, false);
  assert.equal(addPromptRecipe([], { ...recipe, instruction: "" }).ok, false);
});

test("serializes only the bounded recipe schema", () => {
  const serialized = serializePromptLibrary([recipe]);
  assert.equal(serialized.ok, true);
  assert.deepEqual(JSON.parse(serialized.value), { schemaVersion: 1, recipes: [recipe] });
  assert.equal(serialized.value.includes("context"), false);
  assert.equal(serialized.value.includes("proposal"), false);
});
