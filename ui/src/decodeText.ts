// Чтение перетаскиваемых и выбираемых в браузере текстовых файлов.
//
// file.text() умеет только UTF-8: кириллица в Windows-1251 (частый случай для .txt из Блокнота)
// превращалась в «кракозябры» — замечание QA «file.text() при drop читает только UTF-8».
// Здесь те же правила, что у хоста в NoteStore.DecodeText: BOM → UTF-16/UTF-8; валидный UTF-8 → UTF-8;
// иначе Windows-1251; двоичные файлы (NUL, много управляющих байтов) отвергаются до декодирования.

/** NUL или более 1 % управляющих байтов в первых 8 КБ — это не текст (зеркало NoteStore.LooksBinary). */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  if (n === 0) return false;
  let controls = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0) return true;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d) || c === 0x7f) controls++;
  }
  return controls * 100 > n;
}

/** Байты файла → текст: BOM, строгий UTF-8, запасной Windows-1251 (как у хоста). */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("windows-1251").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);   // декодер 1251 недоступен: замены вместо падения
    }
  }
}
