import type { PartialBlock } from "@blocknote/core";

// Стартовые и служебные наборы блоков редактора. Раньше эти строки были рассыпаны по App.tsx
// в пяти местах; здесь они живут одним источником. Каждая функция возвращает НОВЫЙ массив:
// блоки редактора не должны разделять изменяемое состояние между заметками.

/** Каркас новой заметки: заголовок и пустой абзац. */
export function newNoteContent(title: string): PartialBlock[] {
  return [
    { type: "heading", props: { level: 1 }, content: title },
    { type: "paragraph", content: "" },
  ];
}

/**
 * Показывается, пока текст заметки грузится из хоста (ленивый бутстрап).
 * Этот набор никогда не сохраняется: handleEditorChange и saveDocument пропускают
 * заметки, которые ещё не загружены (см. NoteHydrator.isPending).
 */
export function loadingNoteBlocks(): PartialBlock[] {
  return [{ type: "paragraph", content: "Загрузка заметки…" }];
}

/** Пустая библиотека. */
export function emptyLibraryBlocks(): PartialBlock[] {
  return [{ type: "paragraph", content: "Создайте заметку кнопкой «Новая заметка»." }];
}

/** Все вкладки закрыты. */
export function noOpenNotesBlocks(): PartialBlock[] {
  return [{ type: "paragraph", content: "Нет открытых заметок. Откройте заметку из списка или создайте новую кнопкой «+»." }];
}

/** Пустой редактор: правая колонка двухколоночного вида до выбора заметки, очистка активной колонки. */
export function blankEditorBlocks(): PartialBlock[] {
  return [{ type: "paragraph", content: "" }];
}

/** Демонстрационная заметка (браузерный режим без хоста). */
export function sampleContent(title: string): PartialBlock[] {
  return [
    { type: "heading", props: { level: 1 }, content: title },
    { type: "paragraph", content: "Это демонстрационная заметка. Изменения сохраняются локально в прототипе и не затрагивают файлы Notepad Hub." },
  ];
}
