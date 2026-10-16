// Единая загрузка TypeScript-модулей для тестов.
//
// Почему не прямой `import ... from "../src/x.ts"`: Node.js 20 (минимальная версия из README)
// не умеет импортировать .ts — это появляется только в Node 22.6+ (под флагом) и 23.6+ (по умолчанию).
// Прямые импорты .ts ломали 11 тестовых файлов на заявленной минимальной версии Node.
// Здесь каждый модуль один раз транспилируется esbuild (та же схема, что уже работала в
// searchNotes.test.mjs и qa2/links.QA.test.mjs) и импортируется как обычный ESM.
//
// Использование:  const { fn } = await loadTs("../src/module.ts");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  throw new Error("esbuild не найден: выполните `npm install` в папке ui (esbuild объявлен в devDependencies).");
}

const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nh4-tests-"));
process.on("exit", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const cache = new Map();
let counter = 0;

/** Транспилирует TS-модуль (путь относительно папки tests/) и возвращает его namespace. Результат кэшируется. */
export async function loadTs(relativeEntry) {
  const entry = path.resolve(testsDir, relativeEntry);
  const cached = cache.get(entry);
  if (cached) return cached;
  const out = path.join(tmpDir, `mod-${counter++}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  const mod = await import(pathToFileURL(out).href);
  cache.set(entry, mod);
  return mod;
}
