/**
 * Global shortcuts, matched by the PHYSICAL key (event.code), so they work in any keyboard layout (Russian included)
 * and do not depend on Caps Lock or Shift. One list drives both the handler and the help dialog.
 */
export type ShortcutAction =
  | "save" | "search" | "find" | "replace" | "link" | "closeTab" | "ai" | "newNote"
  | "zoomIn" | "zoomOut" | "zoomReset" | "nextTab" | "prevTab" | "print" | "help";

type KeyLike = { code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

export function matchShortcut(event: KeyLike): ShortcutAction | null {
  if (event.altKey) return null;
  const mod = event.ctrlKey || event.metaKey;
  if (event.code === "F1" && !mod) return "help";
  if (!mod) return null;
  if (event.shiftKey) {
    if (event.code === "Equal") return "zoomIn";          // Ctrl + "+" is Shift+= on most layouts
    if (event.code === "Tab") return "prevTab";
    if (event.code === "Slash") return "help";          // Ctrl+? on most layouts
    return null;
  }
  switch (event.code) {
    case "KeyS": return "save";
    case "KeyK": return "search";
    case "KeyF": return "find";
    case "KeyH": return "replace";
    case "KeyL": return "link";
    case "KeyW": return "closeTab";
    case "KeyJ": return "ai";
    case "KeyN": return "newNote";
    case "Tab": return "nextTab";
    case "Slash": return "help";
    case "Equal": case "NumpadAdd": return "zoomIn";
    case "Minus": case "NumpadSubtract": return "zoomOut";
    case "Digit0": case "Numpad0": return "zoomReset";
    case "KeyP": return "print";
    default: return null;
  }
}

export const SHORTCUT_HELP: Array<{ group: string; items: Array<{ keys: string; label: string }> }> = [
  { group: "Заметки", items: [
    { keys: "Ctrl N", label: "Новая заметка" },
    { keys: "Ctrl W", label: "Закрыть вкладку (изменения сохраняются)" },
    { keys: "Ctrl Tab / Ctrl Shift Tab", label: "Следующая / предыдущая вкладка" },
    { keys: "Ctrl S", label: "Сохранить сейчас" },
    { keys: "Ctrl Z", label: "Отменить последнее действие" },
    { keys: "Ctrl Y", label: "Повторить отменённое" },
    { keys: "Ctrl L", label: "Вставить ссылку [[на заметку]]" },
  ] },
  { group: "Поиск", items: [
    { keys: "Ctrl K", label: "Поиск по заметкам и команды (введите >)" },
    { keys: "Ctrl F", label: "Найти в заметке" },
    { keys: "Ctrl H", label: "Найти и заменить" },
  ] },
  { group: "Вид и помощники", items: [
    { keys: "Ctrl + / Ctrl − / Ctrl 0", label: "Масштаб текста" },
    { keys: "Ctrl P", label: "Печать заметки" },
    { keys: "Ctrl J", label: "AI-помощник" },
    { keys: "F1 или Ctrl /", label: "Это окно" },
  ] },
  { group: "В тексте", items: [
    { keys: "/", label: "Меню блоков: заголовки, списки, цитата" },
    { keys: "Ctrl клик по [[ссылке]]", label: "Открыть связанную заметку" },
  ] },
];
