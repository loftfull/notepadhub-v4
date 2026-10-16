// Чтение файлов, перетаскиваемых в окно без хоста: те же правила, что у NoteStore.DecodeText.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/loadTs.mjs";

const { decodeTextBytes, looksBinary } = await loadTs("../src/decodeText.ts");

const u8 = (...bytes) => new Uint8Array(bytes);

test("plain UTF-8 is read as UTF-8", () => {
  assert.equal(decodeTextBytes(new TextEncoder().encode("Привет, мир")), "Привет, мир");
});

test("Windows-1251 (Notepad's legacy Cyrillic) is read instead of turning into mojibake", () => {
  // «Привет» в cp1251: CF F0 E8 E2 E5 F2 — невалидный UTF-8, должен декодироваться как 1251
  assert.equal(decodeTextBytes(u8(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2)), "Привет");
});

test("BOMs win: UTF-8 BOM is stripped, UTF-16LE and UTF-16BE are decoded", () => {
  assert.equal(decodeTextBytes(u8(0xef, 0xbb, 0xbf, 0x61, 0x62)), "ab");
  assert.equal(decodeTextBytes(u8(0xff, 0xfe, 0x61, 0x00, 0x62, 0x00)), "ab");   // UTF-16LE
  assert.equal(decodeTextBytes(u8(0xfe, 0xff, 0x00, 0x61, 0x00, 0x62)), "ab");   // UTF-16BE
});

test("binary files are detected before decoding (NUL or many control bytes)", () => {
  assert.equal(looksBinary(u8(0x61, 0x00, 0x62)), true);
  assert.equal(looksBinary(new TextEncoder().encode("обычный текст\nс переносами\tи табами")), false);
  const noisy = new Uint8Array(100).fill(0x01);
  assert.equal(looksBinary(noisy), true);
  assert.equal(looksBinary(new Uint8Array(0)), false);
});

test("invalid bytes with no cp1251 fallback never throw", () => {
  // одинокий байт 0xFF невалиден и в UTF-8; результат не обязан быть красивым, но обязан существовать
  assert.equal(typeof decodeTextBytes(u8(0xff, 0xfe, 0xfd)), "string");
});
