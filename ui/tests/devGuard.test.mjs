// Guard of the dev route /api/ai/*: who may call the dev server when it holds a real key.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/loadTs.mjs";

const { isLocalDevAiRequest } = await loadTs("../dev/aiDevGuard.ts");

test("a local page on the dev server itself passes (Origin + Host local)", () => {
  assert.equal(isLocalDevAiRequest({ origin: "http://localhost:5173", host: "localhost:5173" }), true);
  assert.equal(isLocalDevAiRequest({ origin: "http://127.0.0.1:5173", host: "127.0.0.1:5173" }), true);
  assert.equal(isLocalDevAiRequest({ origin: "http://[::1]:5173", host: "[::1]:5173" }), true);
});

test("a local tool on another port passes (Playwright/orca harness): the port of Origin is free", () => {
  assert.equal(isLocalDevAiRequest({ origin: "http://localhost:4173", host: "localhost:5173" }), true);
  assert.equal(isLocalDevAiRequest({ origin: "http://127.0.0.1:9222", host: "127.0.0.1:5173" }), true);
});

test("a foreign web page is refused even though the request reaches the local server", () => {
  assert.equal(isLocalDevAiRequest({ origin: "https://evil.example", host: "localhost:5173" }), false);
  assert.equal(isLocalDevAiRequest({ origin: "http://evil.example:5173", host: "localhost:5173" }), false);
  assert.equal(isLocalDevAiRequest({ origin: "null", host: "localhost:5173" }), false);   // sandboxed iframe
});

test("DNS rebinding is refused: no Origin, but Host names the attacker's domain", () => {
  assert.equal(isLocalDevAiRequest({ host: "evil.example:5173" }), false);
  assert.equal(isLocalDevAiRequest({ origin: "http://evil.example", host: "evil.example:5173" }), false);
});

test("a request without Host, or with a malformed Origin, is refused", () => {
  assert.equal(isLocalDevAiRequest({}), false);
  assert.equal(isLocalDevAiRequest({ origin: "not a url", host: "localhost:5173" }), false);
});

test("local tools without Origin still pass when Host is local (curl, scripts)", () => {
  assert.equal(isLocalDevAiRequest({ host: "localhost:5173" }), true);
  assert.equal(isLocalDevAiRequest({ host: "127.0.0.1:5173" }), true);
});
