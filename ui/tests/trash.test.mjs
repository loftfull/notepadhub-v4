// The trash keeps a note for 30 days; the rule is a pure function so the border can be tested.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/loadTs.mjs";
const { expiredIds, daysLeft, TRASH_DAYS } = await loadTs("../src/components/TrashView.tsx");

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-17T12:00:00Z");
const at = (days) => new Date(now - days * DAY).toISOString();

test("a note older than 30 days is expired, a note of exactly 30 days or younger is kept", () => {
  const items = [{ id: "old", deletedAt: at(31) }, { id: "border", deletedAt: at(30) }, { id: "young", deletedAt: at(2) }];
  assert.deepEqual(expiredIds(items, now), ["old"]);
});

test("a broken date never expires a note", () => {
  assert.deepEqual(expiredIds([{ id: "x", deletedAt: "not a date" }], now), []);
});

test("days left counts down and stops at zero", () => {
  assert.equal(TRASH_DAYS, 30);
  assert.equal(daysLeft(at(0), now), 30);
  assert.equal(daysLeft(at(29), now), 1);
  assert.equal(daysLeft(at(45), now), 0);
});
