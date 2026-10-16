export type ImportedWindowsTab = {
  sourceGuid: string;
  title: string;
  content: string;
  updated?: string;
  sourceUnavailable?: boolean;
  titleFromContent?: boolean;
};

export type WindowsNotepadImportResult = {
  tabs: ImportedWindowsTab[];
  skippedCount: number;
  externalSourceCount: number;
  warnings: string[];
};

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_TAB_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;
const MAX_TAB_FILES = 500;

type ZipEntry = { name: string; method: number; compressedSize: number; size: number; localOffset: number };

function assertRange(bytes: Uint8Array, offset: number, length: number) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error("ZIP-снимок повреждён или обрезан");
  }
}

function findEndRecord(view: DataView) {
  const minOffset = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50
      && offset + 22 + view.getUint16(offset + 20, true) === view.byteLength) return offset;
  }
  throw new Error("В файле не найден корректный каталог ZIP");
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(view);
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const diskEntries = view.getUint16(end + 8, true);
  const entryCount = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) throw new Error("Многотомные ZIP-снимки не поддерживаются");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64-снимки не поддерживаются");
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error(`В архиве слишком много записей (лимит ${MAX_ZIP_ENTRIES})`);
  assertRange(bytes, centralOffset, centralSize);

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(bytes, offset, 46);
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Каталог ZIP повреждён");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    assertRange(bytes, offset, recordLength);
    if (flags & 1) throw new Error("Зашифрованные ZIP-снимки не поддерживаются");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64-записи не поддерживаются");
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decoder.decode(nameBytes).replace(/\\/g, "/");
    entries.push({ name, method, compressedSize, size, localOffset });
    offset += recordLength;
  }
  return entries;
}

async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.size > MAX_ENTRY_BYTES) throw new Error(`Файл вкладки превышает лимит ${MAX_ENTRY_BYTES / 1024 / 1024} МиБ`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assertRange(bytes, entry.localOffset, 30);
  if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error("Заголовок файла в ZIP повреждён");
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  assertRange(bytes, dataOffset, entry.compressedSize);
  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.method === 0) {
    if (compressed.length !== entry.size) throw new Error("Размер ZIP-записи не совпадает");
    return compressed.slice();
  }
  if (entry.method !== 8 || typeof DecompressionStream === "undefined") {
    throw new Error("Метод сжатия ZIP не поддерживается этим браузером");
  }

  const compressedBuffer = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(compressedBuffer).set(compressed);
  const stream = new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > entry.size || total > MAX_ENTRY_BYTES) {
        await reader.cancel();
        throw new Error("Распакованный файл превышает объявленный размер или лимит безопасности");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== entry.size) throw new Error("Размер распакованной ZIP-записи не совпадает");
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
  return result;
}

function readTabFile(bytes: Uint8Array, entryName: string): ImportedWindowsTab {
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readUlebBig = () => {
    let value = 0n;
    let shift = 0n;
    while (true) {
      if (offset >= bytes.length || shift > 63n) throw new Error("Повреждённое ULEB128-поле");
      const byte = bytes[offset++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return value;
  };
  const readUleb = () => {
    const value = readUlebBig();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Число в записи слишком велико");
    return Number(value);
  };
  const need = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 0 || offset + count > bytes.length) throw new Error("Данные вкладки обрезаны");
  };
  const skip = (count: number) => { need(count); offset += count; };
  const readUtf16 = (charCount: number) => {
    const byteCount = charCount * 2;
    if (!Number.isSafeInteger(byteCount)) throw new Error("Текст вкладки слишком велик");
    need(byteCount);
    const result = new TextDecoder("utf-16le").decode(bytes.subarray(offset, offset + byteCount));
    offset += byteCount;
    return result;
  };

  need(2);
  if (bytes[offset++] !== 0x4e || bytes[offset++] !== 0x50) throw new Error("Неизвестный формат вкладки Windows Notepad");
  readUleb();
  const type = readUleb();
  let sourcePath = "";
  let timestamp: bigint | undefined;
  if (type === 0) {
    skip(1); readUleb(); readUleb(); skip(3);
    const options = readUleb(); skip(options);
  } else if (type === 1) {
    sourcePath = readUtf16(readUleb());
    readUleb(); skip(2);
    skip(1); skip(1);
    const fileTime = readUlebBig();
    if (fileTime > 0n) timestamp = fileTime;
    skip(34); readUleb(); readUleb(); skip(3);
    const options = readUleb(); skip(options);
  } else {
    throw new Error(`Тип вкладки ${type} не поддерживается`);
  }

  let content = readUtf16(readUleb());
  skip(5);
  while (offset < bytes.length) {
    const operationStart = offset;
    try {
      const cursor = readUleb();
      const deletion = readUleb();
      const addition = readUleb();
      const added = readUtf16(addition);
      skip(4);
      const position = Math.min(cursor, content.length);
      const deleteCount = Math.min(deletion, content.length - position);
      content = content.slice(0, position) + added + content.slice(position + deleteCount);
    } catch {
      offset = operationStart;
      break;
    }
  }

  const tail = entryName.split("/").pop() ?? "Заметка";
  const pathTitle = sourcePath.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "");
  const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  const title = (pathTitle || firstLine || tail.replace(/\.bin$/i, "Заметка")).slice(0, 180);
  let updated: string | undefined;
  if (timestamp !== undefined) {
    const date = new Date(Number(timestamp / 10000n) - 11644473600000);
    if (!Number.isNaN(date.getTime())) updated = date.toLocaleString("ru-RU");
  }
  const fileName = tail.replace(/\.bin$/i, "");
  const sourceGuid = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(fileName) ? fileName.replace(/-/g, "").toLowerCase() : fileName.toLowerCase();
  return {
    sourceGuid,
    title,
    content,
    updated,
    sourceUnavailable: Boolean(sourcePath && content.length === 0),
    titleFromContent: !pathTitle && Boolean(firstLine),
  };
}

export async function importWindowsNotepadZip(file: File): Promise<WindowsNotepadImportResult> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error(`ZIP-снимок превышает лимит ${MAX_ARCHIVE_BYTES / 1024 / 1024} МиБ`);
  const archive = new Uint8Array(await file.arrayBuffer());
  const entries = readZipEntries(archive);
  const tabs = entries.filter((entry) => /(?:^|\/)TabState\/[^/]+\.bin$/i.test(entry.name)
    && !/\.[01]\.bin$/i.test(entry.name));
  if (tabs.length === 0) throw new Error("В ZIP-снимке не найдена папка TabState с файлами вкладок");
  if (tabs.length > MAX_TAB_FILES) throw new Error(`В снимке слишком много вкладок (лимит ${MAX_TAB_FILES})`);
  const totalSize = tabs.reduce((sum, entry) => sum + entry.size, 0);
  if (totalSize > MAX_TOTAL_TAB_BYTES) throw new Error("Общий распакованный объём вкладок превышает 100 МиБ");

  const result: WindowsNotepadImportResult = { tabs: [], skippedCount: 0, externalSourceCount: 0, warnings: [] };
  for (const entry of tabs) {
    try {
      const tab = readTabFile(await readEntry(archive, entry), entry.name);
      if (tab.sourceUnavailable) result.externalSourceCount += 1;
      result.tabs.push(tab);
    } catch (error) {
      result.skippedCount += 1;
      result.warnings.push(error instanceof Error ? `${entry.name}: ${error.message}` : `${entry.name}: ошибка чтения`);
    }
  }
  if (result.tabs.length === 0 && result.warnings.length > 0) {
    throw new Error(`Не удалось прочитать вкладки. ${result.warnings[0]}`);
  }
  return result;
}