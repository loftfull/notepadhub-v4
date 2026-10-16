import test from "node:test";
import assert from "node:assert/strict";
import { defaultParams, cropRect, outputSize, cssFilter, isUnchanged } from "../src/imageEdit.ts";

test("nothing changed means nothing to save", () => {
  assert.equal(isUnchanged(defaultParams()), true);
  assert.equal(isUnchanged({ ...defaultParams(), flipH: true }), false);
  assert.equal(isUnchanged({ ...defaultParams(), crop: { left: 1, top: 0, right: 0, bottom: 0 } }), false);
});

test("crop keeps at least a pixel and never more than 45 percent from a side", () => {
  assert.deepEqual(cropRect(1000, 500, { left: 10, top: 20, right: 10, bottom: 0 }), { x: 100, y: 100, w: 800, h: 400 });
  const extreme = cropRect(100, 100, { left: 99, top: 99, right: 99, bottom: 99 });
  assert.ok(extreme.w >= 10 && extreme.h >= 10);
  assert.deepEqual(cropRect(100, 100, { left: -5, top: NaN, right: 0, bottom: 0 }), { x: 0, y: 0, w: 100, h: 100 });
});

test("rotation by a quarter turn swaps width and height", () => {
  assert.deepEqual(outputSize(800, 400, { ...defaultParams(), rotate: 90 }), { w: 400, h: 800, scale: 1 });
  assert.deepEqual(outputSize(800, 400, { ...defaultParams(), rotate: 180 }), { w: 800, h: 400, scale: 1 });
});

test("the maximum width only shrinks, never enlarges", () => {
  assert.deepEqual(outputSize(1600, 800, { ...defaultParams(), maxWidth: 800 }), { w: 800, h: 400, scale: 0.5 });
  assert.equal(outputSize(600, 300, { ...defaultParams(), maxWidth: 800 }).scale, 1);
});

test("filters: sliders around 100 percent, none when untouched", () => {
  assert.equal(cssFilter(defaultParams()), "none");
  assert.equal(cssFilter({ ...defaultParams(), brightness: 20, contrast: -10, gray: true }), "brightness(120%) contrast(90%) grayscale(100%)");
  assert.equal(cssFilter({ ...defaultParams(), saturation: -100 }), "saturate(0%)");
});
