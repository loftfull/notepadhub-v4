// Bundles src/calc.ts and checks the little calculator.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import os from "node:os";
import fs from "node:fs";

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nh4-calc-")), "calc.mjs");
await build({ entryPoints: [path.resolve("src/calc.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const { calculate, formatResult, trailingExpression } = await import(pathToFileURL(out).href);

test("arithmetic with priorities, brackets, power and percent", () => {
  assert.equal(calculate("2+2*3"), 8);
  assert.equal(calculate("(2+2)*3"), 12);
  assert.equal(calculate("2^3^2"), 512);
  assert.equal(calculate("50%"), null);          // a lone number is not an expression
  assert.equal(calculate("200*10%"), 20);
  assert.equal(calculate("-3+5"), 2);
  assert.equal(calculate("7/2"), 3.5);
});

test("Russian writing: comma, ×, ÷, minus sign", () => {
  assert.equal(calculate("12×3,5"), 42);
  assert.equal(calculate("10÷4"), 2.5);
  assert.equal(calculate("10−3"), 7);
});

test("not an expression, broken input and division by zero give null", () => {
  assert.equal(calculate("abc"), null);
  assert.equal(calculate("2+"), null);
  assert.equal(calculate("(2+3"), null);
  assert.equal(calculate("1/0"), null);
  assert.equal(calculate("alert(1)"), null);
  assert.equal(calculate("42"), null);
});

test("result format and the expression at the end of a line", () => {
  assert.equal(formatResult(0.1 + 0.2), "0,3");
  assert.equal(formatResult(42), "42");
  assert.equal(formatResult(1 / 3), "0,3333333333");
  assert.equal(trailingExpression("Итого: 12*3,5 ="), "12*3,5");
  assert.equal(trailingExpression("Купил 3 штуки по 15+5"), "15+5");
  assert.equal(trailingExpression("просто текст"), null);
});
