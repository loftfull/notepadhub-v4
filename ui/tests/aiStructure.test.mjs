import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/loadTs.mjs";
const { streamAiTask } = await loadTs("../src/ai.ts");

test("rejects whole-note structure outside note scope without starting inference", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch must not be called");
  };

  try {
    await assert.rejects(
      streamAiTask(
        {
          provider: "ollama",
          model: "local-model",
          operation: "structure",
          scope: "paragraph",
          contextText: "[B1] Проверить план",
          noteTitle: "План",
        },
        { onDelta: () => {} },
      ),
      /только для всей заметки/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
