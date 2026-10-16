import test from "node:test";
import assert from "node:assert/strict";
import { embeddedBase64, isWebAddress, MAX_PASTED_PICTURES } from "../src/pasteImages.ts";

test("only png, jpeg, gif and webp data addresses are accepted (no svg)", () => {
  assert.equal(embeddedBase64("data:image/png;base64,AAAA"), "AAAA");
  assert.equal(embeddedBase64("data:image/jpeg;base64,AA AA"), "AAAA");
  assert.equal(embeddedBase64("data:image/svg+xml;base64,AAAA"), null);
  assert.equal(embeddedBase64("data:text/html;base64,AAAA"), null);
  assert.equal(embeddedBase64("https://x.test/a.png"), null);
});

test("only http and https addresses are downloaded", () => {
  assert.equal(isWebAddress("https://example.com/a.png"), true);
  assert.equal(isWebAddress("http://example.com/a.png"), true);
  for (const bad of ["file:///C:/a.png", "javascript:alert(1)", "blob:https://x/1", "//example.com/a.png", "ftp://x/a.png", "a.png"]) assert.equal(isWebAddress(bad), false, bad);
});

test("the number of pictures per paste is capped", () => assert.equal(MAX_PASTED_PICTURES, 20));
