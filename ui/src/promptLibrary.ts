export const PROMPT_LIBRARY_STORAGE_KEY = "notepad-ai-prompt-library-v1";
export const PROMPT_LIBRARY_SCHEMA_VERSION = 1;
export const MAX_PROMPT_RECIPES = 20;
export const MAX_PROMPT_NAME_LENGTH = 80;
export const MAX_PROMPT_INSTRUCTION_LENGTH = 1000;

export type PromptRecipe = {
  id: string;
  name: string;
  instruction: string;
};

type StoredPromptLibrary = {
  schemaVersion: typeof PROMPT_LIBRARY_SCHEMA_VERSION;
  recipes: PromptRecipe[];
};

export type PromptLibraryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const invalidPayload = "Библиотека рецептов повреждена или имеет устаревший формат.";

function validRecipe(value: unknown): value is PromptRecipe {
  if (!value || typeof value !== "object") return false;
  const recipe = value as Partial<PromptRecipe>;
  const keys = Object.keys(value).sort();
  return keys.length === 3 && keys.join(",") === "id,instruction,name"
    && typeof recipe.id === "string"
    && recipe.id.trim().length > 0
    && recipe.id.length <= 100
    && typeof recipe.name === "string"
    && recipe.name.trim().length > 0
    && recipe.name.length <= MAX_PROMPT_NAME_LENGTH
    && typeof recipe.instruction === "string"
    && recipe.instruction.trim().length > 0
    && recipe.instruction.length <= MAX_PROMPT_INSTRUCTION_LENGTH;
}

function validRecipes(recipes: unknown): recipes is PromptRecipe[] {
  if (!Array.isArray(recipes) || recipes.length > MAX_PROMPT_RECIPES || !recipes.every(validRecipe)) return false;
  return new Set(recipes.map((recipe) => recipe.id)).size === recipes.length;
}

export function parsePromptLibrary(raw: string | null): PromptLibraryResult<PromptRecipe[]> {
  if (raw === null) return { ok: true, value: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ok: false, error: invalidPayload };
    const payload = parsed as Partial<StoredPromptLibrary>;
    if (payload.schemaVersion !== PROMPT_LIBRARY_SCHEMA_VERSION || !validRecipes(payload.recipes)) {
      return { ok: false, error: invalidPayload };
    }
    return { ok: true, value: payload.recipes };
  } catch {
    return { ok: false, error: invalidPayload };
  }
}

export function serializePromptLibrary(recipes: PromptRecipe[]): PromptLibraryResult<string> {
  if (!validRecipes(recipes)) return { ok: false, error: "Рецепт не прошёл проверку ограничений библиотеки." };
  return {
    ok: true,
    value: JSON.stringify({ schemaVersion: PROMPT_LIBRARY_SCHEMA_VERSION, recipes } satisfies StoredPromptLibrary),
  };
}

export function loadPromptLibrary(storage: Pick<Storage, "getItem">): PromptLibraryResult<PromptRecipe[]> {
  try {
    return parsePromptLibrary(storage.getItem(PROMPT_LIBRARY_STORAGE_KEY));
  } catch {
    return { ok: false, error: "Не удалось прочитать локальную библиотеку рецептов." };
  }
}

export function savePromptLibrary(storage: Pick<Storage, "setItem">, recipes: PromptRecipe[]): PromptLibraryResult<null> {
  const serialized = serializePromptLibrary(recipes);
  if (!serialized.ok) return serialized;
  try {
    storage.setItem(PROMPT_LIBRARY_STORAGE_KEY, serialized.value);
    return { ok: true, value: null };
  } catch {
    return { ok: false, error: "Не удалось сохранить библиотеку рецептов на этом устройстве." };
  }
}

export function addPromptRecipe(recipes: PromptRecipe[], recipe: PromptRecipe): PromptLibraryResult<PromptRecipe[]> {
  if (recipes.length >= MAX_PROMPT_RECIPES) return { ok: false, error: `Можно сохранить не более ${MAX_PROMPT_RECIPES} пользовательских рецептов.` };
  const next = [...recipes, recipe];
  return validRecipes(next) ? { ok: true, value: next } : { ok: false, error: "Название и инструкция рецепта не должны быть пустыми или слишком длинными." };
}

export function updatePromptRecipe(recipes: PromptRecipe[], recipe: PromptRecipe): PromptLibraryResult<PromptRecipe[]> {
  const index = recipes.findIndex((item) => item.id === recipe.id);
  if (index < 0) return { ok: false, error: "Рецепт не найден." };
  const next = recipes.slice();
  next[index] = recipe;
  return validRecipes(next) ? { ok: true, value: next } : { ok: false, error: "Название и инструкция рецепта не должны быть пустыми или слишком длинными." };
}

export function deletePromptRecipe(recipes: PromptRecipe[], id: string): PromptLibraryResult<PromptRecipe[]> {
  if (!recipes.some((recipe) => recipe.id === id)) return { ok: false, error: "Рецепт не найден." };
  return { ok: true, value: recipes.filter((recipe) => recipe.id !== id) };
}
