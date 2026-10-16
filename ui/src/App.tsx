import { toInlineContent } from "./aiMarkdown";
import { localizePictures } from "./pasteImages";
import { autoFormat, describeReport, isFormattingOnly, type AfBlock } from "./autoFormat";
import { CompareDialog, SplitBar } from "./components/SplitView";
import { ImageEditDialog, ImageGenerateDialog, type NoteImage } from "./components/ImageTools";
import { META_INSTRUCTION, parseMetaAnswer, suggestTags, suggestTitle } from "./noteMeta";
import { INSIGHTS_HEADING, MAX_INSTRUCTION, TRANSFORMATIONS, insightMarkdown, loadCustom, saveCustom, type Transformation } from "./transformations";
import { TransformationsDialog } from "./components/TransformationsDialog";
import { TrashView } from "./components/TrashView";
import { parseAiAnalysis } from "./aiAnalysis";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { ru } from "@blocknote/core/locales";
import type { PartialBlock } from "@blocknote/core";
import {
  AlignLeft, Archive, CalendarDays, ChevronsUpDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpDown, ExternalLink, Link2, Replace, ChevronLeft, ChevronRight, CircleAlert, Minus, Settings, Star, Check, ChevronDown, Clock3, Command, Copy, Download, FileText,
  Folder, FolderInput, FolderOpen, Hash, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Columns2, ImagePlus, LoaderCircle, Redo2, Tag, Wand2, RotateCcw, Search, Undo2,
  Sparkles, Sun, Trash2, X, Eye, Pin, PinOff, List, Ellipsis, Info, FolderPlus,
} from "lucide-react";
import { getAiModels, getAiProviders, streamAiTask, type HiddenModel, type AiCitation, type AiModelOption, type AiOperation, type AiProposal, type AiProvider, type AiProviderStatus, type AiScope } from "./ai";
import { AiAssistantPanel } from "./components/AiAssistantPanel";
import { FindBar, type FindHost } from "./components/FindBar";
import { FindAndReplace } from "@tiptap/extension-find-and-replace";
import { WikiLinks } from "./wikiLinkExtension";
import { searchNotes, splitHighlight } from "./searchNotes";
import { checkProposal, cleanModelText } from "./aiChecks";
import { outputTokensFor } from "./aiLimits";
import { matchShortcut, SHORTCUT_HELP } from "./shortcuts";
import { buildLinkIndex, linksOfBlocks, normTitle, renameLinkInBlocks, wikiLinkText, type LinkIndex } from "./wikiLinks";
import { importWindowsNotepadZip } from "./windowsNotepadImport";
import { loadPromptLibrary, type PromptRecipe } from "./promptLibrary";
import type { DocItem, LabState } from "./labState";
import { host, isHosted, onHostEvent, type HistoryEntry } from "./bridge";
import { EDITOR_LIMIT_CHARS, toLabState, type HostSync, type LoadedHost } from "./hostAdapter";
import { blocksToText, textToBlocks, type LooseBlock } from "./textFormat";

const AI_EDIT_MAX_OUTPUT_TOKENS = 512;
const AI_ANALYSIS_MAX_OUTPUT_TOKENS = 1536;

type FormDialog = { kind: "folder" | "move" | "tag" | "rename"; title: string; value: string; hint: string; parent?: string } | null;
type EditorSelection = { text: string; from: number; to: number; top: number; left: number } | null;
type FinderCommand = {
  id: string;
  shortcut?: string;
  label: string;
  hint: string;
  keywords: string;
  disabled?: boolean;
  icon: typeof Command;
  run: () => void;
};

const starterContent = [
  { type: "heading" as const, props: { level: 1 as const }, content: "Запуск продукта" },
  { type: "paragraph" as const, content: "Короткий план, который помогает команде двигаться в одном направлении — без лишнего шума." },
  { type: "heading" as const, props: { level: 2 as const }, content: "На этой неделе" },
  { type: "checkListItem" as const, content: "Уточнить ключевые сценарии редактора" },
  { type: "checkListItem" as const, content: "Собрать обратную связь по первому прототипу" },
  { type: "checkListItem" as const, content: "Подготовить план следующего этапа" },
  { type: "heading" as const, props: { level: 2 as const }, content: "Заметки" },
  { type: "bulletListItem" as const, content: "Сохраняем спокойную типографику и много воздуха." },
  { type: "bulletListItem" as const, content: "Сначала проверяем редактор отдельно от пользовательских данных." },
];

function makeStarter() {
  return starterContent.map((block) => ({ ...block }));
}

function sampleContent(title: string): PartialBlock[] {
  return [
    { type: "heading", props: { level: 1 }, content: title },
    { type: "paragraph", content: "Это демонстрационная заметка. Изменения сохраняются локально в прототипе и не затрагивают файлы Notepad Hub." },
  ];
}

/** Russian plural: 1 слово, 2 слова, 5 слов (21 слово, 12 слов). */
function plural(n: number, forms: [string, string, string]): string {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? forms[0] : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? forms[1] : forms[2];
}

const NOTE_GROUPS = ["Сегодня", "Вчера", "Последние 7 дней", "Последние 30 дней", "Ранее"] as const;
/** The group of the notes list a moment of change belongs to (calendar days, local time). */
function dateGroup(ts: number | undefined, now: number): (typeof NOTE_GROUPS)[number] {
  if (!ts) return NOTE_GROUPS[4];
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  return ts >= start ? NOTE_GROUPS[0] : ts >= start - day ? NOTE_GROUPS[1] : ts >= start - 6 * day ? NOTE_GROUPS[2] : ts >= start - 29 * day ? NOTE_GROUPS[3] : NOTE_GROUPS[4];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (ts: number) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

const SYSTEM_PROJECTS = ["Входящие", "Импорт Windows"];
const AUTO_NAME = /^Заметка \d+$/;
const AUTO_IDS_KEY = "nh4-auto-name-ids";
/** Ids of the notes that got their "Заметка N" name from the app (not typed by the person). Only these are renumbered. */
function loadAutoIds(docs: readonly { id: string; title: string }[]): Set<string> {
  try {
    const raw = window.localStorage.getItem(AUTO_IDS_KEY);
    if (raw !== null) { const list = JSON.parse(raw) as unknown; if (Array.isArray(list)) return new Set(list.filter((x): x is string => typeof x === "string")); }
  } catch { /* falls back to the names */ }
  return new Set(docs.filter((doc) => AUTO_NAME.test(doc.title)).map((doc) => doc.id));  // first start after the update: every existing "Заметка N" counts as automatic
}
function saveAutoIds(ids: ReadonlySet<string>) { try { window.localStorage.setItem(AUTO_IDS_KEY, JSON.stringify([...ids])); } catch { /* optional */ } }
/** The next automatic name: "Заметка N", N = the count of live automatically named notes + 1. */
function nextAutoName(docs: readonly { id: string; title: string; deletedAt?: string }[], autoIds: ReadonlySet<string>): string {
  return `Заметка ${docs.filter((doc) => !doc.deletedAt && autoIds.has(doc.id) && AUTO_NAME.test(doc.title)).length + 1}`;
}
/** The project and every project nested in it, at any depth. */
function projectScope(name: string, parents: Readonly<Record<string, string>>): Set<string> {
  const scope = new Set([name]);
  for (let grew = true; grew;) { grew = false; for (const [child, parent] of Object.entries(parents)) if (scope.has(parent) && !scope.has(child)) { scope.add(child); grew = true; } }
  return scope;
}
/** "Работа / Клиенты": the project with the names of the projects it is nested in. */
function projectPath(name: string, parents: Readonly<Record<string, string>>): string {
  const path = [name];
  for (let cur = parents[name]; cur && !path.includes(cur); cur = parents[cur]) path.unshift(cur);
  return path.join(" / ");
}
/** Projects in tree order (parent, then its children) with their depth. A project whose parent is unknown counts as top level. */
function projectRows(folders: readonly string[], parents: Readonly<Record<string, string>>, closed: readonly string[]): Array<{ name: string; depth: number; hasChildren: boolean }> {
  const known = new Set(folders);
  const kids = (parent: string) => folders.filter((name) => (parents[name] && known.has(parents[name]) ? parents[name] : "") === parent);
  const rows: Array<{ name: string; depth: number; hasChildren: boolean }> = [];
  const walk = (parent: string, depth: number, seen: Set<string>) => {
    for (const name of kids(parent)) {
      if (seen.has(name)) continue;
      const children = kids(name);
      rows.push({ name, depth, hasChildren: children.length > 0 });
      if (children.length > 0 && !closed.includes(name)) walk(name, depth + 1, new Set([...seen, name]));
    }
  };
  walk("", 0, new Set());
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (isRecord(content) && content.type === "tableContent" && Array.isArray(content.rows)) {
    // a table is sent to the AI (and counted in the note text) as plain pipe rows
    return content.rows.map((row) => isRecord(row) && Array.isArray(row.cells)
      ? "| " + row.cells.map((cell) => blockText(Array.isArray(cell) ? cell : isRecord(cell) ? cell.content : "").replace(/\s+/g, " ").trim()).join(" | ") + " |"
      : "").filter(Boolean).join("\n");
  }
  if (!Array.isArray(content)) return "";
  return content.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("");
}

/** The text of a block as the AI sees it: pictures as ![caption](address), tables as pipe rows, everything else as its inline text. */
function blockToText(block: { type?: string; props?: Record<string, unknown>; content?: unknown }): string {
  if (block.type === "image" && typeof block.props?.url === "string" && block.props.url) {
    const alt = String(block.props.caption || block.props.name || "").replace(/[\]\n]/g, " ");
    return `![${alt}](${block.props.url.replace(/ /g, "%20").replace(/\)/g, "%29")})`;
  }
  return blockText(block.content);
}

/** The note as Markdown-like text for the model: heading levels, list marks and quotes stay visible, so a formatting answer can keep them. */
function noteAsMarkdown(blocks: ReadonlyArray<{ type?: string; props?: Record<string, unknown>; content?: unknown }>): string {
  let number = 0;
  return blocks.map((block) => {
    if (block.type !== "numberedListItem") number = 0;
    const text = blockToText(block);
    if (!text.trim()) return "";
    switch (block.type) {
      case "heading": return "#".repeat(Math.min(3, Math.max(1, Number(block.props?.level ?? 1)))) + " " + text;
      case "bulletListItem": return "- " + text;
      case "numberedListItem": number += 1; return `${number}. ` + text;
      case "checkListItem": return (block.props?.checked ? "- [x] " : "- [ ] ") + text;
      case "quote": return "> " + text;
      default: return text;
    }
  }).filter(Boolean).join("\n\n");
}

/** Markdown from the AI back into blocks: tables and pictures go through our own reader (it understands the pipe rows the AI was shown), the rest through BlockNote's Markdown parser. */
function parseAiBlocks(parseMarkdown: (markdown: string) => PartialBlock[], text: string): PartialBlock[] {
  const rich = (line: string) => line.startsWith("| ") || /^!\[[^\]\n]*\]\(\S+\)$/.test(line);
  const out: PartialBlock[] = [];
  const all = text.split("\n");
  let i = 0;
  while (i < all.length) {
    const kind = rich(all[i]);
    let j = i;
    while (j < all.length && rich(all[j]) === kind) j++;
    const chunk = all.slice(i, j).join("\n");
    if (kind) out.push(...(textToBlocks(chunk) as PartialBlock[]));
    else if (chunk.trim()) out.push(...parseMarkdown(chunk));
    i = j;
  }
  // a model answer may only point at pictures that are already stored next to the notes; any other address would be loaded by the page and could carry note text out
  return out.map((block) => {
    const url = block.type === "image" ? String((block.props as { url?: string } | undefined)?.url ?? "") : "";
    if (block.type !== "image" || url.startsWith("https://assets.notepadhub.local/")) return block;
    const alt = String((block.props as { caption?: string; name?: string } | undefined)?.caption || (block.props as { name?: string } | undefined)?.name || "").trim();
    return { type: "paragraph", content: alt ? `[${alt}]` : "" } as PartialBlock;
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

type InspectorProps = {
  headings: Array<{ id: string; level: number; text: string }>;
  onJump: (id: string) => void;
  onClose: () => void;
  activeDoc?: DocItem;
  folder: string;
  onMove: () => void;
};

function Inspector({ headings, onJump, onClose, activeDoc, folder, onMove }: InspectorProps) {
  return (
    <aside className="inspector-panel note-properties-panel" aria-label="Содержание и свойства заметки">
      <div className="inspector-heading">
        <strong>Содержание и свойства</strong>
        <button className="icon-button tiny" onClick={onClose} aria-label="Закрыть инспектор"><X size={17} /></button>
      </div>
      <div className="inspector-content">
        <div className="property-label">СОДЕРЖАНИЕ</div>
        {headings.length === 0 ? <div className="property-note">В заметке пока нет заголовков. Оглавление строится по заголовкам и позволяет перейти к разделу.</div>
          : <ul className="outline-list">{headings.map((h) => <li key={h.id} style={{ paddingLeft: (h.level - 1) * 14 }}><button onClick={() => onJump(h.id)} title={h.text}>{h.text}</button></li>)}</ul>}
        <div className="property-label">РАСПОЛОЖЕНИЕ</div>
        <button className="property-value property-action" onClick={onMove} disabled={!activeDoc}><Folder size={16} />{activeDoc?.folder ?? folder}<span>Переместить</span></button>
        <div className="property-label">СОЗДАНО</div>
        <div className="property-value muted-value"><Clock3 size={16} />Хранится на этом компьютере</div>
        <div className="property-label">ХРАНЕНИЕ</div>
        <div className="property-note">Заметки сохраняются на этом компьютере в папке данных Notepad Hub. Каждая заметка — отдельный файл; облачной синхронизации нет.</div>
      </div>
    </aside>
  );
}

/** Tags are kept in the same single string field as in 3.0.5 ("a, b"), so older versions still read it. */
const parseTags = (value: string | undefined): string[] => [...new Set((value ?? "").split(/[,;]/).map((t) => t.replace(/^#/, "").trim().slice(0, 20)).filter(Boolean))].slice(0, 8);

export default function App({ initial, sync }: { initial: LoadedHost; sync: HostSync }) {
  const [initialState] = useState(() => initial.state);
  const closeTabRef = useRef<(id: string) => Promise<void>>(async () => undefined);
  const openIdsRef = useRef<string[]>([]);
  const addDocumentRef = useRef<() => void>(() => undefined);
  const stepTabRef = useRef<(delta: number) => void>(() => undefined);
  const linkIndexRef = useRef<LinkIndex | null>(null);
  const openLinkRef = useRef<(title: string) => void>(() => undefined);
  // pictures pasted or dropped into the sheet are stored by the host next to the notes and shown from its read-only picture address
  const uploadFile = async (file: File): Promise<string> => {
      const tell = (message: string) => window.dispatchEvent(new CustomEvent("nh4-notice", { detail: message }));
      if (!file.type.startsWith("image/")) { tell("В заметку можно вставить только изображение (PNG, JPEG, GIF, WebP)."); throw new Error("not an image"); }
      if (file.size > 10 * 1024 * 1024) { tell("Изображение больше 10 МБ."); throw new Error("too large"); }
      if (!isHosted()) return URL.createObjectURL(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      try { return `https://assets.notepadhub.local/${(await host.saveAsset(btoa(binary))).file}`; }
      catch (error) { tell(error instanceof Error ? error.message : "Не удалось сохранить изображение."); throw error; }
    };
    // copied web content keeps its formatting (BlockNote parses the HTML); its pictures are stored by the host so the note owns them
  const pasteHandler: NonNullable<NonNullable<Parameters<typeof useCreateBlockNote>[0]>["pasteHandler"]> = ({ event, editor: target, defaultPasteHandler }) => {
      try {
        const data = event.clipboardData;
        const html = data?.getData("text/html") ?? "";
        const hasFiles = (data?.files?.length ?? 0) > 0;
        const hosted = isHosted();
        const hasImg = /<img/i.test(html);
        if (!hosted || !html || !hasImg || hasFiles) return defaultPasteHandler();
        const tell = (message: string) => window.dispatchEvent(new CustomEvent("nh4-notice", { detail: message }));
        tell("Сохраняю картинки из вставленного текста…");
        void localizePictures(html, {
          saveBase64: async (base64) => `https://assets.notepadhub.local/${(await host.saveAsset(base64)).file}`,
          fetchUrl: async (url) => `https://assets.notepadhub.local/${(await host.fetchImage(url)).file}`,
        }).then(({ html: rewritten, kept, dropped }) => {
          target.pasteHTML(rewritten);
          tell(dropped > 0 ? `Картинок сохранено: ${kept}; не удалось сохранить: ${dropped}.` : kept > 0 ? `Картинок сохранено: ${kept}.` : "Вставлено.");
        }).catch(() => { target.pasteHTML(html); tell("Картинки не удалось сохранить; вставлено как есть."); });
        return true;
      } catch {
        return defaultPasteHandler();
      }
    };
  const editor = useCreateBlockNote({
    dictionary: { ...ru, placeholders: { ...ru.placeholders, heading: "Введите название заметки" } },
    domAttributes: { editor: { "aria-label": "Текст заметки" } },
    uploadFile,
    pasteHandler,
    // injectCSS off: the host CSP forbids injected <style>; highlight classes are styled in layout-v4.css
    _tiptapOptions: { extensions: [FindAndReplace.configure({ injectCSS: false, searchDebounceMs: 0 }), WikiLinks({ resolve: (key) => linkIndexRef.current?.byTitle.has(key) ?? false, open: (title) => openLinkRef.current(title) })] },
    initialContent: initialState.contents[initialState.activeId ?? ""] ?? [{ type: "paragraph", content: "Создайте заметку кнопкой «Новая заметка»." }],
  });
  // the second editor of the two-note view: the same picture and paste rules, no find bar or wiki links
  const editor2 = useCreateBlockNote({
    dictionary: { ...ru, placeholders: { ...ru.placeholders, heading: "Введите название заметки" } },
    domAttributes: { editor: { "aria-label": "Текст второй заметки" } },
    uploadFile,
    pasteHandler,
    initialContent: [{ type: "paragraph", content: "" }],
  });
  const [docs, setDocs] = useState(initialState.docs);
  const [contents, setContents] = useState(initialState.contents);
  const [activeId, setActiveId] = useState<string | null>(initialState.activeId);
  const activeIdRef = useRef<string | null>(initialState.activeId);
  const docsRef = useRef(initialState.docs);
  const contentsRef = useRef(initialState.contents);
  const autoIdsRef = useRef<Set<string> | null>(null);
  if (autoIdsRef.current === null) { autoIdsRef.current = loadAutoIds(initialState.docs); saveAutoIds(autoIdsRef.current); }
  useEffect(() => { docsRef.current = docs; contentsRef.current = contents; });
  // "Заметка N" numbers follow the order of the automatically named notes: they close up when a note is renamed, trashed or deleted
  useEffect(() => {
    let n = 0;
    const wanted = new Map<string, string>();
    const ids = autoIdsRef.current!;
    let changed = false;
    for (const doc of docs) {
      if (!ids.has(doc.id)) continue;
      if (!AUTO_NAME.test(doc.title)) { ids.delete(doc.id); changed = true; continue; }   // the person named it: no longer automatic
      if (doc.deletedAt) continue;
      n += 1;
      if (doc.title !== `Заметка ${n}`) wanted.set(doc.id, `Заметка ${n}`);
    }
    if (changed) saveAutoIds(ids);
    if (wanted.size > 0) setDocs((current) => current.map((doc) => wanted.has(doc.id) ? { ...doc, title: wanted.get(doc.id)! } : doc));
  }, [docs]);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState(initialState.folder);
  const [noteView, setNoteView] = useState<"folder" | "all" | "pinned" | "recent" | "archive" | "trash">("folder");
  const [folders, setFolders] = useState(initialState.folders);
  const [parents, setParents] = useState<Record<string, string>>(initial.parents);
  const [closedProjects, setClosedProjects] = useState<string[]>(() => { try { const v = JSON.parse(window.localStorage.getItem("nh4-closed-projects") ?? "[]") as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } });
  const [subNotes, setSubNotes] = useState(() => { try { return window.localStorage.getItem("nh4-sub-notes") !== "0"; } catch { return true; } });
  const [dense, setDense] = useState(() => { try { return window.localStorage.getItem("nh4-dense") === "1"; } catch { return false; } });
  useEffect(() => { try { window.localStorage.setItem("nh4-closed-projects", JSON.stringify(closedProjects)); window.localStorage.setItem("nh4-sub-notes", subNotes ? "1" : "0"); window.localStorage.setItem("nh4-dense", dense ? "1" : "0"); } catch { /* optional */ } }, [closedProjects, subNotes, dense]);
  const [focusMode, setFocusMode] = useState(false);
  const [dragProject, setDragProject] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dark, setDark] = useState(initialState.dark);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [savedAt, setSavedAt] = useState("Загружено");
  const [showSearch, setShowSearch] = useState(false);
  const [zoom, setZoom] = useState(() => { try { const v = Number(localStorage.getItem("nh4-zoom")); return v >= 70 && v <= 200 ? v : 100; } catch { return 100; } });
  useEffect(() => { try { localStorage.setItem("nh4-zoom", String(zoom)); } catch { /* storage may be unavailable */ } }, [zoom]);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [find, setFind] = useState<null | { replace: boolean; term?: string }>(null);
  const pendingFindRef = useRef("");
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  const [formDialog, setFormDialog] = useState<FormDialog>(null);
  const [notice, setNotice] = useState("");
  const [refs, setRefs] = useState<{ files: Array<{ id: string; title: string; sourcePath: string; bytes: number }>; picked: string[]; loading: boolean; error: string } | null>(null);
  const [history, setHistory] = useState<{ entries: HistoryEntry[]; loading: boolean; error: string; selected: string | null; preview: string } | null>(null);
  const [activeInspector, setActiveInspector] = useState<"ai" | "properties" | null>(null);
  const [aiProviders, setAiProviders] = useState<AiProviderStatus["providers"] | null>(null);
  // the free online service is the default (the owner asked for fast free online models); the choice is remembered
  const [aiProvider, setAiProvider] = useState<AiProvider>(() => {
    try { const v = localStorage.getItem("nh4-ai-provider"); if (v === "ollama" || v === "openrouter" || v === "compat") return v; } catch { /* storage may be unavailable */ }
    return isHosted() ? "compat" : "ollama";
  });
  useEffect(() => { try { localStorage.setItem("nh4-ai-provider", aiProvider); } catch { /* optional */ } }, [aiProvider]);
  const [aiModels, setAiModels] = useState<AiModelOption[]>([]);
  const [aiModelsLoading, setAiModelsLoading] = useState(false);
  const [aiModelsError, setAiModelsError] = useState("");
  const [aiHiddenModels, setAiHiddenModels] = useState<HiddenModel[]>([]);
  const [aiModelsReload, setAiModelsReload] = useState(0);
  const cloudModelName = (name: string) => /(^|[-/:])cloud($|[-/:])/i.test(name);
  const [aiModel, setAiModel] = useState("");
  const [aiScope, setAiScope] = useState<AiScope>("paragraph");
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiWritingRule, setAiWritingRule] = useState(() => {
    try { return window.localStorage.getItem("notepad-ai-writing-rule-v1") ?? ""; } catch { return ""; }
  });
  const [aiRemoteConsent, setAiRemoteConsent] = useState(() => {
    try { const v = window.localStorage.getItem("notepad-ai-openrouter-consent-v1"); return v === null ? true : v === "true"; } catch { return true; }
  });
  const [aiPending, setAiPending] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiStreamText, setAiStreamText] = useState("");
  const [aiFirstTokenMs, setAiFirstTokenMs] = useState<number | null>(null);
  const [aiElapsedMs, setAiElapsedMs] = useState(0);
  const [aiProposal, setAiProposal] = useState<AiProposal | null>(null);
  const [aiCompactMode, setAiCompactMode] = useState(false);
  const [aiWidth, setAiWidth] = useState(() => { try { const v = Number(localStorage.getItem("nh4-ai-width")); return v >= 340 && v <= 640 ? v : 400; } catch { return 400; } });
  useEffect(() => { try { localStorage.setItem("nh4-ai-width", String(aiWidth)); } catch { /* storage may be unavailable */ } }, [aiWidth]);
  const startAiResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => setAiWidth(Math.round(Math.min(640, Math.max(340, window.innerWidth - e.clientX, 0))));
    const stop = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", stop); target.removeEventListener("pointercancel", stop); };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", stop);
  }, []);
  const [aiSelection, setAiSelection] = useState<EditorSelection>(null);
  const [canUndoAi, setCanUndoAi] = useState(false);
  const metaAbortRef = useRef<AbortController | null>(null);
  const [imageDialog, setImageDialog] = useState<null | { kind: "generate" | "edit"; selection: string; note: string; startId?: string; prompt?: string }>(null);
  const tabsScrollerRef = useRef<HTMLDivElement>(null);
  const [tabsEdge, setTabsEdge] = useState({ overflow: false, left: false, right: false });   // the tab strip scrolls sideways: arrows and the mouse wheel
  const [notesSort, setNotesSort] = useState<"modified" | "title">(() => { try { return window.localStorage.getItem("nh4-notes-sort") === "title" ? "title" : "modified"; } catch { return "modified"; } });
  const [notesPreview, setNotesPreview] = useState(() => { try { return window.localStorage.getItem("nh4-notes-preview") === "1"; } catch { return false; } });
  const [closedGroups, setClosedGroups] = useState<string[]>([]);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); });
  const [dayFilter, setDayFilter] = useState<number | null>(null);   // the notes list shows the notes changed on this day
  const navStackRef = useRef<string[]>([]);
  const navPosRef = useRef(-1);
  const navSilentRef = useRef(false);
  const [navState, setNavState] = useState({ back: false, forward: false });
  const [trashPane, setTrashPane] = useState(false);   // the trash is shown as a list in the main area
  const [railMenu, setRailMenu] = useState<null | "pinned" | "recent">(null);   // the quick list next to the narrow library column
  const [tagsOpen, setTagsOpen] = useState(() => { try { return window.localStorage.getItem("nh4-tags-open") === "1"; } catch { return false; } });
  const [secondId, setSecondId] = useState<string | null>(null);   // the note shown on the right in the two-note view
  const [compareOpen, setCompareOpen] = useState(false);
  const secondLoadingRef = useRef(false);
  const [confirmDialog, setConfirmDialog] = useState<null | { title: string; message: string; confirm: string; danger?: boolean; run: () => void }>(null);
  const [tabMenu, setTabMenu] = useState<null | { x: number; y: number; id: string }>(null);
  const [toastAction, setToastAction] = useState<null | { label: string; run: () => void }>(null);
  const [formatJob, setFormatJob] = useState<null | { id: string; stage: "wait" | "work" }>(null);
  const formatAbortRef = useRef<AbortController | null>(null);
  const [metaDialog, setMetaDialog] = useState<{ title: string; tags: string; ai: "wait" | "work" | "done" | "off"; note: string } | null>(null);
  const [customTransformations, setCustomTransformations] = useState<Transformation[]>(() => { try { return loadCustom(window.localStorage); } catch { return []; } });
  const transformationList = useMemo(() => [...TRANSFORMATIONS, ...customTransformations], [customTransformations]);
  const transformationListRef = useRef<Transformation[]>(transformationList);
  transformationListRef.current = transformationList;
  const findTransformation = (id: string) => transformationListRef.current.find((item) => item.id === id);
  const [transformationsOpen, setTransformationsOpen] = useState(false);
  const aiProposalRef = useRef<AiProposal | null>(null);
  const aiErrorRef = useRef("");
  const haltAuto = useCallback(() => { aiAbortControllerRef.current?.abort(); }, []);
  const aiAbortControllerRef = useRef<AbortController | null>(null);
  const aiAcceptedSignatureRef = useRef<string | null>(null);
  const citationHighlightCleanupRef = useRef<(() => void) | null>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const [tags, setTags] = useState<Record<string, string>>(initialState.tags);
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const searchOriginRef = useRef<HTMLElement | null>(null);
  const aiTriggerRef = useRef<HTMLButtonElement>(null);
  const [promptRecipes] = useState<PromptRecipe[]>(() => {
    try {
      const loaded = loadPromptLibrary(window.localStorage);
      return loaded.ok ? loaded.value : [];
    } catch {
      return [];
    }
  });
  const activeDoc = docs.find((doc) => doc.id === activeId);
  aiProposalRef.current = aiProposal;
  aiErrorRef.current = aiError;
  const linkIndex = useMemo(() => buildLinkIndex(docs, contents as Record<string, LooseBlock[]>), [docs, contents]);
  linkIndexRef.current = linkIndex;
  const pinnedDocs = docs.filter((doc) => doc.pinned && !doc.deletedAt);
  const recentDocs = docs.filter((doc) => typeof doc.lastOpenedAt === "number" && !doc.deletedAt && !doc.archived).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
  const trashCount = docs.filter((doc) => doc.deletedAt).length;
  const folderScope = subNotes ? projectScope(folder, parents) : new Set([folder]);
  const filteredDocs = docs.filter((doc) => {
    if (noteView === "trash") return Boolean(doc.deletedAt);
    if (tagFilter && !parseTags(tags[doc.id]).includes(tagFilter)) return false;
    if (doc.deletedAt) return false;
    if (noteView === "archive") return Boolean(doc.archived);
    if (noteView === "pinned") return Boolean(doc.pinned);
    if (noteView === "recent") return typeof doc.lastOpenedAt === "number" && !doc.archived;
    if (noteView === "all" && dayFilter === null) return !doc.archived;
    if (dayFilter !== null) { const t = doc.modifiedAt ?? 0; return !doc.archived && t >= dayFilter && t < dayFilter + DAY_MS; }
    return !doc.archived && folderScope.has(doc.folder);
  }).sort((left, right) => noteView === "recent" || noteView === "pinned"
      ? (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0)
      : 0);
  const dayCounts = new Map<number, number>();
  for (const doc of docs) { if (doc.deletedAt || !doc.modifiedAt) continue; const day = startOfDay(doc.modifiedAt); dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1); }
  const listNow = Date.now();
  const listDocs = noteView === "recent" || noteView === "pinned" ? filteredDocs
    : [...filteredDocs].sort((a, b) => notesSort === "title" ? a.title.localeCompare(b.title, "ru") : (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  const pinnedFirst = (noteView === "folder" || noteView === "all") && dayFilter === null && listDocs.some((doc) => doc.pinned);
  const listGroups: Array<{ name: string; items: DocItem[] }> = notesSort === "modified" && noteView !== "recent" && noteView !== "pinned"
    ? [...(pinnedFirst ? [{ name: "Закреплённые", items: listDocs.filter((doc) => doc.pinned) }] : []),
        ...NOTE_GROUPS.map((name) => ({ name, items: listDocs.filter((doc) => !(pinnedFirst && doc.pinned) && dateGroup(doc.modifiedAt, listNow) === name) })).filter((group) => group.items.length > 0)]
    : [{ name: "", items: pinnedFirst ? [...listDocs.filter((doc) => doc.pinned), ...listDocs.filter((doc) => !doc.pinned)] : listDocs }];
  const snippetOf = (doc: DocItem): string => {
    for (const block of contents[doc.id] ?? []) {
      if (block.type === "heading" || block.type === "image") continue;
      const text = blockText((block as { content?: unknown }).content).replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 90);
    }
    return "";
  };
  const headingsOf = activeId ? (contents[activeId] ?? []).filter((block) => block.type === "heading").map((block) => ({ id: String((block as { id?: string }).id ?? ""), level: Number(((block as { props?: { level?: number } }).props?.level) ?? 1), text: blockText((block as { content?: unknown }).content).trim() })).filter((h) => h.id && h.text) : [];
  // Open tabs: a note is a tab once opened and stays until the user closes it. The strip only shows tabs that belong to the current section (trash / archive / regular).
  const [openIds, setOpenIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("nh4-open-tabs") ?? "null") as unknown;
      const known = new Set(initialState.docs.map((doc) => doc.id));
      if (Array.isArray(saved)) { const ids = saved.filter((id): id is string => typeof id === "string" && known.has(id)); if (ids.length) return ids; }
    } catch { /* storage may be unavailable */ }
    const recent = [...initialState.docs].filter((doc) => !doc.deletedAt && !doc.archived).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)).slice(0, 6).map((doc) => doc.id);
    return initialState.activeId && !recent.includes(initialState.activeId) ? [initialState.activeId, ...recent] : recent;
  });
  useEffect(() => { if (activeId) setOpenIds((current) => current.includes(activeId) ? current : [...current, activeId]); }, [activeId]);
  useEffect(() => { try { localStorage.setItem("nh4-open-tabs", JSON.stringify(openIds)); } catch { /* storage may be unavailable */ } }, [openIds]);
  openIdsRef.current = openIds;
  const inSection = (doc: DocItem) => noteView === "trash" ? Boolean(doc.deletedAt) : noteView === "archive" ? Boolean(doc.archived) && !doc.deletedAt : !doc.deletedAt && !doc.archived;
  const openTabs = openIds.map((id) => docs.find((doc) => doc.id === id)).filter((doc): doc is DocItem => Boolean(doc) && inSection(doc as DocItem));
  useEffect(() => {
    const el = tabsScrollerRef.current;
    if (!el) return;
    const measure = () => {
      const overflow = el.scrollWidth > el.clientWidth + 1;
      setTabsEdge((current) => { const next = { overflow, left: overflow && el.scrollLeft > 1, right: overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }; return current.overflow === next.overflow && current.left === next.left && current.right === next.right ? current : next; });
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || el.scrollWidth <= el.clientWidth + 1) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      el.scrollLeft += delta;
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => { el.removeEventListener("scroll", measure); el.removeEventListener("wheel", onWheel); observer.disconnect(); };
  }, [docs.length, openIds.length]);

  // computed only while the search is open (it used to run over every note on every render)
  const searchHits = useMemo(
    () => showSearch && !query.trimStart().startsWith(">") ? searchNotes(docs, contents as Record<string, LooseBlock[]>, tags, query) : [],
    [showSearch, query, docs, contents, tags],
  );
  const searchResults = useMemo(() => searchHits.map((hit) => hit.doc), [searchHits]);
  const searchHitById = useMemo(() => new Map(searchHits.map((hit) => [hit.doc.id, hit])), [searchHits]);
  const searchTotal = useMemo(() => searchHits.reduce((sum, hit) => sum + hit.matches, 0), [searchHits]);
  const markWords = (text: string) => splitHighlight(text, query).map((part, index) => part.hit ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>);
  // a service whose model list cannot be loaded still works when the owner types the model name
  const selectedModel = aiModels.find((model) => model.id === aiModel) ?? (aiProvider === "compat" && aiModel.trim() ? { id: aiModel.trim(), name: aiModel.trim(), free: false } : undefined);
  const activeCursorBlock = activeId ? editor.getTextCursorPosition().block : undefined;
  const cursorBlockText = activeCursorBlock ? blockText(activeCursorBlock.content) : "";
  const currentSelectedText = aiSelection?.text ?? editor.getSelectedText();
  const noteContextEntries = editor.document.map((block, index) => ({
    marker: `B${index + 1}`,
    blockId: block.id,
    label: blockToText(block).slice(0, 70) || `Блок ${index + 1}`,
    text: blockToText(block),
  })).filter((item) => item.text.trim());
  // AI context "note + linked notes": explicit, capped, read-only. Outgoing links first, then backlinks; at most 5 notes, 3000 characters each.
  const linkedDocs = useMemo(() => {
    if (!activeId) return [] as DocItem[];
    const ids: string[] = [];
    for (const link of linkIndex.outgoing(activeId)) if (link.id && link.id !== activeId && !ids.includes(link.id)) ids.push(link.id);
    for (const back of linkIndex.backlinks(activeId)) if (!ids.includes(back.id)) ids.push(back.id);
    return ids.slice(0, 5).map((id) => docs.find((doc) => doc.id === id)).filter((doc): doc is DocItem => Boolean(doc));
  }, [activeId, linkIndex, docs]);
  const buildLinkedEntries = (startIndex: number, budget: number) => {
    const entries: Array<{ marker: string; blockId: string; label: string; text: string }> = [];
    const titles: string[] = [];
    let left = Math.max(0, budget);
    for (const doc of linkedDocs) {
      let perNote = Math.min(3000, left);
      if (perNote < 200) break;
      let added = false;
      for (const block of contents[doc.id] ?? []) {
        const text = blockToText(block).trim();
        if (!text) continue;
        const clipped = text.slice(0, perNote);
        entries.push({ marker: `B${startIndex + entries.length}`, blockId: `note:${doc.id}`, label: `«${doc.title}»: ${clipped.slice(0, 50)}`, text: `«${doc.title}»: ${clipped}` });
        const cost = clipped.length + `[B${startIndex + entries.length - 1}] `.length + 2;   // marker and paragraph break count against the 24 000-character host limit
        perNote -= cost;
        left -= cost;
        added = true;
        if (perNote <= 0) break;
      }
      if (added) titles.push(doc.title);
    }
    return { entries, titles };
  };
  const noteContextJoined = noteContextEntries.map((item) => `[${item.marker}] ${item.text}`).join("\n\n");
  const linkedContext = aiScope === "linked" ? buildLinkedEntries(editor.document.length + 1, 22_000 - noteContextJoined.length) : { entries: [], titles: [] as string[] };
  const aiContextText = aiScope === "linked"
    ? [noteContextJoined, ...linkedContext.entries.map((item) => `[${item.marker}] ${item.text}`)].filter(Boolean).join("\n\n")
    : aiScope === "selection"
    ? currentSelectedText ? `[B1] ${currentSelectedText}` : ""
    : aiScope === "paragraph"
      ? cursorBlockText ? `[B1] ${cursorBlockText}` : ""
      : noteContextEntries.map((item) => `[${item.marker}] ${item.text}`).join("\n\n");
  const estimateAiCost = (maxOutputTokens: number) => selectedModel?.free
    ? 0
    : selectedModel?.promptPrice !== undefined && selectedModel.completionPrice !== undefined
      ? Math.ceil((aiContextText.length + (activeDoc?.title.length ?? 0) + aiInstruction.length + aiWritingRule.length + 600) / 4) * selectedModel.promptPrice
        + maxOutputTokens * selectedModel.completionPrice
      : null;
  const estimatedAiCost = estimateAiCost(outputTokensFor("rewrite", aiContextText.length));

  const restoreSearchFocus = useCallback(() => {
    const origin = searchOriginRef.current;
    if (origin && document.contains(origin)) {
      origin.focus();
      return;
    }
    searchTriggerRef.current?.focus();
  }, []);

  const openSearch = useCallback(() => {
    searchOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : searchTriggerRef.current;
    setShowSearch(true);
    window.setTimeout(() => document.getElementById("global-search")?.focus(), 0);
  }, []);

  const closeAiAssistant = useCallback(() => {
    aiAbortControllerRef.current?.abort();
    setActiveInspector(null);
    window.setTimeout(() => aiTriggerRef.current?.focus(), 0);
  }, []);

  const autoNeedsAi = metaDialog !== null || imageDialog !== null || formatJob !== null || transformationsOpen;
  useEffect(() => {
    if (activeInspector !== "ai" && !autoNeedsAi) return;
    const controller = new AbortController();
    getAiProviders(controller.signal).then((status) => {
      setAiProviders(status.providers);
    }).catch(() => {
      if (!controller.signal.aborted) setAiModelsError("Не удалось получить состояние AI-серверов.");
    });
    return () => controller.abort();
  }, [activeInspector, autoNeedsAi]);

  useEffect(() => {
    if (activeInspector !== "ai" && !autoNeedsAi) return;
    const controller = new AbortController();
    setAiModelsLoading(true);
    setAiModelsError("");
    getAiModels(aiProvider, controller.signal).then(({ models, hidden }) => {
      setAiHiddenModels(hidden);
      setAiModels(models);
      setAiModel((current) => models.some((model) => model.id === current) ? current : models[0]?.id ?? "");
      if (models.length === 0) setAiModelsError(aiProvider === "ollama" ? "В Ollama нет доступных локальных моделей." : "В каталоге нет моделей для текстового ввода/вывода.");
    }).catch((error) => {
      if (!controller.signal.aborted) {
        setAiModels([]);
        setAiModel("");
        setAiModelsError(error instanceof Error ? error.message : "Не удалось загрузить модели.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setAiModelsLoading(false);
    });
    return () => controller.abort();
  }, [activeInspector, aiProvider, autoNeedsAi, aiModelsReload]);

  useEffect(() => {
    try { window.localStorage.setItem("notepad-ai-openrouter-consent-v1", String(aiRemoteConsent)); } catch { setAiModelsError("Не удалось сохранить настройку приватности."); }
  }, [aiRemoteConsent]);

  useEffect(() => {
    try { window.localStorage.setItem("notepad-ai-writing-rule-v1", aiWritingRule); } catch { setAiModelsError("Не удалось сохранить правило письма."); }
  }, [aiWritingRule]);

  useEffect(() => editor.onSelectionChange((currentEditor) => {
    const selection = currentEditor.prosemirrorView.state.selection;
    const text = currentEditor.getSelectedText();
    if (!text.trim() || selection.empty) {
      setAiSelection(null);
      return;
    }
    try {
      const start = currentEditor.prosemirrorView.coordsAtPos(selection.from);
      const end = currentEditor.prosemirrorView.coordsAtPos(selection.to);
      setAiSelection({
        text,
        from: selection.from,
        to: selection.to,
        top: Math.max(12, Math.min(window.innerHeight - 72, start.top - 42)),
        left: Math.max(12, Math.min(window.innerWidth - 190, (start.left + end.right) / 2 - 80)),
      });
    } catch {
      setAiSelection({ text, from: selection.from, to: selection.to, top: 16, left: 16 });
    }
  }), [editor]);

  useEffect(() => {
    const listener = (event: Event) => setNotice(String((event as CustomEvent).detail ?? ""));
    window.addEventListener("nh4-notice", listener);
    return () => window.removeEventListener("nh4-notice", listener);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { setNotice(""); setToastAction(null); }, toastAction ? 9000 : Math.min(9000, 2600 + notice.length * 45));
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    sync.setStatusHandler((s) => {
      setSavedAt(s.state === "error" ? "Не сохранено: " + s.message : s.message);
      if (s.state === "error") setNotice("Не удалось сохранить: " + s.message);
    });
  }, [sync]);

  useEffect(() => {
    const timer = window.setTimeout(() => sync.push({ docs, contents, activeId, folder, folders, parents, dark, tags }), 350);
    return () => window.clearTimeout(timer);
  }, [sync, docs, contents, activeId, folder, folders, parents, dark, tags]);

  // The host asks for a final save before the window closes.
  useEffect(() => onHostEvent("flush", () => {
    sync.push({ docs: docsRef.current, contents: contentsRef.current, activeId: activeIdRef.current, folder, folders, parents, dark, tags });
    void sync.flush().then((result) => host.flushAck(result));
  }), [sync, folder, folders, parents, dark, tags]);

  const createNote = useCallback((title: string, heading: string = title) => {
    const id = `note-${Date.now()}`;
    const next: DocItem = { id, title, folder, updated: "только что", icon: "note", lastOpenedAt: Date.now(), modifiedAt: Date.now() };
    const initial = [
      { type: "heading" as const, props: { level: 1 as const }, content: heading },
      { type: "paragraph" as const, content: "" },
    ];
    setDocs((current) => [...current, next]);
    setContents((current) => ({ ...current, [id]: initial }));
    activeIdRef.current = id;
    setActiveId(id);
    haltAuto();
    setNoteView("folder");
    editor.replaceBlocks(editor.document, initial);
    setSavedAt("Сохраняем локально…");
    return id;
  }, [editor, folder]);
  // a new note has no name yet: the heading is empty and shows a hint, the tab says "Заметка N" until a title is typed (N is renumbered, see below)
  const addDocument = useCallback(() => { const ids = autoIdsRef.current!; const id = createNote(nextAutoName(docsRef.current, ids), ""); ids.add(id); saveAutoIds(ids); }, [createNote]);

  const selectDocument = useCallback((doc: DocItem) => {
    haltAuto();
    setTrashPane(false);
    setRailMenu(null);
    setAiProposal(null);
    activeIdRef.current = doc.id;
    setActiveId(doc.id);
    setDocs((current) => current.map((item) => item.id === doc.id ? { ...item, lastOpenedAt: Date.now() } : item));
    editor.replaceBlocks(editor.document, contents[doc.id] ?? sampleContent(doc.title));
    setSavedAt("Сохраняем локально…");
  }, [contents, editor]);

  const openLinkByTitle = useCallback((title: string) => {
    const id = linkIndexRef.current?.byTitle.get(normTitle(title));   // the same normalization the index uses (brackets and pipes are neutral)
    const target = id ? docsRef.current.find((doc) => doc.id === id) : undefined;
    if (target) { setNoteView(target.deletedAt ? "trash" : target.archived ? "archive" : "folder"); setFolder(target.folder); setTagFilter(null); selectDocument(target); return; }
    createNote(title.trim());
    setNotice(`Создана заметка «${title.trim()}» по ссылке`);
  }, [createNote, selectDocument]);
  openLinkRef.current = openLinkByTitle;
  const [linkPicker, setLinkPicker] = useState<null | { query: string; index: number }>(null);
  const pickerDocs = linkPicker
    ? docs.filter((doc) => !doc.deletedAt && doc.id !== activeId && doc.title.toLocaleLowerCase("ru").includes(linkPicker.query.trim().toLocaleLowerCase("ru"))).slice(0, 8)
    : [];
  const insertLink = useCallback((title: string) => {
    editor.insertInlineContent([{ type: "text", text: wikiLinkText(title), styles: {} }]);
    setLinkPicker(null);
    editor.focus();
  }, [editor]);

  const closeTab = useCallback(async (id: string) => {
    // save first: the host gets the latest text before the tab disappears
    sync.push({ docs: docsRef.current, contents: contentsRef.current, activeId: activeIdRef.current, folder, folders, parents, dark, tags });
    const result = await sync.flush();
    if (!result.ok) setNotice("Вкладка закрыта, но часть изменений не сохранена. Проверьте строку «Сохранено» и повторите.");
    const strip = openIdsRef.current.map((openId) => docsRef.current.find((doc) => doc.id === openId)).filter((doc): doc is DocItem => Boolean(doc) && inSection(doc as DocItem));
    const index = strip.findIndex((doc) => doc.id === id);
    setOpenIds((current) => current.filter((openId) => openId !== id));
    if (id !== activeIdRef.current) return;
    const next = strip[index + 1] ?? strip[index - 1];
    if (next) { selectDocument(next); return; }
    activeIdRef.current = null;
    setActiveId(null);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "Нет открытых заметок. Откройте заметку из списка или создайте новую кнопкой «+»." }]);
    setSavedAt("Все изменения сохранены");
  }, [dark, editor, folder, folders, parents, openIds, selectDocument, sync, tags, noteView]);

  closeTabRef.current = closeTab;

  // A renamed note keeps its incoming [[links]]: once the title has been stable for 1.5 s, links to the old title are rewritten in the other notes.
  const settledTitlesRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const settled = settledTitlesRef.current;
      const live = docsRef.current.filter((doc) => !doc.deletedAt);
      const updates: Record<string, PartialBlock[]> = {};
      let total = 0;
      for (const doc of live) {
        const before = settled.get(doc.id);
        settled.set(doc.id, doc.title);
        if (before === undefined || before === doc.title || !doc.title.trim()) continue;
        const oldKey = normTitle(before);
        // another note with the old title would make the links ambiguous: leave them alone
        if (live.some((other) => other.id !== doc.id && normTitle(other.title) === oldKey)) continue;
        for (const other of live) {
          if (other.id === doc.id || other.writeThrough) continue;     // never rewrite a real file on disk because of a link rename
          const blocks = (updates[other.id] ?? contentsRef.current[other.id]) as LooseBlock[] | undefined;
          if (!blocks || !linksOfBlocks(blocks).some((link) => normTitle(link.target) === oldKey)) continue;
          const renamed = renameLinkInBlocks(blocks, before, doc.title);
          if (renamed.count > 0) { updates[other.id] = renamed.blocks as unknown as PartialBlock[]; total += renamed.count; }
        }
      }
      if (total > 0) {
        setContents((current) => ({ ...current, ...updates }));
        setNotice(`Ссылки на переименованную заметку обновлены: ${total} в ${Object.keys(updates).length} заметках`);
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [docs]);
  addDocumentRef.current = addDocument;
  stepTabRef.current = (delta: number) => {
    if (openTabs.length < 2) return;
    const index = openTabs.findIndex((doc) => doc.id === activeId);
    selectDocument(openTabs[(index + delta + openTabs.length) % openTabs.length]);
  };
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [sourceIssue, setSourceIssue] = useState<Record<string, { status: string; message: string }>>({});
  const [conflictDialog, setConflictDialog] = useState<string | null>(null);
  useEffect(() => { if (activeId) document.getElementById(`note-tab-${activeId}`)?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [activeId, openIds.length]);

  const openDailyNote = useCallback(() => {
    const title = `Заметка за ${new Date().toLocaleDateString("ru-RU")}`;
    const existing = docsRef.current.find((doc) => doc.title === title && !doc.deletedAt);
    if (existing) { setNoteView(existing.archived ? "archive" : "folder"); setFolder(existing.folder); selectDocument(existing); } else createNote(title);
  }, [createNote, selectDocument]);

  const handleFolderSelect = useCallback((name: string) => {
    setNoteView("folder");
    setFolder(name);
    setSidebarCollapsed(window.matchMedia("(max-width: 760px)").matches);
    const scope = subNotes ? projectScope(name, parents) : new Set([name]);
    const firstNote = docs.find((doc) => scope.has(doc.folder) && !doc.archived && !doc.deletedAt);
    if (firstNote) {
      selectDocument(firstNote);
      return;
    }
    activeIdRef.current = null;
    setActiveId(null);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "Проект пока пуст. Создайте заметку кнопкой «Новая заметка»." }]);
    setSavedAt("Пустой проект");
  }, [docs, editor, parents, selectDocument, subNotes]);

  const addFolder = useCallback((parent?: string) => {
    setFormDialog(parent
      ? { kind: "folder", title: `Новый вложенный проект в «${parent}»`, value: "", hint: "Например, Клиенты", parent }
      : { kind: "folder", title: "Новый проект", value: "", hint: "Например, Проекты" });
  }, []);

  /** Nests a project in another one (parent "" = top level). Refuses a project inside itself or inside its own nested projects. */
  const moveProjectTo = useCallback((name: string, parent: string) => {
    if (name === parent || (parent && projectScope(name, parents).has(parent))) { setNotice("Проект нельзя вложить в самого себя или в свой вложенный проект"); return; }
    if ((parents[name] ?? "") === parent) return;
    setParents((current) => { const next = { ...current }; if (parent) next[name] = parent; else delete next[name]; return next; });
    if (parent) setClosedProjects((current) => current.filter((x) => x !== parent));
    setNotice(parent ? `Проект «${name}» вложен в «${parent}»` : `Проект «${name}» теперь на верхнем уровне`);
  }, [parents]);

  const moveActiveNote = useCallback(() => {
    if (!activeId || !activeDoc) return;
    setFormDialog({ kind: "move", title: `Переместить «${activeDoc.title}»`, value: activeDoc.folder, hint: `Доступные проекты: ${folders.join(", ")}` });
  }, [activeDoc, activeId, folders]);

  const switchToSpecialView = useCallback((view: "all" | "pinned" | "recent" | "archive" | "trash") => {
    setNoteView(view);
    setRailMenu(null);
    setSidebarCollapsed(window.matchMedia("(max-width: 760px)").matches);
    if (view === "trash") { setTrashPane(true); return; }   // the trash is a list in the main area; no note is opened behind it
    setTrashPane(false);
    const firstNote = (view === "all"
      ? docs.filter((doc) => !doc.deletedAt && !doc.archived).sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
      : view === "pinned"
      ? docs.filter((doc) => doc.pinned && !doc.deletedAt)
      : view === "recent"
        ? docs.filter((doc) => typeof doc.lastOpenedAt === "number" && !doc.deletedAt && !doc.archived).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
        : docs.filter((doc) => Boolean(doc.archived && !doc.deletedAt)))[0];
    if (firstNote) {
      selectDocument(firstNote);
      return;
    }
    activeIdRef.current = null;
    setActiveId(null);
    const emptyText = view === "archive" ? "В архиве пока нет заметок." : view === "pinned" ? "Закреплённых заметок пока нет." : "Недавно открытых заметок пока нет.";
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: emptyText }]);
    setSavedAt(view === "archive" ? "Архив" : view === "pinned" ? "Закреплённые" : "Недавние");
  }, [docs, editor, selectDocument]);

  const archiveActiveNote = useCallback(() => {
    if (!activeId || !activeDoc) return;
    const archived = !activeDoc.archived;
    setDocs((current) => current.map((doc) => doc.id === activeId ? { ...doc, archived } : doc));
    setNoteView(archived ? "archive" : "folder");
    setFolder(activeDoc.folder);
    setNotice(archived ? "Заметка перемещена в архив" : "Заметка возвращена в проект");
  }, [activeDoc, activeId]);

  const restoreDoc = useCallback((id: string) => {
    const doc = docsRef.current.find((item) => item.id === id);
    setDocs((current) => current.map((item) => item.id === id ? { ...item, deletedAt: undefined } : item));
    if (doc) selectDocument({ ...doc, deletedAt: undefined });   // the restored note opens again
    setToastAction(null);
    setNotice("Заметка восстановлена");
  }, [selectDocument]);

  /** Moves a note to the trash (it stays there until it is restored or deleted for good) and opens its neighbour instead. */
  // Escape closes the tab menu and the question
  useEffect(() => {
    if (!tabMenu && !confirmDialog) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setTabMenu(null); setConfirmDialog(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabMenu, confirmDialog]);

  const trashDoc = useCallback((id: string) => {
    const doc = docsRef.current.find((item) => item.id === id);
    if (!doc) return;
    const index = openTabs.findIndex((tab) => tab.id === id);
    const next = openTabs[index + 1] ?? openTabs[index - 1];
    setDocs((current) => current.map((item) => item.id === id ? { ...item, deletedAt: new Date().toISOString() } : item));
    if (activeIdRef.current === id) {
      if (next && next.id !== id) selectDocument(next);
      else { activeIdRef.current = null; setActiveId(null); editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "" }]); }
    }
    setNotice(`«${doc.title}» перемещена в корзину`);
    setToastAction({ label: "Отменить", run: () => restoreDoc(id) });
  }, [editor, openTabs, restoreDoc, selectDocument]);

  /** Asks first: nothing is moved to the trash without an answer. */
  const requestTrash = useCallback((id: string | null) => {
    const doc = id ? docsRef.current.find((item) => item.id === id) : undefined;
    if (!doc) return;
    setTabMenu(null);
    setConfirmDialog({ title: "Переместить в корзину?", message: `Заметка «${doc.title}» уйдёт в корзину. Вы можете восстановить её в течение 30 дней: из корзины или сразу по кнопке «Отменить».`, confirm: "В корзину", danger: true, run: () => trashDoc(id!) });
  }, [trashDoc]);

  const deleteActiveNote = useCallback(() => { requestTrash(activeId); }, [activeId, requestTrash]);

  const restoreActiveNote = useCallback(() => {
    if (!activeId || !activeDoc) return;
    setDocs((current) => current.map((doc) => doc.id === activeId ? { ...doc, deletedAt: undefined } : doc));
    setNoteView(activeDoc.archived ? "archive" : "folder");
    setFolder(activeDoc.folder);
    setNotice("Заметка восстановлена");
  }, [activeDoc, activeId]);

  const permanentlyDeleteActiveNote = useCallback(() => {
    if (!activeId || !activeDoc) return;
    const id = activeId, doc = activeDoc;
    const run = async () => {
      try {
        await sync.flush();
        await host.deleteNote(id);
        sync.forget(id);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Не удалось удалить заметку");
        return;
      }
      setDocs((current) => current.filter((item) => item.id !== id));
      setContents((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
      setTags((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
      setNoteView("folder");
      setFolder(doc.folder);
      const nextDoc = docs.find((item) => item.id !== id && !item.archived && !item.deletedAt && item.folder === doc.folder);
      if (nextDoc) {
        activeIdRef.current = nextDoc.id;
        setActiveId(nextDoc.id);
        editor.replaceBlocks(editor.document, contents[nextDoc.id] ?? sampleContent(nextDoc.title));
      } else {
        activeIdRef.current = null;
        setActiveId(null);
        editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "Проект пока пуст. Создайте заметку кнопкой «Новая заметка»." }]);
      }
      setNotice("Заметка удалена навсегда");
    };
    setConfirmDialog({ title: "Удалить навсегда?", message: `Заметка «${doc.title}» будет удалена без возможности восстановления.`, confirm: "Удалить навсегда", danger: true, run: () => { void run(); } });
  }, [activeDoc, activeId, contents, docs, editor, sync]);

  /** Removes notes for good: the file on disk first, then the screen state. Returns how many were removed. */
  const deleteForever = useCallback(async (ids: string[]): Promise<number> => {
    const done: string[] = [];
    await sync.flush();
    for (const id of ids) {
      try { await host.deleteNote(id); sync.forget(id); done.push(id); } catch { /* the note stays in the trash and is tried again next time */ }
    }
    if (done.length === 0) return 0;
    const gone = new Set(done);
    setDocs((current) => current.filter((item) => !gone.has(item.id)));
    setContents((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !gone.has(key))));
    setTags((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !gone.has(key))));
    return done.length;
  }, [sync]);

  const emptyTrash = useCallback(() => {
    const ids = docs.filter((doc) => doc.deletedAt).map((doc) => doc.id);
    if (ids.length === 0) { setNotice("Корзина пуста"); return; }
    setConfirmDialog({ title: "Очистить корзину?", message: `Заметок в корзине: ${ids.length}. Они будут удалены навсегда, вернуть их будет нельзя.`, confirm: "Очистить корзину", danger: true, run: () => { void deleteForever(ids).then((n) => { if (activeIdRef.current && ids.includes(activeIdRef.current)) { activeIdRef.current = null; setActiveId(null); } setNotice(`Удалено навсегда: ${n}`); }); } });
  }, [deleteForever, docs]);

  /** Restores a note from its row in the trash without leaving the list; "Отменить" puts it back. */
  const restoreFromTrash = useCallback((id: string) => {
    const doc = docsRef.current.find((item) => item.id === id);
    if (!doc) return;
    setDocs((current) => current.map((item) => item.id === id ? { ...item, deletedAt: undefined } : item));
    setNotice(`«${doc.title}» восстановлена`);
    setToastAction({ label: "Отменить", run: () => setDocs((current) => current.map((item) => item.id === id ? { ...item, deletedAt: new Date().toISOString() } : item)) });
  }, []);

  const deleteOneForever = useCallback((id: string) => {
    const doc = docsRef.current.find((item) => item.id === id);
    if (!doc) return;
    setConfirmDialog({ title: "Удалить навсегда?", message: `Заметка «${doc.title}» будет удалена без возможности восстановления.`, confirm: "Удалить навсегда", danger: true, run: () => { void deleteForever([id]).then((n) => setNotice(n ? "Заметка удалена навсегда" : "Не удалось удалить заметку")); } });
  }, [deleteForever]);

  // Notes stay in the trash for 30 days, then go for good (checked once after the library is loaded).
  const trashPurgedRef = useRef(false);
  useEffect(() => {
    if (trashPurgedRef.current || !isHosted() || docs.length === 0) return;
    trashPurgedRef.current = true;
    const limit = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const old = docs.filter((doc) => doc.deletedAt && Date.parse(String(doc.deletedAt)) < limit).map((doc) => doc.id);
    if (old.length) void deleteForever(old).then((n) => { if (n) setNotice(`Из корзины удалено старых заметок (больше 30 дней): ${n}`); });
  }, [deleteForever, docs]);

  const duplicateActiveNote = useCallback(() => {
    if (!activeId || !activeDoc) return;
    const duplicateId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const title = `${activeDoc.title} — копия`;
    const clonedBlocks = structuredClone(contents[activeId] ?? []);
    const headingIndex = clonedBlocks.findIndex((block) => block.type === "heading");
    if (headingIndex >= 0) clonedBlocks[headingIndex] = { ...clonedBlocks[headingIndex], content: title } as PartialBlock;
    else clonedBlocks.unshift({ type: "heading", props: { level: 1 }, content: title });
    setDocs((current) => [...current, { ...activeDoc, sourcePath: undefined, writeThrough: undefined, readOnly: undefined, id: duplicateId, title, updated: "только что", archived: false, deletedAt: undefined, pinned: false, lastOpenedAt: Date.now(), legacyGuid: undefined }]);
    setContents((current) => ({ ...current, [duplicateId]: clonedBlocks }));
    if (tags[activeId]) setTags((current) => ({ ...current, [duplicateId]: tags[activeId] }));
    activeIdRef.current = duplicateId;
    setActiveId(duplicateId);
    setFolder(activeDoc.folder);
    setNoteView("folder");
    editor.replaceBlocks(editor.document, clonedBlocks);
    setNotice("Копия заметки создана");
  }, [activeDoc, activeId, contents, editor, tags]);

  const togglePinActiveNote = useCallback(() => {
    if (!activeId || !activeDoc || activeDoc.deletedAt) return;
    const pinned = !activeDoc.pinned;
    setDocs((current) => current.map((doc) => doc.id === activeId ? { ...doc, pinned } : doc));
    setNotice(pinned ? "Заметка закреплена в библиотеке" : "Заметка откреплена");
  }, [activeDoc, activeId]);

  const submitFormDialog = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!formDialog) return;
    const value = formDialog.value.trim();
    if (!value) return;
    if (formDialog.kind === "folder") {
      if (folders.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) {
        setNotice("Проект с таким названием уже есть");
        return;
      }
      setFolders((current) => [...current, value]);
      if (formDialog.parent) { setParents((current) => ({ ...current, [value]: formDialog.parent! })); setClosedProjects((current) => current.filter((x) => x !== formDialog.parent)); }
      handleFolderSelect(value);
      setNotice(`Проект «${value}» создан`);
    } else if (formDialog.kind === "rename") {
      if (!activeId) return;
      setDocs((current) => current.map((doc) => doc.id === activeId ? { ...doc, title: value, updated: "только что" } : doc));
      const titleBlock = editor.document.find((block) => block.type === "heading");
      if (titleBlock) editor.updateBlock(titleBlock.id, { content: value });
      setNotice("Название заметки изменено");
    } else if (formDialog.kind === "move") {
      if (!folders.includes(value)) {
        setNotice("Выберите проект из списка");
        return;
      }
      if (activeId) setDocs((current) => current.map((doc) => doc.id === activeId ? { ...doc, folder: value } : doc));
      setFolder(value);
      setNotice(`Заметка перемещена в «${value}»`);
    } else if (activeId) {
      const cleaned = parseTags(value).join(", ");
      setTags((current) => cleaned ? { ...current, [activeId]: cleaned } : Object.fromEntries(Object.entries(current).filter(([id]) => id !== activeId)));
      setNotice("Метка обновлена");
    }
    setFormDialog(null);
  }, [activeId, editor, formDialog, folders, handleFolderSelect]);

  const saveDocument = useCallback(() => {
    if (!activeId) return;
    const nextContents = { ...contents, [activeId]: editor.document };
    setContents(nextContents);
    sync.push({ docs, contents: nextContents, activeId, folder, folders, parents, dark, tags });
    void sync.flush();
  }, [activeId, contents, dark, docs, editor, folder, folders, parents, tags, sync]);

  const requestAiTask = useCallback(async (operation: AiOperation, override?: { scope?: AiScope; instruction?: string; insightTitle?: string }) => {
    const scope = override?.scope ?? aiScope;
    const instruction = override?.instruction ?? aiInstruction;
    if (!activeId || !activeDoc || !aiModel || !selectedModel) {
      setAiError("Выберите заметку и доступную AI-модель.");
      return;
    }
    if (aiProvider === "ollama" && !aiProviders?.ollama.configured) {
      setAiError("Локальный Ollama недоступен. Запустите сервис и установите модель.");
      return;
    }
    if (aiProvider === "openrouter" && !aiProviders?.openrouter.configured) {
      setAiError(isHosted() ? "OpenRouter не настроен. Сохраните ключ в настройках AI." : "OpenRouter не настроен на сервере. Добавьте ключ в .env.local.");
      return;
    }
    if (aiProvider === "compat" && !aiProviders?.compat?.configured) {
      setAiError("Внешний сервис не настроен: выберите его в настройках AI и сохраните адрес и ключ.");
      return;
    }
    if (aiProvider !== "ollama" && !(aiProvider === "compat" && aiProviders?.compat?.local && !cloudModelName(aiModel)) && !aiRemoteConsent) {
      setAiError("Подтвердите передачу текста выбранному внешнему провайдеру.");
      return;
    }
    if (operation === "custom" && (!instruction.trim() || instruction.length > MAX_INSTRUCTION)) {
      setAiError("Введите свою инструкцию длиной от 1 до 1000 символов.");
      return;
    }
    if ((operation === "structure" && scope !== "note") || (operation === "analyze" && scope !== "note" && scope !== "linked")) {
      setAiError("Для этой операции выберите контекст «Вся заметка» и проверьте отправляемый фрагмент.");
      return;
    }
    if (scope === "linked" && !["analyze", "summarize", "custom"].includes(operation)) {
      setAiError("Для связанных заметок доступны анализ, резюме и свой вопрос: правки текста здесь не применяются.");
      return;
    }

    const liveSelection = editor.prosemirrorView.state.selection;
    const selectedText = editor.getSelectedText();
    const cursorBlock = editor.getTextCursorPosition().block;
    const paragraphText = blockText(cursorBlock.content);
    const currentDocument = editor.document;
    const sourceText = scope === "selection"
      ? selectedText
      : scope === "paragraph"
        ? paragraphText
        : currentDocument.map((block) => blockToText(block)).filter((text) => text.trim()).join("\n\n");
    if (!sourceText.trim()) {
      setAiError(scope === "selection" ? "Выделите фрагмент в заметке или выберите область «Абзац»." : "В этой области пока нет текста.");
      return;
    }
    if (scope === "selection" && liveSelection.empty) {
      setAiError("Выделение изменилось. Выделите текст ещё раз.");
      return;
    }

    const wholeNote = scope === "note" || scope === "linked";
    const noteCitations: AiCitation[] = wholeNote
      ? currentDocument.flatMap((block, index) => {
        const text = blockToText(block);
        return text.trim() ? [{ marker: `B${index + 1}`, blockId: block.id, label: text.slice(0, 70) || `Блок ${index + 1}` }] : [];
      })
      : [{ marker: "B1", blockId: cursorBlock.id, label: paragraphText.slice(0, 70) || "Текущий абзац" }];
    const noteContext = wholeNote
      ? noteCitations.map((citation) => {
        const block = currentDocument.find((item) => item.id === citation.blockId);
        return `[${citation.marker}] ${block ? blockToText(block) : ""}`;
      }).join("\n\n")
      : `[B1] ${sourceText}`;
    const linkedPart = scope === "linked" ? buildLinkedEntries(currentDocument.length + 1, 22_000 - noteContext.length) : { entries: [], titles: [] as string[] };
    const citations: AiCitation[] = [...noteCitations, ...linkedPart.entries.map((item) => ({ marker: item.marker, blockId: item.blockId, label: item.label }))];
    const contextText = linkedPart.entries.length ? [noteContext, ...linkedPart.entries.map((item) => `[${item.marker}] ${item.text}`)].join("\n\n") : noteContext;
    if (aiProvider !== "ollama" && !(aiProvider === "compat" && aiProviders?.compat?.local) && linkedPart.titles.length
      && !window.confirm(`Во внешний сервис будут отправлены тексты связанных заметок:\n• ${linkedPart.titles.join("\n• ")}\nОтправить?`)) return;
    const sourceFingerprint = scope === "selection"
      ? JSON.stringify({ noteId: activeId, from: liveSelection.from, to: liveSelection.to, text: selectedText })
      : scope === "paragraph"
        ? JSON.stringify({ noteId: activeId, block: cursorBlock })
        : JSON.stringify({ noteId: activeId, blocks: currentDocument });
    const maxOutputTokens = outputTokensFor(operation, contextText.length);
    const cost = selectedModel.free ? 0 : estimateAiCost(maxOutputTokens);
    if (aiProvider === "openrouter" && cost === null) {
      setAiError("Цены этой модели неизвестны; платный запрос заблокирован.");
      return;
    }
    if (aiProvider === "openrouter" && !selectedModel.free && !isHosted()   // in the desktop app the host shows its own confirmation
      && !window.confirm(`Разрешить этот платный запрос к ${selectedModel.name}?\nМаксимальная оценка: $${(cost ?? 0).toFixed(6)}.`)) return;

    const controller = new AbortController();
    aiAbortControllerRef.current?.abort();
    aiAbortControllerRef.current = controller;
    const startedAt = performance.now();
    const elapsedTimer = window.setInterval(() => setAiElapsedMs(performance.now() - startedAt), 250);
    let generated = "";
    setAiPending(true);
    setAiError("");
    setAiProposal(null);
    setAiStreamText("");
    setAiFirstTokenMs(null);
    setAiElapsedMs(0);
    try {
      const result = await streamAiTask({
        provider: aiProvider,
        model: aiModel,
        operation,
        scope: scope,
        contextText,
        noteTitle: activeDoc.title,
        ...(operation === "custom" ? { instruction: instruction.trim() } : {}),
        ...(aiWritingRule.trim() ? { styleGuidance: aiWritingRule.trim() } : {}),
        ...(aiProvider !== "ollama" ? { remoteConsent: aiRemoteConsent, costConfirmed: true, localService: aiProvider === "compat" && Boolean(aiProviders?.compat?.local) && !cloudModelName(aiModel) } : {}),
        maxOutputTokens,
      }, {
        signal: controller.signal,
        onDelta: (delta) => {
          generated += delta;
          setAiStreamText((current) => current + delta);
        },
        onFirstToken: setAiFirstTokenMs,
      });
      if (activeIdRef.current !== activeId) {
        setAiError("Во время обработки открылась другая заметка. Результат не применён.");
        return;
      }
      if (!generated.trim()) throw new Error("Модель вернула пустой ответ.");
      const cleaned = operation === "analyze" ? { text: generated.trim(), notes: [] as string[] } : cleanModelText(generated, sourceText);
      if (!cleaned.text) throw new Error("Модель вернула пустой ответ.");
      setAiProposal({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        noteId: activeId,
        operation,
        provider: aiProvider,
        model: result.model,
        scope: scope,
        sourceText,
        proposedText: cleaned.text,
        sourceFingerprint,
        ...(scope === "selection" ? { selectionFrom: liveSelection.from, selectionTo: liveSelection.to } : {}),
        ...(scope === "paragraph" ? { sourceBlockId: cursorBlock.id } : {}),
        citations,
        elapsedMs: result.elapsedMs,
        firstTokenMs: result.firstTokenMs,
        ...(result.truncated ? { truncated: true } : {}),
        ...(override?.insightTitle ? { insightTitle: override.insightTitle } : {}),
        checks: operation === "analyze" || operation === "summarize" || override?.insightTitle ? [] : checkProposal(operation, sourceText, cleaned.text),
        ...(cleaned.notes.length ? { cleaned: cleaned.notes } : {}),
      });
      setAiElapsedMs(result.elapsedMs);
    } catch (error) {
      setAiError(controller.signal.aborted ? "AI-запрос отменён." : error instanceof Error ? error.message : "Не удалось выполнить AI-запрос.");
    } finally {
      window.clearInterval(elapsedTimer);
      if (aiAbortControllerRef.current === controller) aiAbortControllerRef.current = null;
      setAiPending(false);
    }
  }, [activeDoc, activeId, aiContextText, linkedDocs, contents, aiInstruction, aiModel, aiProvider, aiProviders, aiRemoteConsent, aiScope, aiWritingRule, editor, estimatedAiCost, selectedModel]);

  const cancelAiTask = useCallback(() => {
    aiAbortControllerRef.current?.abort();
  }, []);

  /** Adds one insight at the end of the open note. The group heading is written once; the original text is never touched. */
  const appendInsight = useCallback((title: string, body: string, model: string) => {
    const hasGroup = editor.document.some((block) => block.type === "heading" && blockText(block.content).trim() === INSIGHTS_HEADING);
    const blocks = parseAiBlocks((markdown) => editor.tryParseMarkdownToBlocks(markdown), insightMarkdown(title, body, model, new Date(), !hasGroup));
    if (blocks.length) editor.insertBlocks(blocks, editor.document[editor.document.length - 1], "after");
    return blocks.length > 0;
  }, [editor]);

  const acceptAiProposal = useCallback(() => {
    if (!aiProposal || aiProposal.noteId !== activeId) {
      setAiError("Предложение больше не относится к открытой заметке.");
      return;
    }
    if (aiProposal.truncated) {
      setAiError("Ответ модели оборван на лимите длины: он неполный и не применяется. Сократите область или повторите запрос.");
      return;
    }
    if (aiProposal.insightTitle) {
      if (!appendInsight(aiProposal.insightTitle, aiProposal.operation === "analyze" ? analysisBody(aiProposal) : aiProposal.proposedText, aiProposal.model)) { setAiError("Не удалось вставить инсайт."); return; }
      setAiProposal(null);
      setAiError("");
      window.setTimeout(() => { editor.focus(); saveDocument(); }, 0);
      setNotice("Инсайт добавлен в конец заметки · отменить: Ctrl+Z");
      return;
    }
    if (aiProposal.scope === "linked") {
      setAiError("Результат по связанным заметкам только для чтения: в текст он не вставляется.");
      return;
    }
    const liveSelection = editor.prosemirrorView.state.selection;
    let replacement: PartialBlock[] | undefined;
    if (aiProposal.scope === "selection") {
      if (liveSelection.from !== aiProposal.selectionFrom || liveSelection.to !== aiProposal.selectionTo
        || editor.getSelectedText() !== aiProposal.sourceText) {
        setAiError("Выделение изменилось после генерации. Предложение устарело и не применено.");
        return;
      }
    } else if (aiProposal.scope === "paragraph") {
      const block = aiProposal.sourceBlockId ? editor.getBlock(aiProposal.sourceBlockId) : undefined;
      const currentFingerprint = block ? JSON.stringify({ noteId: activeId, block }) : "";
      if (!block || blockText(block.content) !== aiProposal.sourceText || currentFingerprint !== aiProposal.sourceFingerprint) {
        setAiError("Исходный абзац изменился. Предложение устарело и не применено.");
        return;
      }
    } else {
      const currentFingerprint = JSON.stringify({ noteId: activeId, blocks: editor.document });
      if (currentFingerprint !== aiProposal.sourceFingerprint) {
        setAiError("Заметка изменилась. Предложение устарело и не применено.");
        return;
      }
      replacement = parseAiBlocks((markdown) => editor.tryParseMarkdownToBlocks(markdown), aiProposal.proposedText);
      if (replacement.length === 0) {
        setAiError("Не удалось разобрать предложенную структуру заметки.");
        return;
      }
    }
    // Formatting from the model (headings, lists, bold, links) is applied as formatting, not as typed characters.
    const richBlocks = aiProposal.scope === "paragraph" && /(^|\n)\s{0,3}(#{1,6}|[-*+•]|\d+[.)])\s/.test(aiProposal.proposedText)
      ? parseAiBlocks((markdown) => editor.tryParseMarkdownToBlocks(markdown), aiProposal.proposedText) : [];
    editor.transact((tr) => {
      if (aiProposal.scope === "selection") {
        editor.insertInlineContent(toInlineContent(aiProposal.proposedText.replace(/\r?\n/g, " ")) as never);
      } else if (aiProposal.scope === "paragraph") {
        if (richBlocks.length > 0) editor.replaceBlocks([aiProposal.sourceBlockId!], richBlocks);
        else editor.updateBlock(aiProposal.sourceBlockId!, { content: toInlineContent(aiProposal.proposedText.replace(/\r?\n/g, " ")) as never });
      } else if (replacement) {
        editor.replaceBlocks(editor.document, replacement);
      }
      tr.setMeta("addToHistory", true);
    });
    setAiProposal(null);
    setAiError("");
    window.setTimeout(() => {
      const signature = JSON.stringify(editor.document);
      aiAcceptedSignatureRef.current = signature;
      setCanUndoAi(true);
      editor.focus();   // so Ctrl+Z right after "Apply" undoes the change instead of going nowhere
      saveDocument();
    }, 0);
    setNotice("AI-изменение применено · можно отменить кнопкой или Ctrl+Z");
  }, [activeId, aiProposal, appendInsight, editor, saveDocument]);

  const undoAcceptedAi = useCallback(() => {
    if (!aiAcceptedSignatureRef.current || JSON.stringify(editor.document) !== aiAcceptedSignatureRef.current) {
      setCanUndoAi(false);
      setNotice("После AI-изменения были новые правки — используйте обычный Ctrl+Z.");
      return;
    }
    if (editor.undo()) {
      aiAcceptedSignatureRef.current = null;
      setCanUndoAi(false);
      window.setTimeout(saveDocument, 0);
      setNotice("Последнее AI-изменение отменено");
    } else {
      setCanUndoAi(false);
      setNotice("Редактор не смог отменить последнее изменение.");
    }
  }, [editor, saveDocument]);

  const undoEdit = useCallback(() => { editor.focus(); if (!editor.undo()) setNotice("Нечего отменять"); }, [editor]);
  const redoEdit = useCallback(() => { editor.focus(); if (!editor.redo()) setNotice("Нечего повторять"); }, [editor]);

  /** The structured analysis as the body of one insight: bold labels and bullet lists. */
  const analysisBody = useCallback((proposal: AiProposal) => {
    const parsed = parseAiAnalysis(proposal.proposedText, proposal.citations);
    if (!parsed) return proposal.proposedText;
    const sections: Array<[keyof typeof parsed, string]> = [["summary", "Краткий вывод"], ["keyFacts", "Ключевые факты"], ["decisions", "Решения"], ["actionItems", "Действия"], ["risks", "Риски"], ["openQuestions", "Открытые вопросы"]];
    const lines: string[] = [];
    for (const [key, label] of sections) {
      const items = parsed[key];
      if (!items.length) continue;
      lines.push(`**${label}**`, "");
      for (const item of items) lines.push(`- ${item.text}${item.owner ? ` (${item.owner}${item.dueDate ? `, до ${item.dueDate}` : ""})` : ""}`);
      lines.push("");
    }
    return lines.join("\n").trim();
  }, []);


  // ---- two notes on the screen -----------------------------------------------------------------------------------------------

  useEffect(() => {
    if (!secondId) return;
    if (secondId === activeId) { setSecondId(null); return; }
    const blocks = contentsRef.current[secondId] ?? [{ type: "paragraph", content: "" }];
    secondLoadingRef.current = true;
    editor2.replaceBlocks(editor2.document, blocks as PartialBlock[]);
    window.setTimeout(() => { secondLoadingRef.current = false; }, 50);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondId, activeId]);

  // a note that is trashed or deleted leaves the right side
  useEffect(() => {
    if (secondId && !docs.some((doc) => doc.id === secondId && !doc.deletedAt)) setSecondId(null);
  }, [docs, secondId]);

  const handleSecondChange = useCallback(() => {
    if (!secondId || secondLoadingRef.current) return;
    const blocks = editor2.document;
    const heading = blocks.find((block) => block.type === "heading");
    const content = heading?.content;
    const title = (typeof content === "string" ? content : Array.isArray(content) ? content.map((item) => (typeof item === "object" && item !== null && "text" in item ? String(item.text) : "")).join("") : "").trim();
    setContents((current) => ({ ...current, [secondId]: blocks }));
    setDocs((current) => current.map((doc) => doc.id === secondId ? { ...doc, ...(title ? { title } : {}), updated: "только что" } : doc));
    setSavedAt("Сохраняем локально…");
  }, [editor2, secondId]);

  /** Selected blocks, or the selected text as a paragraph, copied (not moved) into the other note after its cursor or at its end. */
  const moveSelection = useCallback((from: "left" | "right") => {
    const source = from === "left" ? editor : editor2;
    const target = from === "left" ? editor2 : editor;
    const strip = (block: unknown): PartialBlock => {
      const { id: _id, children, ...rest } = structuredClone(block) as { id?: string; children?: unknown[] } & Record<string, unknown>;
      return { ...rest, ...(Array.isArray(children) && children.length ? { children: children.map(strip) } : {}) } as PartialBlock;
    };
    const selection = source.getSelection();
    let blocks: PartialBlock[] = [];
    if (selection && (selection.blocks.length > 1 || selection.blocks[0]?.type === "image")) blocks = selection.blocks.map(strip);
    else {
      const text = source.getSelectedText().trim();
      if (text) blocks = [{ type: "paragraph", content: text }];
    }
    if (blocks.length === 0) { setNotice("Выделите текст или несколько блоков в " + (from === "left" ? "левой" : "правой") + " заметке."); return; }
    const anchor = (() => { try { return target.getTextCursorPosition().block; } catch { return target.document[target.document.length - 1]; } })();
    target.insertBlocks(blocks, anchor, "after");
    window.setTimeout(() => { if (from === "left") handleSecondChange(); else saveDocument(); }, 0);
    setNotice(`Скопировано в ${from === "left" ? "правую" : "левую"} заметку: ${blocks.length} ${blocks.length === 1 ? "фрагмент" : "фрагм."} · отменить: Ctrl+Z там`);
  }, [editor, editor2, handleSecondChange, saveDocument]);

  const appendParagraph = useCallback((text: string, to: "left" | "right") => {
    const target = to === "left" ? editor : editor2;
    target.insertBlocks([{ type: "paragraph", content: text }], target.document[target.document.length - 1], "after");
    window.setTimeout(() => { if (to === "left") saveDocument(); else handleSecondChange(); }, 0);
    setNotice(`Абзац добавлен в конец ${to === "left" ? "левой" : "правой"} заметки`);
  }, [editor, editor2, handleSecondChange, saveDocument]);

  const swapNotes = useCallback(() => {
    if (!secondId || !activeId) return;
    const right = docsRef.current.find((doc) => doc.id === secondId);
    const leftId = activeId;
    if (!right) return;
    selectDocument(right);
    window.setTimeout(() => setSecondId(leftId), 0);
  }, [activeId, secondId, selectDocument]);

  /** A note that only says "this file is not loaded into the editor" cannot be edited: it is never offered as a side of the two-note view. */
  const isPlaceholderNote = (id: string) => (contentsRef.current[id] ?? []).some((block) => /^Этот файл не загружен в редактор/.test(blockText((block as { content?: unknown }).content).trim()));
  const splitCandidates = () => docs.filter((doc) => !doc.deletedAt && !isPlaceholderNote(doc.id));

  const paragraphsOf = (blocks: readonly { type: string; content?: unknown }[]) => blocks.filter((block) => ["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "quote"].includes(block.type)).map((block) => blockText(block.content).trim()).filter(Boolean);

  /** The deterministic, safe formatting (no model): typography, long paragraphs, clear lists and headings. One undo step. */
  const applySafeFormat = useCallback((prefix = "") => {
    const { blocks, report } = autoFormat(editor.document as unknown as AfBlock[]);
    const total = Object.entries(report).reduce((sum, [key, value]) => sum + (key === "letterParts" || key === "technical" ? 0 : value), 0);
    if (total === 0) { setNotice(prefix + describeReport(report)); return false; }
    editor.replaceBlocks(editor.document, blocks as unknown as PartialBlock[]);
    editor.focus();   // so Ctrl+Z right after the layout undoes it in one step
    window.setTimeout(saveDocument, 0);
    setNotice(prefix + describeReport(report) + " · отменить: Ctrl+Z");
    return true;
  }, [editor, saveDocument]);

  /** Pictures that still point at a web address: stored through the host when the page answers, otherwise replaced by their caption (a broken picture is worse than none). */
  const repairRemoteImages = useCallback(async (): Promise<{ fixed: number; removed: number }> => {
    const remote: { id: string; url: string; caption: string }[] = [];
    const walk = (blocks: readonly { id: string; type: string; props?: unknown; children?: unknown }[]) => {
      for (const block of blocks) {
        const props = (block.props ?? {}) as { url?: string; caption?: string; name?: string };
        if (block.type === "image" && /^https?:\/\//i.test(props.url ?? "")) remote.push({ id: block.id, url: props.url!, caption: (props.caption || "").trim() });
        if (Array.isArray(block.children)) walk(block.children as never);
      }
    };
    walk(editor.document as never);
    let fixed = 0, removed = 0;
    for (const image of remote.slice(0, 20)) {
      try {
        const saved = await host.fetchImage(image.url);
        editor.updateBlock(image.id, { props: { url: `https://assets.notepadhub.local/${saved.file}` } } as never);
        fixed += 1;
      } catch {
        removed += 1;   // the picture stays where it is: a failed download (no network, a busy server) must never delete the owner's content
      }
    }
    return { fixed, removed };
  }, [editor]);

  const hasRemoteImages = () => { const walk = (blocks: readonly { type: string; props?: unknown; children?: unknown }[]): boolean => blocks.some((block) => (block.type === "image" && /^https?:\/\//i.test(String((block.props as { url?: string } | undefined)?.url ?? ""))) || (Array.isArray(block.children) && walk(block.children as never))); return walk(editor.document as never); };

  /** Autoformat: the model lays the note out like a good assistant answer; the result is accepted only if every word is still there. */
  const runAutoFormat = useCallback(() => {
    if (!activeId || formatJob) return;
    if (isHosted() && hasRemoteImages()) {
      const id = activeId;
      setNotice("Загружаю картинки со страниц…");
      void repairRemoteImages().then((result) => { if (activeIdRef.current === id) { setNotice(`Картинки: загружено ${result.fixed}${result.removed ? `, не удалось загрузить ${result.removed} (оставлены как есть)` : ""}.`); window.setTimeout(() => runAutoFormatCoreRef.current(), 0); } });
      return;
    }
    runAutoFormatCore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, formatJob, repairRemoteImages]);

  const runAutoFormatCoreRef = useRef<() => void>(() => undefined);
  const runAutoFormatCore = useCallback(() => {
    if (!activeId || formatJob) return;
    const text = noteAsMarkdown(editor.document);
    if (!text.trim()) { setNotice("В заметке пока нет текста."); return; }
    const aiReady = aiProvider === "ollama" || aiRemoteConsent || (aiProvider === "compat" && Boolean(aiProviders?.compat?.local));
    if (!aiReady || text.length > 12000) { applySafeFormat(aiReady ? "Заметка длинная для ИИ. " : "ИИ-оформление выключено (нет согласия на отправку). "); return; }
    setNotice("ИИ оформляет заметку…");
    setFormatJob({ id: activeId, stage: "wait" });
  }, [activeId, aiProvider, aiProviders, aiRemoteConsent, applySafeFormat, editor, formatJob]);
  runAutoFormatCoreRef.current = runAutoFormatCore;

  useEffect(() => {
    if (!formatJob || formatJob.stage !== "wait") return;
    const fallback = (why: string) => { setFormatJob(null); if (activeIdRef.current === formatJob.id) applySafeFormat(why + " "); };
    if (!selectedModel) {
      if (aiModelsError || (aiProviders && aiProvider === "compat" && !aiProviders.compat?.configured)) { fallback("ИИ недоступен."); return; }
      const timer = window.setTimeout(() => fallback("ИИ не ответил."), 30000);
      return () => window.clearTimeout(timer);
    }
    const controller = new AbortController();
    formatAbortRef.current = controller;
    setFormatJob({ id: formatJob.id, stage: "work" });
    const source = noteAsMarkdown(editor.document);
    let answer = "";
    streamAiTask({
      provider: aiProvider, model: aiModel, operation: "structure", scope: "note", contextText: source, noteTitle: activeDoc?.title ?? "",
      ...(aiProvider !== "ollama" ? { remoteConsent: aiRemoteConsent, costConfirmed: true, localService: aiProvider === "compat" && Boolean(aiProviders?.compat?.local) && !cloudModelName(aiModel) } : {}),
    }, { signal: controller.signal, onDelta: (delta) => { answer += delta; } }).then((result) => {
      if (controller.signal.aborted) return;
      setFormatJob(null);
      if (activeIdRef.current !== formatJob.id) return;
      const now = noteAsMarkdown(editor.document);
      if (now !== source) { setNotice("Заметка изменилась во время оформления: результат не применён."); return; }
      const verdict = result.truncated ? { ok: false, reason: "ответ оборван" } : isFormattingOnly(source, answer);
      if (verdict.ok) {
        const blocks = parseAiBlocks((markdown) => editor.tryParseMarkdownToBlocks(markdown), answer.trim());
        if (blocks.length > 0) {
          // the model lays out the structure, the fixed rules finish it: no empty lines, typography, pictures, letter parts
          const polished = autoFormat(blocks as unknown as AfBlock[]).blocks as unknown as PartialBlock[];
          editor.replaceBlocks(editor.document, polished.length > 0 ? polished : blocks);
          editor.focus();
          window.setTimeout(saveDocument, 0);
          setNotice(`Оформлено ИИ (${aiProvider === "compat" ? aiProviders?.compat?.name ?? "сервис" : aiModel}) · слова сохранены · отменить: Ctrl+Z`);
          return;
        }
      }
      applySafeFormat(`ИИ ${verdict.ok ? "вернул пустой ответ" : verdict.reason}: оставлено безопасное оформление. `);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setFormatJob(null);
      if (activeIdRef.current === formatJob.id) applySafeFormat(`ИИ недоступен (${error instanceof Error ? error.message.slice(0, 80) : "ошибка"}). `);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatJob?.stage, selectedModel, aiModelsError]);

  useEffect(() => { if (formatJob === null) formatAbortRef.current?.abort(); }, [formatJob === null]);

  const noteImages = (): NoteImage[] => {
    const out: NoteImage[] = [];
    const walk = (blocks: readonly { id: string; type: string; props?: unknown; children?: unknown }[]) => {
      for (const block of blocks) {
        const props = (block.props ?? {}) as { url?: string; caption?: string };
        if (block.type === "image" && props.url) out.push({ id: block.id, url: props.url, caption: props.caption ?? "" });
        if (Array.isArray(block.children)) walk(block.children as never);
      }
    };
    walk(editor.document as never);
    return out;
  };

  const openImageDialog = useCallback((kind: "generate" | "edit", prompt?: string) => {
    if (!isHosted()) { setNotice("Работа с изображениями доступна в настольной программе."); return; }
    let startId: string | undefined;
    try { const here = editor.getTextCursorPosition().block; if (here.type === "image") startId = here.id; } catch { /* no cursor */ }
    const note = editor.document.map((block) => blockText(block.content)).filter((t) => t.trim()).join(" ").replace(/\s+/g, " ").slice(0, 400);
    setImageDialog({ kind, selection: editor.getSelectedText(), note, startId, ...(prompt ? { prompt } : {}) });
  }, [editor]);

  const insertGeneratedImage = useCallback((url: string, caption: string) => {
    const anchor = (() => { try { return editor.getTextCursorPosition().block; } catch { return editor.document[editor.document.length - 1]; } })();
    editor.insertBlocks([{ type: "image", props: { url, caption, name: "image" } } as never], anchor, "after");
    window.setTimeout(saveDocument, 0);
    setNotice("Изображение вставлено · отменить: Ctrl+Z");
  }, [editor, saveDocument]);

  const replaceImage = useCallback((id: string, url: string) => {
    editor.updateBlock(id, { props: { url } } as never);
    window.setTimeout(saveDocument, 0);
    setNotice("Изображение изменено · отменить: Ctrl+Z");
  }, [editor, saveDocument]);

  /** Title and tags from the content: instant suggestion by words, then the local model improves it. */
  const openMetaDialog = useCallback(() => {
    if (!activeId) return;
    const parts = editor.document.map((block) => ({ heading: block.type === "heading", text: blockText(block.content) }));
    const text = parts.map((part) => part.text).join("\n");
    if (!text.trim()) { setNotice("В заметке пока нет текста: подбирать название не из чего."); return; }
    setMetaDialog({ title: suggestTitle(parts), tags: suggestTags(text).join(", "), ai: "wait", note: "Подобрано по словам заметки. ИИ уточняет…" });
  }, [activeId, editor]);

  useEffect(() => {
    if (!metaDialog || metaDialog.ai !== "wait" || !activeId) return;
    const off = (note: string) => setMetaDialog((current) => current ? { ...current, ai: "off", note } : current);
    if (aiProvider !== "ollama") { off("Подобрано по словам: умный подбор работает на локальной модели."); return; }
    if (!selectedModel) {
      if (aiModelsError) { off("Локальная модель недоступна: подобрано по словам."); return; }
      const timer = window.setTimeout(() => off("Локальная модель не отвечает: подобрано по словам."), 8000);
      return () => window.clearTimeout(timer);
    }
    const controller = new AbortController();
    metaAbortRef.current = controller;
    setMetaDialog((current) => current ? { ...current, ai: "work", note: "ИИ читает заметку и подбирает название…" } : current);
    let answer = "";
    const context = editor.document.map((block) => blockToText(block)).filter((t) => t.trim()).join("\n\n").slice(0, 6000);
    streamAiTask({ provider: "ollama", model: aiModel, operation: "custom", scope: "note", contextText: context, noteTitle: activeDoc?.title ?? "", instruction: META_INSTRUCTION, maxOutputTokens: 300 }, {
      signal: controller.signal,
      onDelta: (delta) => { answer += delta; },
    }).then(() => {
      const parsed = parseMetaAnswer(answer);
      setMetaDialog((current) => current ? (parsed
        ? { ...current, title: parsed.title, tags: parsed.tags.length ? parsed.tags.join(", ") : current.tags, ai: "done", note: "Подобрано моделью — проверьте и поправьте." }
        : { ...current, ai: "off", note: "Модель ответила неразборчиво: оставлен подбор по словам." }) : current);
    }).catch(() => { if (!controller.signal.aborted) off("Не удалось получить ответ модели: подобрано по словам."); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaDialog?.ai, aiModelsError, selectedModel, aiProvider]);

  // the request ends with the dialog, not when the dialog's own status changes
  useEffect(() => { if (metaDialog === null) metaAbortRef.current?.abort(); }, [metaDialog === null]);

  const applyMetaDialog = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    if (!metaDialog || !activeId) return;
    const title = metaDialog.title.trim();
    if (title) {
      setDocs((current) => current.map((doc) => doc.id === activeId ? { ...doc, title, updated: "только что" } : doc));
      const titleBlock = editor.document.find((block) => block.type === "heading");
      if (titleBlock) editor.updateBlock(titleBlock.id, { content: title });
    }
    const cleaned = parseTags(metaDialog.tags).join(", ");
    setTags((current) => cleaned ? { ...current, [activeId]: cleaned } : Object.fromEntries(Object.entries(current).filter(([id]) => id !== activeId)));
    setMetaDialog(null);
    setNotice("Название и метки сохранены");
  }, [activeId, editor, metaDialog]);

  /** Runs a prompt on a sample text with the current model; nothing is written into any note. */
  const probeTransformation = useCallback(async (prompt: string, sample: string) => {
    if (!selectedModel) throw new Error("Модель ещё не готова: откройте настройки ИИ и выберите сервис или подождите загрузки списка.");
    if (aiProvider !== "ollama" && !aiRemoteConsent && !(aiProvider === "compat" && aiProviders?.compat?.local && !cloudModelName(aiModel))) throw new Error("Нет согласия на отправку текста во внешний сервис (настройки ИИ).");
    let out = "";
    await streamAiTask({
      provider: aiProvider, model: aiModel, operation: "custom", scope: "note", contextText: sample.slice(0, 6000), noteTitle: "Проба", instruction: prompt.slice(0, 1000),
      ...(aiProvider !== "ollama" ? { remoteConsent: aiRemoteConsent, costConfirmed: true, localService: aiProvider === "compat" && Boolean(aiProviders?.compat?.local) && !cloudModelName(aiModel) } : {}),
    }, { onDelta: (delta) => { out += delta; } });
    return out.trim();
  }, [aiModel, aiProvider, aiProviders, aiRemoteConsent, selectedModel]);

  const saveCustomTransformations = useCallback((custom: Transformation[]) => {
    try { saveCustom(window.localStorage, custom); } catch { setNotice("Не удалось сохранить: хранилище браузера недоступно."); }
    setCustomTransformations(custom);
  }, []);

  const saveWritingRule = useCallback(() => {
    if (!aiWritingRule.trim()) {
      setNotice("Введите короткое правило письма перед сохранением");
      return;
    }
    setNotice("Правило письма сохранено только на этом устройстве");
  }, [aiWritingRule]);

  const openAiAssistant = useCallback((scope?: AiScope, preserveContext = false) => {
    aiAbortControllerRef.current?.abort();
    setAiProposal(null);
    setAiError("");
    if (!preserveContext) {
      let resolvedScope = scope ?? "paragraph";
      // never open "disabled": an empty paragraph falls back to the whole note when the note has text
      if (resolvedScope === "paragraph") {
        try {
          const here = blockText(editor.getTextCursorPosition().block.content).trim();
          if (!here && editor.document.some((block) => blockText(block.content).trim())) resolvedScope = "note";
        } catch { /* no cursor yet: keep the paragraph */ }
      }
      setAiScope(resolvedScope);
      setAiCompactMode(resolvedScope === "selection");
    }
    setActiveInspector("ai");
  }, [editor]);

  const commandResults: FinderCommand[] = [
    { id: "insert-link", shortcut: "Ctrl+L", label: "Вставить ссылку на заметку", hint: "[[название]] — связь между заметками (Ctrl L)", keywords: "ссылка связь wiki обратные", icon: Hash, disabled: !activeId, run: () => setLinkPicker({ query: "", index: 0 }) },
    { id: "daily-note", label: "Заметка за сегодня", hint: "Открыть или создать запись на сегодня", keywords: "дневник сегодня дата ежедневная", icon: Clock3, run: () => openDailyNote() },
    { id: "new-note", label: "Новая заметка", hint: "Создать заметку", keywords: "создать новая заметка", icon: Plus, run: () => addDocument() },
    { id: "toggle-ai", shortcut: "Ctrl+J", label: activeInspector === "ai" ? "Закрыть AI-помощник" : "Открыть AI-помощник", hint: "Панель без запуска генерации", keywords: "ai помощник открыть закрыть", icon: Sparkles, run: () => activeInspector === "ai" ? setActiveInspector(null) : openAiAssistant("paragraph") },
    { id: "properties", label: activeInspector === "properties" ? "Закрыть свойства" : "Открыть свойства", hint: "Свойства текущей заметки", keywords: "свойства метка папка", icon: ChevronDown, disabled: !activeDoc, run: () => setActiveInspector((current) => current === "properties" ? null : "properties") },
    { id: "rename", label: "Переименовать заметку", hint: "Изменить название", keywords: "переименовать название", icon: Pencil, disabled: !activeDoc, run: () => activeDoc && setFormDialog({ kind: "rename", title: "Переименовать заметку", value: activeDoc.title, hint: "Название заметки" }) },
    { id: "move", label: "Переместить заметку", hint: "Выбрать проект", keywords: "переместить папка проект", icon: FolderInput, disabled: !activeDoc, run: () => moveActiveNote() },
    { id: "focus", label: "Режим фокуса", hint: "Скрыть панели и писать без отвлечений", keywords: "фокус zen без отвлечений полноэкранный", icon: Eye, shortcut: "F11", run: () => setFocusMode(true) },
    { id: "pin", label: activeDoc?.pinned ? "Открепить заметку" : "Закрепить заметку", hint: "Избранное", keywords: "закрепить открепить pin", icon: activeDoc?.pinned ? PinOff : Pin, disabled: !activeDoc || Boolean(activeDoc.deletedAt), run: () => togglePinActiveNote() },
    { id: "archive", label: activeDoc?.archived ? "Вернуть из архива" : "Переместить в архив", hint: "Изменить состояние заметки", keywords: "архив архивировать вернуть", icon: Archive, disabled: !activeDoc, run: () => archiveActiveNote() },
    { id: "trash", label: "Переместить в корзину", hint: "Можно восстановить позже", keywords: "корзина удалить", icon: Trash2, disabled: !activeDoc, run: () => deleteActiveNote() },
    ...promptRecipes.map((recipe) => ({
      id: `recipe:${recipe.id}`, label: recipe.name, hint: "Рецепт · открыть AI с инструкцией",
      keywords: `рецепт ${recipe.name} ${recipe.instruction}`, icon: Sparkles,
      run: () => { setAiInstruction(recipe.instruction); openAiAssistant(undefined, true); },
    })),
  ];
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>(() => { try { const v = JSON.parse(window.localStorage.getItem("nh4-recent-commands") ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 4) : []; } catch { return []; } });
  const rememberCommand = (id: string) => {
    const next = [id, ...recentCommandIds.filter((x) => x !== id)].slice(0, 4);
    setRecentCommandIds(next);
    try { window.localStorage.setItem("nh4-recent-commands", JSON.stringify(next)); } catch { /* optional */ }
  };
  const commandMode = query.trimStart().startsWith(">");
  const commandQuery = query.trim().replace(/^>\s*/, "").toLocaleLowerCase();
  const visibleCommands = commandResults
    .filter((command) => !commandQuery || `${command.label} ${command.hint} ${command.keywords}`.toLocaleLowerCase().includes(commandQuery))
    .sort((a, b) => { if (commandQuery) return 0; const ra = recentCommandIds.indexOf(a.id), rb = recentCommandIds.indexOf(b.id); return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb); });   // without a query the commands used lately come first

  const handleAiCitation = useCallback((citation: AiCitation) => {
    if (citation.blockId.startsWith("note:")) {
      setNotice(`Источник ${citation.marker} — другая заметка: ${citation.label}. Откройте её из панели «Связи» под листом.`);
      return;
    }
    const editorDom = editor.prosemirrorView.dom;
    const resolveTarget = () => Array.from(editorDom.querySelectorAll<HTMLElement>("[data-id]"))
      .find((element) => element.dataset.id === citation.blockId);
    const target = resolveTarget();
    if (!target) {
      setAiError("Исходный блок больше не найден; цитата не может быть открыта.");
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    citationHighlightCleanupRef.current?.();
    let disposed = false;
    let rafId: number | undefined;
    let timeoutId: number | undefined;
    const highlightToken = Symbol("ai-citation-target");
    const highlighted = new Map<HTMLElement, symbol>();
    const applyHighlight = () => {
      if (disposed) return;
      const currentTarget = resolveTarget();
      if (currentTarget) {
        currentTarget.classList.add("ai-citation-target");
        highlighted.set(currentTarget, highlightToken);
      }
    };
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      if (rafId !== undefined) window.cancelAnimationFrame(rafId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      observer.disconnect();
      for (const [element, token] of highlighted) {
        if (token === highlightToken) element.classList.remove("ai-citation-target");
      }
      highlighted.clear();
      if (citationHighlightCleanupRef.current === cleanup) citationHighlightCleanupRef.current = null;
    };
    const observer = new MutationObserver(applyHighlight);
    observer.observe(editorDom, { childList: true, subtree: true });
    citationHighlightCleanupRef.current = cleanup;
    applyHighlight();
    rafId = window.requestAnimationFrame(applyHighlight);
    timeoutId = window.setTimeout(cleanup, 1800);
    setNotice(`Источник ${citation.marker}: ${citation.label}`);
  }, [editor]);

  useEffect(() => { const term = pendingFindRef.current; pendingFindRef.current = ""; setFind(term ? { replace: false, term } : null); }, [activeId]);

  const noteStats = useMemo(() => {
    // the visible text only: list marks, heading marks and blank lines are not counted
    const raw = activeId && contents[activeId] ? blocksToText(contents[activeId] as LooseBlock[]) : "";
    const text = raw.split("\n").map((line) => line.replace(/^\s*(?:#{1,3}\s|[-*]\s(?:\[[ xX]\]\s)?|\d+\.\s|>\s)/, "")).join("\n").replace(/^\s+|\s+$/g, "");
    const words = text ? text.split(/\s+/).length : 0;
    return { words, chars: text.length };
  }, [activeId, contents]);

  const handleEditorChange = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    const blocks = editor.document;
    if (aiProposal?.operation === "analyze" && aiProposal.noteId === id
      && aiProposal.sourceFingerprint !== JSON.stringify({ noteId: id, blocks })) {
      setAiProposal(null);
      setNotice("Результат анализа устарел после изменения заметки");
    }
    if (aiAcceptedSignatureRef.current && JSON.stringify(blocks) !== aiAcceptedSignatureRef.current) setCanUndoAi(false);
    const titleBlock = blocks.find((block) => block.type === "heading");
    const titleContent = titleBlock?.content;
    const documentTitle = (typeof titleContent === "string"
      ? titleContent
      : Array.isArray(titleContent)
        ? titleContent.map((item) => typeof item === "object" && item !== null && "text" in item ? String(item.text) : "").join("")
        : "").trim();
    setContents((current) => ({ ...current, [id]: blocks }));
    setDocs((current) => current.map((doc) => doc.id === id
      ? { ...doc, ...(documentTitle ? { title: documentTitle } : {}), updated: "только что", modifiedAt: Date.now() }
      : doc));
    setSavedAt("Сохраняем локально…");
  }, [aiProposal, editor]);

  const reloadLibrary = useCallback(async (opts?: { selectId?: string; selectFolder?: string }) => {
    await sync.flush();
    const loaded = toLabState(await host.bootstrap());
    sync.reset(loaded);
    setDocs(loaded.state.docs);
    setContents(loaded.state.contents);
    setFolders(loaded.state.folders);
    setParents(loaded.parents);
    setTags(loaded.state.tags);
    const live = loaded.state.docs.filter((doc) => !doc.deletedAt);
    const target = (opts?.selectId ? live.find((doc) => doc.id === opts.selectId) : undefined)
      ?? (opts?.selectFolder ? live.find((doc) => doc.folder === opts.selectFolder && !doc.archived) : undefined)
      ?? live.find((doc) => doc.id === activeIdRef.current)            // keep the open note, but show what is on disk now
      ?? live.find((doc) => !doc.archived);
    if (target) {
      setNoteView("folder");
      setFolder(target.folder);
      activeIdRef.current = target.id;
      setActiveId(target.id);
      editor.replaceBlocks(editor.document, loaded.state.contents[target.id] ?? []);
    } else {
      activeIdRef.current = null;
      setActiveId(null);
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "Создайте заметку кнопкой «Новая заметка»." }]);
    }
    return loaded;
  }, [editor, sync]);

  useEffect(() => onHostEvent("libraryChanged", (payload) => {
    const select = (payload as { select?: string } | null)?.select;
    void reloadLibrary(select ? { selectId: select } : undefined)
      .then(() => setNotice("Файл открыт как заметка"))
      .catch((error) => setNotice(error instanceof Error ? error.message : "Не удалось обновить библиотеку"));
  }), [reloadLibrary]);

  const handleWindowsImport = useCallback(async () => {
    setNotice("Выберите ZIP-снимок Windows Notepad…");
    try {
      await sync.flush();
      const result = await host.importWindowsSnapshot();
      if (result.cancelled) { setNotice(result.warnings[0] ?? "Перенос отменён"); return; }
      await reloadLibrary({ selectFolder: "Импорт Windows" });
      const parts = [`создано: ${result.created}`, `обновлено: ${result.updated}`];
      if (result.skipped) parts.push(`пропущено: ${result.skipped}`);
      if (result.emptyWithExternalFile) parts.push(`пустых (текст во внешних файлах): ${result.emptyWithExternalFile}`);
      setNotice("Перенос из Windows Notepad — " + parts.join(", "));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось выполнить перенос");
    }
  }, [reloadLibrary, sync]);

  const handleHostFileOpen = useCallback(async () => {
    try {
      await sync.flush();
      const result = await host.openFiles();
      if (result.cancelled) return;
      const first = result.created[0];
      await reloadLibrary(first ? { selectId: first } : undefined);
      setNotice(result.warnings?.length ? result.warnings[0] : `Открыто файлов: ${result.created.length}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось открыть файлы");
    }
  }, [reloadLibrary, sync]);

  const importTextFile = useCallback(async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setNotice("Текстовый файл должен быть меньше 5 МБ");
      return;
    }
    try {
      const text = await file.text();
      if (text.length > EDITOR_LIMIT_CHARS) {
        setNotice(`Файл «${file.name}» длиннее ${EDITOR_LIMIT_CHARS.toLocaleString("ru")} знаков: редактор его не примет. Откройте его кнопкой «Открыть файлы…» — большие файлы остаются ссылкой.`);
        return;
      }
      const title = file.name.replace(/\.[^.]+$/, "") || "Без названия";
      const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const blocks: PartialBlock[] = [
        { type: "heading", props: { level: 1 }, content: title },
        ...text.split(/\r?\n/).map((line) => ({ type: "paragraph" as const, content: line })),
      ];
      setDocs((current) => [...current, { id, title, folder, updated: "только что", icon: "note", lastOpenedAt: Date.now() }]);
      setContents((current) => ({ ...current, [id]: blocks }));
      activeIdRef.current = id;
      setActiveId(id);
      setNoteView("folder");
      setFolder(folder);
      editor.replaceBlocks(editor.document, blocks);
      setNotice(`Открыт текстовый файл: ${file.name}`);
    } catch {
      setNotice("Не удалось прочитать текстовый файл");
    }
  }, [editor, folder]);

  const handleTextFileOpen = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await importTextFile(file);
  }, [importTextFile]);

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    const files = Array.from(event.dataTransfer.files).filter((f) => /\.(txt|md|log)$/i.test(f.name) || f.type === "text/plain");
    if (!files.length) return;
    event.preventDefault();
    for (const file of files.slice(0, 10)) await importTextFile(file);
  }, [importTextFile]);

  const chooseSearchResult = useCallback((doc: DocItem) => {
    const word = query.trim().split(/\s+/).find((w) => w.length >= 2 && !w.startsWith(">")) ?? "";
    if (word && doc.id === activeIdRef.current) setFind({ replace: false, term: word }); else pendingFindRef.current = word;
    setNoteView(doc.archived ? "archive" : "folder");
    setFolder(doc.folder);
    selectDocument(doc);
    setShowSearch(false);
    setQuery("");
    setSelectedSearchIndex(0);
    window.setTimeout(restoreSearchFocus, 0);
  }, [query, restoreSearchFocus, selectDocument]);

  // back and forward through the notes opened one after another (Alt + left / right)
  useEffect(() => {
    if (!activeId) return;
    if (navSilentRef.current) navSilentRef.current = false;
    else if (navStackRef.current[navPosRef.current] !== activeId) {
      navStackRef.current = [...navStackRef.current.slice(0, navPosRef.current + 1), activeId].slice(-50);
      navPosRef.current = navStackRef.current.length - 1;
    }
    setNavState({ back: navPosRef.current > 0, forward: navPosRef.current < navStackRef.current.length - 1 });
  }, [activeId]);
  const goHistory = useCallback((delta: -1 | 1) => {
    let pos = navPosRef.current;
    for (;;) {
      pos += delta;
      const id = navStackRef.current[pos];
      if (id === undefined) return;
      const doc = docsRef.current.find((item) => item.id === id && !item.deletedAt);
      if (!doc) continue;
      navPosRef.current = pos;
      if (doc.id === activeIdRef.current) { setNavState({ back: pos > 0, forward: pos < navStackRef.current.length - 1 }); return; }
      navSilentRef.current = true;
      setNoteView(doc.archived ? "archive" : "folder");
      setFolder(doc.folder);
      selectDocument(doc);
      return;
    }
  }, [selectDocument]);
  const goHistoryRef = useRef(goHistory);
  goHistoryRef.current = goHistory;

  const copyNoteLink = useCallback(() => {
    if (!activeDoc) return;
    const text = `[[${activeDoc.title}]]`;
    void navigator.clipboard.writeText(text).then(() => setNotice(`Ссылка ${text} скопирована: вставьте её в другую заметку`), () => setNotice("Не удалось скопировать ссылку"));
  }, [activeDoc]);
  const revealNote = useCallback(async () => {
    if (!activeId) return;
    try { await sync.flush(); await host.revealNote(activeId); } catch (error) { setNotice(error instanceof Error ? error.message : "Не удалось показать файл"); }
  }, [activeId, sync]);
  const jumpToBlock = useCallback((id: string) => {
    try { editor.setTextCursorPosition(id, "start"); } catch { /* the block is gone */ }
    document.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [editor]);

  const exportMarkdown = useCallback(async () => {
    try {
      const markdown = await editor.blocksToMarkdownLossy(editor.document);
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(activeDoc?.title || "Заметка").replace(/[<>:"/\\|?*]/g, "-")}.md`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("Markdown экспортирован");
    } catch {
      setNotice("Не удалось экспортировать Markdown");
    }
  }, [activeDoc, editor]);

  const exportBackup = useCallback(() => {
    const backupContents = activeId ? { ...contents, [activeId]: editor.document } : contents;
    const snapshot: LabState = { schemaVersion: 1, docs, contents: backupContents, activeId, folder, folders, dark, tags };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `notepad-hub-lab-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice("Полная JSON-копия заметок сохранена");
  }, [activeId, contents, dark, docs, editor, folder, folders, tags]);

  useEffect(() => {
    if (activeId) document.getElementById(`note-tab-${activeId}`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId, noteView, folder]);

  const openHistory = useCallback(async () => {
    if (!activeId) return;
    setHistory({ entries: [], loading: true, error: "", selected: null, preview: "" });
    try {
      await sync.flush();
      const entries = await host.listHistory(activeId);
      setHistory({ entries, loading: false, error: "", selected: null, preview: "" });
    } catch (error) {
      setHistory({ entries: [], loading: false, error: error instanceof Error ? error.message : "Не удалось загрузить историю", selected: null, preview: "" });
    }
  }, [activeId, sync]);

  const previewVersion = useCallback(async (name: string) => {
    if (!activeId) return;
    try {
      const text = await host.readHistory(activeId, name);
      setHistory((current) => current ? { ...current, selected: name, preview: text.length > 4000 ? text.slice(0, 4000) + "…" : text, error: "" } : current);
    } catch (error) {
      setHistory((current) => current ? { ...current, error: error instanceof Error ? error.message : "Не удалось прочитать версию" } : current);
    }
  }, [activeId]);

  const restoreVersion = useCallback(async (name: string) => {
    if (!activeId || !window.confirm("Заменить текст заметки выбранной версией? Текущий текст сначала сохранится как новая версия.")) return;
    try {
      await sync.flush();
      await host.checkpoint(activeId);
      const text = await host.readHistory(activeId, name);
      editor.replaceBlocks(editor.document, textToBlocks(text) as PartialBlock[]);
      setHistory(null);
      setNotice("Версия восстановлена");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось восстановить версию");
    }
  }, [activeId, editor, sync]);

  const openRefs = useCallback(async () => {
    setRefs({ files: [], picked: [], loading: true, error: "" });
    try {
      await sync.flush();
      const { files } = await host.previewReferencedFiles();
      setRefs({ files, picked: [], loading: false, error: "" });
    } catch (error) {
      setRefs({ files: [], picked: [], loading: false, error: error instanceof Error ? error.message : "Не удалось получить список" });
    }
  }, [sync]);

  const applyRefs = useCallback(async () => {
    if (!refs || refs.picked.length === 0) return;
    try {
      const { filled } = await host.resolveReferencedFiles(refs.picked);
      setRefs(null);
      await reloadLibrary();
      setNotice(`Текст подтянут в заметок: ${filled}`);
    } catch (error) {
      setRefs((current) => current ? { ...current, error: error instanceof Error ? error.message : "Не удалось прочитать файлы" } : current);
    }
  }, [refs, reloadLibrary]);

  // files opened in place: the host reports every write into the source file
  useEffect(() => onHostEvent("sourceStatus", (payload) => {
    const p = payload as { id?: string; status?: string; message?: string };
    if (!p?.id || !p.status) return;
    setSourceIssue((current) => {
      const next = { ...current };
      if (p.status === "saved") delete next[p.id!]; else next[p.id!] = { status: p.status!, message: p.message ?? "" };
      return next;
    });
    if (p.status === "conflict") setNotice("Файл изменён другой программой. Откройте «Файл изменён снаружи» вверху и выберите версию.");
    if (p.status === "error") setNotice(p.message ?? "Не удалось записать в файл");
  }), []);

  const toggleWriteThrough = useCallback(async () => {
    if (!activeDoc?.sourcePath) return;
    const enabled = !activeDoc.writeThrough;
    try {
      await sync.flush();
      await host.setWriteThrough(activeDoc.id, enabled);
      setDocs((current) => current.map((doc) => doc.id === activeDoc.id ? { ...doc, writeThrough: enabled } : doc));
      setNotice(enabled ? "Изменения сохраняются прямо в файл" : "Файл больше не меняется: правки остаются в библиотеке");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось изменить режим");
    }
  }, [activeDoc, sync]);

  const resolveConflict = useCallback(async (id: string, choice: "mine" | "disk") => {
    setConflictDialog(null);
    try {
      await sync.flush();
      await host.resolveSourceConflict(id, choice);
      setSourceIssue((current) => { const next = { ...current }; delete next[id]; return next; });
      if (choice === "disk") await reloadLibrary({ selectId: id });
      setNotice(choice === "mine" ? "Файл перезаписан вашей версией; прежняя версия файла сохранена в резервных копиях" : "Взята версия с диска; ваш текст есть в истории версий");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось применить выбор");
    }
  }, [reloadLibrary, sync]);

  const createBackupNow = useCallback(async () => {
    try {
      await sync.flush();
      const r = await host.createBackup();
      if (!r.cancelled) setNotice(`Резервная копия сохранена: ${r.fileName} (заметок: ${r.noteCount})`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось создать копию");
    }
  }, [sync]);

  const doRestoreBackup = useCallback(async () => {
    try {
      await sync.flush();
      const r = await host.restoreBackup();
      if (r.cancelled) return;
      await reloadLibrary();
      setNotice(`Восстановлено заметок: ${r.restoredNotes}. Прежнее состояние сохранено: ${r.rollbackFileName}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось восстановить копию");
    }
  }, [reloadLibrary, sync]);

  const restoreBackupNow = useCallback(() => {
    setConfirmDialog({ title: "Восстановить заметки из копии?", message: "Все текущие заметки будут заменены заметками из копии. Прежнее состояние сохранится в файле отката, его можно вернуть тем же способом.", confirm: "Выбрать копию…", danger: true, run: () => void doRestoreBackup() });
  }, [doRestoreBackup]);

  // Ctrl + mouse wheel over the note zooms the text, as in browsers and editors
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !(event.target as HTMLElement | null)?.closest?.(".editor-scroll")) return;
      event.preventDefault();
      setZoom((z) => Math.max(70, Math.min(200, z + (event.deltaY < 0 ? 10 : -10))));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === "F11") { event.preventDefault(); setFocusMode((v) => !v); return; }
      if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); goHistoryRef.current(event.key === "ArrowLeft" ? -1 : 1); return; }
      const action = matchShortcut(event);
      if (!action) return;
      event.preventDefault();
      if (event.repeat && (action === "closeTab" || action === "newNote" || action === "link")) return;
      switch (action) {
        case "save": saveDocument(); break;
        case "search": openSearch(); break;
        case "find": case "replace":
          setFind((current) => ({ replace: action === "replace" || Boolean(current?.replace) }));
          break;
        case "link": setLinkPicker({ query: "", index: 0 }); break;
        case "closeTab": if (activeIdRef.current) void closeTabRef.current(activeIdRef.current); break;
        case "ai": openAiAssistant(); break;
        case "newNote": addDocumentRef.current(); break;
        case "zoomIn": setZoom((z) => Math.min(200, z + 10)); break;
        case "zoomOut": setZoom((z) => Math.max(70, z - 10)); break;
        case "zoomReset": setZoom(100); break;
        case "nextTab": case "prevTab": stepTabRef.current(action === "nextTab" ? 1 : -1); break;
        case "help": setShowShortcuts(true); break;
      }
    };
    window.addEventListener("keydown", keyHandler);
    return () => window.removeEventListener("keydown", keyHandler);
  }, [openAiAssistant, openSearch, saveDocument]);

  useEffect(() => {
    // BlockNote renders checklist checkboxes without a name; give each one a label so screen readers announce it
    const label = () => document.querySelectorAll<HTMLInputElement>(".bn-editor input[type=checkbox]:not([aria-label])").forEach((box) => box.setAttribute("aria-label", "Выполнено"));
    label();
    const observer = new MutationObserver(label);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // the "Ещё" menu is a <details>: close it on an outside click
    const closeOutside = (event: MouseEvent) => {
      document.querySelectorAll("details.note-toolbar-overflow[open]").forEach((d) => { if (!d.contains(event.target as Node)) d.removeAttribute("open"); });
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, []);

  useEffect(() => {
    const escapeHandler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showShortcuts) {
        setShowShortcuts(false);
      } else if (conflictDialog) {
        setConflictDialog(null);
      } else if (history) {
        setHistory(null);
      } else if (refs) {
        setRefs(null);
      } else if (linkPicker) {
        setLinkPicker(null);
      } else if (formDialog) {
        setFormDialog(null);
      } else if (showSearch) {
        setShowSearch(false);
        setQuery("");
        setSelectedSearchIndex(0);
        window.setTimeout(restoreSearchFocus, 0);
      } else if (activeInspector === "ai") {
        closeAiAssistant();
      } else if (activeInspector === "properties") {
        setActiveInspector(null);
      } else if (!sidebarCollapsed && window.matchMedia("(max-width: 760px)").matches) {
        setSidebarCollapsed(true);
        window.setTimeout(() => mobileNavTriggerRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", escapeHandler);
    return () => window.removeEventListener("keydown", escapeHandler);
  }, [activeInspector, closeAiAssistant, conflictDialog, formDialog, history, linkPicker, refs, showShortcuts, restoreSearchFocus, showSearch, sidebarCollapsed]);

  // every modal dialog (form, link picker, conflict, shortcuts, history, referenced files): focus moves in, Tab stays inside, focus returns afterwards
  const anyDialogOpen = Boolean(transformationsOpen || confirmDialog || formDialog || metaDialog || imageDialog || linkPicker || conflictDialog || showShortcuts || history || refs);
  useEffect(() => {
    if (!anyDialogOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(document.querySelectorAll<HTMLElement>(".form-backdrop [role=dialog] :is(button, input, select, textarea, a[href], [tabindex]):not([disabled]):not([tabindex='-1'])"))
      .filter((element) => element.getClientRects().length > 0);
    const startTimer = window.setTimeout(() => {
      const dialog = document.querySelector<HTMLElement>(".form-backdrop [role=dialog]");
      if (dialog && !dialog.contains(document.activeElement)) focusables()[0]?.focus();
    }, 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0], last = list[list.length - 1];
      const active = document.activeElement;
      if (!document.querySelector(".form-backdrop [role=dialog]")?.contains(active)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(startTimer);
      document.removeEventListener("keydown", onKey, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [anyDialogOpen]);

  const handleSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (commandMode) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSearchIndex((index) => Math.min(index + 1, Math.max(0, visibleCommands.length - 1)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSearchIndex((index) => Math.max(0, index - 1));
      } else if (event.key === "Enter" && visibleCommands[selectedSearchIndex] && !visibleCommands[selectedSearchIndex].disabled) {
        event.preventDefault();
        rememberCommand(visibleCommands[selectedSearchIndex].id);
        visibleCommands[selectedSearchIndex].run();
        setShowSearch(false);
        setQuery("");
        setSelectedSearchIndex(0);
        window.setTimeout(restoreSearchFocus, 0);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedSearchIndex((index) => Math.min(index + 1, Math.max(0, searchResults.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedSearchIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" && searchResults[selectedSearchIndex]) {
      event.preventDefault();
      chooseSearchResult(searchResults[selectedSearchIndex]);
    }
  }, [chooseSearchResult, commandMode, restoreSearchFocus, searchResults, selectedSearchIndex, visibleCommands]);

  const handleTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const lastIndex = openTabs.length - 1;
    const nextIndex = event.key === "ArrowRight" ? Math.min(lastIndex, index + 1)
      : event.key === "ArrowLeft" ? Math.max(0, index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? lastIndex : index;
    if (event.key === "Delete" && openTabs[index]) { event.preventDefault(); requestTrash(openTabs[index].id); return; }
    if (nextIndex !== index && openTabs[nextIndex]) {
      event.preventDefault();
      selectDocument(openTabs[nextIndex]);
      window.setTimeout(() => document.querySelector<HTMLButtonElement>(`.tabs-scroller [data-tab-index="${nextIndex}"]`)?.focus(), 0);
    }
  }, [openTabs, requestTrash, selectDocument]);

  const aiSideBySideNav = activeInspector === "ai" && window.innerWidth >= 900;   // docked AI: the library hides on its own and returns when the assistant closes
  const navigationCollapsed = sidebarCollapsed || aiSideBySideNav;
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const doc of docs) if (!doc.deletedAt) for (const tag of parseTags(tags[doc.id])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
  }, [docs, tags]);
  const viewTitle = noteView === "folder" ? folder : noteView === "trash" ? "Корзина" : noteView === "archive" ? "Архив" : noteView === "pinned" ? "Закреплённые" : noteView === "all" ? "Все заметки" : "Недавние";
  const saveFailed = /не сохранен/i.test(savedAt);
  const saveState: "saved" | "saving" | "error" = saveFailed ? "error" : /^Сохраняем|^Сохраняется/.test(savedAt) ? "saving" : "saved";
  const noteTagList = activeDoc ? parseTags(tags[activeDoc.id]) : [];
  const backlinkCount = activeDoc ? linkIndex.backlinks(activeDoc.id).length : 0;
  const noteMenuClose = (event: React.MouseEvent<HTMLDivElement>) => { if ((event.target as HTMLElement).closest("button")) event.currentTarget.closest("details")?.removeAttribute("open"); };

  return (
    <div className={`app-shell${focusMode ? " is-focus" : ""}${dark ? " theme-dark" : ""}${activeInspector === "ai" ? " ai-open" : ""}`} style={{ "--ai-w": `${aiWidth}px` } as React.CSSProperties}>
      <header className="topbar">
        <div className="tb-nav" role="group" aria-label="Навигация">
        <div className="brand-lockup"><div className="brand-mark"><FileText size={17} strokeWidth={2.1} /></div><span>Notepad Hub</span></div>
        </div>
        <div className="topbar-note" role="group" aria-label="Текущая заметка">
          <div className="note-nav" role="group" aria-label="История заметок">
            <button type="button" className="icon-button quiet bar-icon" aria-label="Назад к предыдущей заметке" title="Назад (Alt ←)" disabled={!navState.back} onClick={() => goHistory(-1)}><ArrowLeft size={16} /></button>
            <button type="button" className="icon-button quiet bar-icon" aria-label="Вперёд к следующей заметке" title="Вперёд (Alt →)" disabled={!navState.forward} onClick={() => goHistory(1)}><ArrowRight size={16} /></button>
          </div>
          <div className="note-crumbs">
            <button className="crumb-folder" disabled={!activeDoc} onClick={moveActiveNote} title={`Проект: ${projectPath(activeDoc?.folder ?? folder, parents)}. Нажмите, чтобы переместить заметку`}><Folder size={14} /><span>{activeDoc?.folder ?? folder}</span></button>
            <span className="crumb-sep" aria-hidden="true">/</span>
            <button className="crumb-title" disabled={!activeDoc} onClick={() => activeDoc && setFormDialog({ kind: "rename", title: "Переименовать заметку", value: activeDoc.title, hint: "Название заметки" })} title="Переименовать заметку"><span>{activeDoc?.title ?? "Новая заметка"}</span><Pencil size={13} aria-hidden="true" /></button>
          </div>
          <div className="note-status">
            {activeDoc && sourceIssue[activeDoc.id]?.status === "conflict" && <button className="conflict-chip" onClick={() => setConflictDialog(activeDoc.id)} title={sourceIssue[activeDoc.id].message}>Файл изменён снаружи</button>}
            {activeDoc?.writeThrough && !sourceIssue[activeDoc.id] && <span className="file-chip" title={`Правки сохраняются в файл: ${activeDoc.sourcePath}`}><FileText size={13} aria-hidden="true" />файл</span>}
          </div>
        </div>
        <div className="topbar-actions" role="toolbar" aria-label="Инструменты">
          <div className="tb-group" role="group" aria-label="Правка">
            <button className="icon-button quiet bar-icon" aria-label="Отменить" title="Отменить (Ctrl Z)" disabled={!activeDoc} onClick={undoEdit}><Undo2 size={16} /></button>
            <button className="icon-button quiet bar-icon" aria-label="Повторить" title="Повторить (Ctrl Y)" disabled={!activeDoc} onClick={redoEdit}><Redo2 size={16} /></button>
          </div>
          <span className="tb-sep" aria-hidden="true" />
          <div className="tb-group" role="group" aria-label="Вид">
            <button className={`icon-button quiet bar-icon${secondId ? " is-on" : ""}`} aria-pressed={Boolean(secondId)} aria-label="Две заметки на экране" title="Две заметки рядом: сравнение и перенос выделенного" disabled={!activeDoc} onClick={() => { if (secondId) { setSecondId(null); return; } const other = [...openTabs.filter((doc) => doc.id !== activeId), ...docs.filter((doc) => !doc.deletedAt && doc.id !== activeId)].find((doc) => !isPlaceholderNote(doc.id)); if (other) setSecondId(other.id); else setNotice("Нужна ещё одна заметка."); }}><Columns2 size={16} /></button>
          </div>
          <span className="tb-sep" aria-hidden="true" />
            <button ref={aiTriggerRef} className={`bar-ai${activeInspector === "ai" ? " is-open" : ""}`} aria-label={activeInspector === "ai" ? "Закрыть AI-помощник" : "Открыть AI-помощник"} aria-pressed={activeInspector === "ai"} title="AI-помощник (Ctrl J)" onClick={() => activeInspector === "ai" ? closeAiAssistant() : openAiAssistant("paragraph")}><Sparkles size={15} /><span>AI</span></button>
          <span className="tb-sep" aria-hidden="true" />
          <div className={`topbar-search${showSearch ? " is-open" : ""}`}>
            {!showSearch ? <button ref={searchTriggerRef} className="icon-button quiet bar-icon" onClick={openSearch} aria-label="Поиск заметок и команд" title="Поиск заметок и команд (Ctrl K)"><Search size={17} /></button>
              : <>
                <div className="search-scrim" onMouseDown={() => { setShowSearch(false); setQuery(""); setSelectedSearchIndex(0); window.setTimeout(restoreSearchFocus, 0); }} />
                <div className="search-field" role="search"><Search size={16} /><input id="global-search" role="combobox" aria-expanded="true" aria-controls="search-listbox" aria-autocomplete="list" aria-activedescendant={`search-opt-${selectedSearchIndex}`} value={query} onChange={(event) => { setQuery(event.target.value); setSelectedSearchIndex(0); }} onKeyDown={handleSearchKeyDown} placeholder="Поиск заметок… Введите &gt; для команд" autoComplete="off" aria-label="Поиск заметок и команд" /><kbd>Esc</kbd></div>
                <div className="search-modal" role="dialog" aria-label="Результаты поиска" tabIndex={0}><div className="search-results-label" id="search-title">{commandMode ? "Команды" : "Глобальный поиск · заметки"}<small>{commandMode ? "Введите название команды или рецепта" : query.trim() && searchResults.length > 0 ? `Найдено: ${searchTotal} ${plural(searchTotal, ["совпадение", "совпадения", "совпадений"])} в ${searchResults.length} ${plural(searchResults.length, ["заметке", "заметках", "заметках"])}` : "Введите > для команд"}</small></div>{commandMode ? <div id="search-listbox" role="listbox" aria-label="Результаты команд">{visibleCommands.map((command, index) => { const Icon = command.icon; return <button key={command.id} id={`search-opt-${index}`} tabIndex={-1} role="option" disabled={command.disabled} className="search-result command-result" aria-selected={index === selectedSearchIndex} onMouseEnter={() => setSelectedSearchIndex(index)} onClick={() => { if (command.disabled) return; rememberCommand(command.id); command.run(); setShowSearch(false); setQuery(""); setSelectedSearchIndex(0); window.setTimeout(restoreSearchFocus, 0); }}><Icon size={17} /><span>{command.label}{!commandQuery && recentCommandIds.includes(command.id) && <em className="search-recent">недавно</em>}<small>{command.hint}{command.disabled ? " · недоступно без активной заметки" : ""}</small></span>{command.shortcut && <kbd className="search-shortcut">{command.shortcut}</kbd>}</button>; })}</div> : <div id="search-listbox" role="listbox" aria-label="Результаты заметок">{searchResults.map((doc, index) => <button key={doc.id} id={`search-opt-${index}`} tabIndex={-1} role="option" className="search-result" aria-selected={index === selectedSearchIndex} onMouseEnter={() => setSelectedSearchIndex(index)} onClick={() => chooseSearchResult(doc)}><FileText size={17} /><span><span className="search-title-line">{markWords(doc.title)}{(searchHitById.get(doc.id)?.matches ?? 0) > 0 && query.trim() && <em className="search-matches" title="Сколько раз слова запроса встречаются в заметке">{searchHitById.get(doc.id)?.matches}</em>}</span><small>{doc.folder}{doc.archived ? " · Архив" : ""}</small>{query.trim() && (searchHitById.get(doc.id)?.snippets ?? []).map((line, lineIndex) => <small key={lineIndex} className="search-snippet">{markWords(line)}</small>)}</span></button>)}</div>}{(commandMode ? visibleCommands.length === 0 : searchResults.length === 0) && <div className="search-empty">{commandMode ? "Команды не найдены" : "Ничего не найдено"}</div>}<div className="search-modal-footer"><span className="search-count">{commandMode ? `${visibleCommands.length} из ${commandResults.length}` : `${searchResults.length} из ${docs.filter((doc) => !doc.deletedAt).length}`}</span><span><kbd>↵</kbd> открыть</span>      <span><kbd>↑</kbd><kbd>↓</kbd> перемещение</span><span><kbd>&gt;</kbd> команды и рецепты</span><span><kbd>Esc</kbd> закрыть</span></div></div>
              </>}
          </div>
            <details className="note-toolbar-overflow note-menu">
              <summary aria-label="Дополнительные действия заметки" title="Действия с заметкой"><Ellipsis size={18} /></summary>
              <div className="note-toolbar-menu" onClick={noteMenuClose}>
                <button disabled={!activeDoc} onClick={() => activeDoc && setFormDialog({ kind: "rename", title: "Переименовать заметку", value: activeDoc.title, hint: "Название заметки" })}><Pencil size={14} />Переименовать</button>
                <button disabled={!activeDoc} onClick={moveActiveNote}><FolderInput size={14} />Переместить в проект…</button>
                <button disabled={!activeDoc} onClick={openMetaDialog}><Tag size={14} />Название и метки по содержимому…</button>
                <button disabled={!activeDoc} onClick={() => activeDoc && setFormDialog({ kind: "tag", title: "Метки заметки", value: tags[activeDoc.id] ?? "", hint: "Метки через запятую" })}><Hash size={14} />Метки…</button>
                <button disabled={!activeDoc || Boolean(activeDoc.deletedAt)} onClick={togglePinActiveNote}>{activeDoc?.pinned ? <PinOff size={14} /> : <Pin size={14} />}{activeDoc?.pinned ? "Открепить" : "Закрепить"}</button>
                <div className="note-toolbar-menu-divider" />
                <button disabled={!activeDoc} onClick={() => setFind({ replace: false })}><Search size={14} />Найти в заметке…<kbd className="menu-key">Ctrl+F</kbd></button>
                <button disabled={!activeDoc} onClick={() => setFind({ replace: true })}><Replace size={14} />Заменить…<kbd className="menu-key">Ctrl+H</kbd></button>
                <div className="note-toolbar-menu-divider" />
                <button disabled={!activeDoc} onClick={copyNoteLink}><Link2 size={14} />Копировать ссылку на заметку</button>
                {isHosted() && <button disabled={!activeDoc} onClick={() => void revealNote()}><ExternalLink size={14} />Показать в Проводнике</button>}
                {activeDoc?.sourcePath && isHosted() && <button onClick={() => void toggleWriteThrough()} title={activeDoc.sourcePath}><FileText size={14} />{activeDoc.writeThrough ? "Не сохранять в файл" : "Сохранять в файл"}<small className="menu-hint">{activeDoc.sourcePath.split(/[\\/]/).pop()}</small></button>}
                <button onClick={exportMarkdown}><ArrowDownToLine size={14} />Экспорт в Markdown</button>
                <div className="note-toolbar-menu-divider" />
                <button disabled={!activeDoc || !isHosted()} onClick={() => void openHistory()}><Clock3 size={14} />История версий…</button>
                <button disabled={!activeDoc} onClick={() => setActiveInspector((current) => current === "properties" ? null : "properties")}><Info size={14} />Содержание и свойства</button>
                <button onClick={() => setFocusMode(true)}><Eye size={14} />Режим фокуса<kbd className="menu-key">F11</kbd></button>
                {canUndoAi && <button onClick={undoAcceptedAi}><RotateCcw size={14} />Отменить AI-изменение</button>}
                <div className="note-toolbar-menu-divider" />
                {activeDoc?.deletedAt ? <><button onClick={restoreActiveNote}><RotateCcw size={14} />Восстановить</button><button className="destructive-action" onClick={permanentlyDeleteActiveNote}><Trash2 size={14} />Удалить навсегда</button></> : <><button disabled={!activeDoc} onClick={duplicateActiveNote}><Copy size={14} />Создать копию</button><button disabled={!activeDoc} onClick={archiveActiveNote}><Archive size={14} />{activeDoc?.archived ? "Вернуть в проект" : "В архив"}</button><div className="note-toolbar-menu-divider" /><button disabled={!activeDoc} className="destructive-action" onClick={deleteActiveNote}><Trash2 size={14} />В корзину</button></>}
              </div>
            </details>
        </div>
      </header>

      <div className={`workspace${navigationCollapsed ? " nav-collapsed" : ""}${trashPane ? " trash-open" : ""}`}>
        <aside className={`sidebar${dense ? " is-dense" : ""}`} id="note-navigation" aria-label="Навигация по заметкам">
          <div className="sidebar-toolbar"><h2 className="sidebar-caption" id="projects-heading">Проекты</h2><button className="icon-button tiny sidebar-add" aria-label="Добавить проект" title="Добавить проект" onClick={() => addFolder()}><Plus size={16} /></button><button ref={mobileNavTriggerRef} className="icon-button tiny desktop-nav-close" aria-expanded={!navigationCollapsed} aria-controls="note-navigation" aria-label={navigationCollapsed ? "Развернуть библиотеку" : "Свернуть библиотеку"} title={navigationCollapsed ? (aiSideBySideNav ? "Развернуть библиотеку (помощник закроется)" : "Развернуть библиотеку") : "Свернуть библиотеку"} onClick={() => { if (!navigationCollapsed) { setSidebarCollapsed(true); return; } if (aiSideBySideNav) setActiveInspector(null); setSidebarCollapsed(false); }}>{navigationCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button></div>
          <div className="sidebar-body">
          <section className={`nav-section projects-section${dragProject ? " is-dragging" : ""}${dropTarget === "" ? " is-drop-root" : ""}`} aria-labelledby="projects-heading"
            onDragOver={(event) => { if (dragProject) { event.preventDefault(); setDropTarget(""); } }}
            onDrop={(event) => { if (dragProject) { event.preventDefault(); moveProjectTo(dragProject, ""); setDragProject(null); setDropTarget(null); } }}>
            <div className="folder-item"><span className="folder-fold-gap" aria-hidden="true" /><button className={`folder-row all-row${noteView === "all" ? " selected" : ""}`} aria-current={noteView === "all" ? "page" : undefined} onClick={() => switchToSpecialView("all")}><FileText size={16} className="folder-icon" /><span>Все заметки</span><span className="folder-count">{docs.filter((doc) => !doc.deletedAt && !doc.archived).length}</span></button></div>
            {projectRows(folders, parents, closedProjects).map(({ name, depth, hasChildren }) => {
              const system = SYSTEM_PROJECTS.includes(name);
              const scope = subNotes ? projectScope(name, parents) : new Set([name]);
              const count = docs.filter((doc) => scope.has(doc.folder) && !doc.deletedAt && !doc.archived).length;
              const open = !closedProjects.includes(name);
              return <div key={name} className={`folder-item${dropTarget === name ? " is-drop" : ""}${dragProject === name ? " is-dragged" : ""}`} style={{ paddingLeft: depth * 14 }} data-depth={depth}
                draggable={!system}
                onDragStart={(event) => { if (system) return; event.dataTransfer.setData("text/plain", name); event.dataTransfer.effectAllowed = "move"; setDragProject(name); }}
                onDragEnd={() => { setDragProject(null); setDropTarget(null); }}
                onDragOver={(event) => { if (dragProject && !system && dragProject !== name) { event.preventDefault(); event.stopPropagation(); setDropTarget(name); } }}
                onDrop={(event) => { if (dragProject && !system) { event.preventDefault(); event.stopPropagation(); moveProjectTo(dragProject, name); setDragProject(null); setDropTarget(null); } }}>
                {hasChildren
                  ? <button type="button" className="folder-fold" aria-label={open ? `Свернуть проект «${name}»` : `Развернуть проект «${name}»`} aria-expanded={open} onClick={() => setClosedProjects((current) => current.includes(name) ? current.filter((x) => x !== name) : [...current, name])}><ChevronRight size={13} className={open ? "is-open" : undefined} aria-hidden="true" /></button>
                  : <span className="folder-fold-gap" aria-hidden="true" />}
                <button className={`folder-row${noteView === "folder" && folder === name ? " selected" : ""}`} aria-current={noteView === "folder" && folder === name ? "page" : undefined} onClick={() => handleFolderSelect(name)}><Folder size={16} className="folder-icon" /><span>{name === "Архив" ? "Архив · проект" : name}</span><span className="folder-count">{count}</span></button>
                {!system && <button type="button" className="folder-add" aria-label={`Новый вложенный проект в «${name}»`} title="Новый вложенный проект" onClick={() => addFolder(name)}><FolderPlus size={14} aria-hidden="true" /></button>}
              </div>;
            })}
          </section>
          <section className="nav-section notes-section" aria-label="Заметки раздела">
            <div className="section-label"><h2>{noteView === "trash" ? "Корзина" : noteView === "archive" ? "Архив" : noteView === "pinned" ? "Избранное" : noteView === "recent" ? "Недавние" : noteView === "all" ? "Все заметки" : "Заметки"}</h2><span className="notes-tools">{dayFilter !== null && <button type="button" className="day-chip" title="Показать все заметки проекта" onClick={() => setDayFilter(null)}>{new Date(dayFilter).getDate()} {MONTHS_GEN[new Date(dayFilter).getMonth()]} <X size={11} aria-hidden="true" /></button>}{listGroups.some((g) => g.name) && <button type="button" className="icon-button tiny" aria-label="Свернуть или развернуть все группы" title="Свернуть или развернуть все группы" onClick={() => setClosedGroups((current) => current.length > 0 ? [] : listGroups.map((g) => g.name).filter(Boolean))}><ChevronsUpDown size={14} /></button>}<button type="button" className={`icon-button tiny${dayFilter !== null || calendarOpen ? " is-on" : ""}`} aria-label="Календарь: заметки по дням" aria-expanded={calendarOpen} title="Календарь: заметки по дням" onClick={() => setCalendarOpen((open) => !open)}><CalendarDays size={14} /></button><button type="button" className="icon-button tiny" aria-label={notesSort === "modified" ? "Сортировка: по изменению. Нажмите, чтобы сортировать по названию" : "Сортировка: по названию. Нажмите, чтобы сортировать по изменению"} title={notesSort === "modified" ? "Сначала изменённые: нажмите для сортировки по названию" : "По названию: нажмите для сортировки по изменению"} onClick={() => { const next = notesSort === "modified" ? "title" : "modified"; setNotesSort(next); try { window.localStorage.setItem("nh4-notes-sort", next); } catch { /* optional */ } }}><ArrowUpDown size={14} /></button><button type="button" className={`icon-button tiny${notesPreview ? " is-on" : ""}`} aria-pressed={notesPreview} aria-label="Показывать начало текста под названием" title="Начало текста под названием" onClick={() => { const next = !notesPreview; setNotesPreview(next); try { window.localStorage.setItem("nh4-notes-preview", next ? "1" : "0"); } catch { /* optional */ } }}><AlignLeft size={14} /></button><span className="notes-count">{filteredDocs.length}</span></span></div>
            <ul className="notes-list">
              {listGroups.map((group) => <Fragment key={group.name || "all"}>
                {group.name && <li className="notes-group"><button type="button" aria-expanded={!closedGroups.includes(group.name)} onClick={() => setClosedGroups((current) => current.includes(group.name) ? current.filter((x) => x !== group.name) : [...current, group.name])}><ChevronDown size={13} className="notes-group-chevron" aria-hidden="true" />{group.name}<small>{group.items.length}</small></button></li>}
                {!closedGroups.includes(group.name) && group.items.map((doc) => <li key={doc.id}><button className={doc.id === activeId ? "is-current" : undefined} aria-current={doc.id === activeId ? "true" : undefined} title={doc.title} onClick={() => selectDocument(doc)}><FileText size={14} aria-hidden="true" /><span className="note-line"><span className="note-name">{doc.title}</span>{notesPreview && snippetOf(doc) && <small className="note-snippet">{snippetOf(doc)}</small>}</span></button></li>)}
              </Fragment>)}
              {filteredDocs.length === 0 && <li className="notes-empty">В этом разделе нет заметок</li>}
            </ul>
          </section>
          {allTags.length > 0 && <details className="nav-section tags-section" open={tagsOpen || tagFilter !== null} onToggle={(event) => { const open = (event.currentTarget as HTMLDetailsElement).open; setTagsOpen(open); try { window.localStorage.setItem("nh4-tags-open", open ? "1" : "0"); } catch { /* optional */ } }}>
            <summary className="tags-summary"><Hash size={14} aria-hidden="true" /><span>Метки</span><span className="notes-count">{allTags.length}{tagFilter ? ` · ${tagFilter}` : ""}</span><ChevronDown size={14} className="tags-chevron" aria-hidden="true" /></summary>
            <div className="tag-cloud">
              {allTags.map(([tag, count]) => <button key={tag} className={`tag-chip${tagFilter === tag ? " is-on" : ""}`} aria-pressed={tagFilter === tag} title={tagFilter === tag ? "Показать все заметки" : `Только заметки с меткой «${tag}»`} onClick={() => setTagFilter((current) => current === tag ? null : tag)}><Hash size={12} />{tag}<span>{count}</span></button>)}
            </div>
          </details>}
          <div className="sidebar-spacer" />
          <section className="nav-section sections-grid" aria-label="Разделы">
            <button className={`section-tile${noteView === "pinned" ? " selected" : ""}`} aria-current={noteView === "pinned" ? "page" : undefined} onClick={() => switchToSpecialView("pinned")}><Star size={15} aria-hidden="true" /><span>Избранное</span>{pinnedDocs.length > 0 && <b>{pinnedDocs.length}</b>}</button>
            <button className={`section-tile${noteView === "recent" ? " selected" : ""}`} aria-current={noteView === "recent" ? "page" : undefined} onClick={() => switchToSpecialView("recent")}><Clock3 size={15} aria-hidden="true" /><span>Недавние</span></button>
            <button className={`section-tile${noteView === "archive" ? " selected" : ""}`} aria-current={noteView === "archive" ? "page" : undefined} onClick={() => switchToSpecialView("archive")}><Archive size={15} aria-hidden="true" /><span>Архив</span>{docs.some((doc) => doc.archived && !doc.deletedAt) && <b>{docs.filter((doc) => doc.archived && !doc.deletedAt).length}</b>}</button>
            <button className={`section-tile${noteView === "trash" ? " selected" : ""}`} aria-current={noteView === "trash" ? "page" : undefined} onClick={() => switchToSpecialView("trash")}><Trash2 size={15} aria-hidden="true" /><span>Корзина</span>{trashCount > 0 && <b>{trashCount}</b>}</button>
          </section>
          </div>
          <nav className="rail" aria-label="Быстрые разделы">
            <button type="button" className={`rail-button${railMenu === "pinned" ? " is-on" : ""}`} aria-label="Избранное" title="Избранное" aria-expanded={railMenu === "pinned"} onClick={() => setRailMenu((current) => current === "pinned" ? null : "pinned")}><Star size={17} /></button>
            <button type="button" className={`rail-button${railMenu === "recent" ? " is-on" : ""}`} aria-label="Недавние" title="Недавние" aria-expanded={railMenu === "recent"} onClick={() => setRailMenu((current) => current === "recent" ? null : "recent")}><Clock3 size={17} /></button>
            <button type="button" className={`rail-button${noteView === "archive" ? " is-on" : ""}`} aria-label="Архив" title="Архив" onClick={() => switchToSpecialView("archive")}><Archive size={17} /></button>
            <button type="button" className={`rail-button${noteView === "trash" ? " is-on" : ""}`} aria-label="Корзина" title="Корзина" onClick={() => switchToSpecialView("trash")}><Trash2 size={17} />{trashCount > 0 && <span className="rail-badge">{trashCount}</span>}</button>
          </nav>
          <details className="note-toolbar-overflow library-menu settings-menu">
            <summary aria-label="Настройки приложения" title="Настройки приложения"><Settings size={16} /><span>Настройки</span></summary>
            <div className="note-toolbar-menu" onClick={noteMenuClose}>
              <div className="note-toolbar-menu-label">Файлы и данные</div>
              <button onClick={() => (isHosted() ? void handleHostFileOpen() : textInputRef.current?.click())}><FolderOpen size={14} />Открыть файлы…</button>
              <button onClick={handleWindowsImport}><FolderInput size={14} />Перенос из Блокнота Windows (ZIP)…</button>
              {isHosted() && <button onClick={() => void openRefs()}><FolderOpen size={14} />Подтянуть текст из внешних файлов…</button>}
              <div className="note-toolbar-menu-divider" />
              <div className="note-toolbar-menu-label">Резервные копии</div>
              {isHosted() && <><button onClick={() => void createBackupNow()}><Download size={14} />Создать резервную копию (.nhub)…</button><button onClick={() => void restoreBackupNow()}><RotateCcw size={14} />Восстановить из копии (.nhub)…</button></>}
              <button onClick={exportBackup}><Download size={14} />Сохранить копию JSON (только чтение)</button>
              <div className="note-toolbar-menu-divider" />
              <div className="note-toolbar-menu-label">Вид списка заметок</div>
              <button role="menuitemcheckbox" aria-checked={subNotes} onClick={() => setSubNotes((v) => !v)}><Folder size={14} />Заметки вложенных проектов{subNotes ? " · включено" : " · выключено"}</button>
              <button role="menuitemcheckbox" aria-checked={dense} onClick={() => setDense((v) => !v)}><List size={14} />Компактный список{dense ? " · включено" : " · выключено"}</button>
              <div className="note-toolbar-menu-divider" />
              <div className="note-toolbar-menu-label">Внешний вид и справка</div>
              <button aria-label="Переключить тему" onClick={() => setDark((value) => !value)}>{dark ? <Sun size={14} /> : <Moon size={14} />}{dark ? "Светлая тема" : "Тёмная тема"}</button>
              <button onClick={() => setShowShortcuts(true)}><Command size={14} />Сочетания клавиш</button>
            </div>
          </details>
        </aside>
        {calendarOpen && <div className="rail-backdrop" onMouseDown={() => setCalendarOpen(false)}><div className="calendar-pop note-toolbar-menu" role="dialog" aria-label="Календарь" onMouseDown={(event) => event.stopPropagation()}>
          <div className="calendar-head">
            <button type="button" aria-label="Предыдущий месяц" onClick={() => setCalendarMonth((m) => new Date(new Date(m).getFullYear(), new Date(m).getMonth() - 1, 1).getTime())}><ChevronLeft size={15} /></button>
            <strong>{MONTHS_RU[new Date(calendarMonth).getMonth()]} {new Date(calendarMonth).getFullYear()}</strong>
            <button type="button" aria-label="Следующий месяц" onClick={() => setCalendarMonth((m) => new Date(new Date(m).getFullYear(), new Date(m).getMonth() + 1, 1).getTime())}><ChevronRight size={15} /></button>
          </div>
          <div className="calendar-grid" role="grid">
            {["п", "в", "с", "ч", "п", "с", "в"].map((d, i) => <span key={i} className="calendar-dow">{d}</span>)}
            {(() => {
              const first = new Date(calendarMonth);
              const lead = (first.getDay() + 6) % 7;
              const cells: React.ReactElement[] = [];
              for (let i = 0; i < 42; i++) {
                const day = new Date(first.getFullYear(), first.getMonth(), 1 - lead + i);
                const ts = day.getTime();
                const count = dayCounts.get(ts) ?? 0;
                const other = day.getMonth() !== first.getMonth();
                cells.push(<button key={i} type="button" className={`calendar-day${other ? " is-other" : ""}${ts === startOfDay(Date.now()) ? " is-today" : ""}${dayFilter === ts ? " is-selected" : ""}${count > 0 ? " has-notes" : ""}`} title={count > 0 ? `Заметок: ${count}` : "Нет заметок"} onClick={() => { setDayFilter(dayFilter === ts ? null : ts); setCalendarOpen(false); }}>{day.getDate()}{count > 0 && <i aria-hidden="true" />}</button>);
              }
              return cells;
            })()}
          </div>
          <div className="calendar-foot">
            <button type="button" onClick={() => { const d = new Date(); setCalendarMonth(new Date(d.getFullYear(), d.getMonth(), 1).getTime()); setDayFilter(startOfDay(Date.now())); setCalendarOpen(false); }}>Сегодня</button>
            <button type="button" onClick={() => { setCalendarOpen(false); openDailyNote(); }}>Заметка за сегодня</button>
            {dayFilter !== null && <button type="button" onClick={() => { setDayFilter(null); setCalendarOpen(false); }}>Показать все</button>}
          </div>
        </div></div>}
        {railMenu && <div className="rail-backdrop" onMouseDown={() => setRailMenu(null)}><div className="rail-pop note-toolbar-menu" role="menu" aria-label={railMenu === "pinned" ? "Избранные заметки" : "Недавние заметки"} onMouseDown={(event) => event.stopPropagation()}>
          <div className="rail-pop-title">{railMenu === "pinned" ? "Избранное" : "Недавние"}</div>
          {(railMenu === "pinned" ? pinnedDocs : recentDocs).slice(0, 12).map((doc) => <button key={doc.id} role="menuitem" onClick={() => { setNoteView("folder"); setFolder(doc.folder); selectDocument(doc); }}><FileText size={14} aria-hidden="true" /><span>{doc.title}</span></button>)}
          {(railMenu === "pinned" ? pinnedDocs : recentDocs).length === 0 && <div className="rail-pop-empty">{railMenu === "pinned" ? "Закреплённых заметок пока нет. Закрепите заметку в меню «⋯»." : "Недавно открытых заметок пока нет."}</div>}
        </div></div>}

        <main className="main-panel">
          {focusMode && <button type="button" className="focus-exit" onClick={() => setFocusMode(false)} title="Вернуть панели (F11)"><X size={14} aria-hidden="true" />Выйти из режима фокуса</button>}
          <div className="document-tabs">
            {tabsEdge.overflow && <button type="button" className="tabs-arrow" aria-label="Прокрутить вкладки влево" title="Влево" disabled={!tabsEdge.left} onClick={() => tabsScrollerRef.current?.scrollBy({ left: -280, behavior: "smooth" })}><ChevronLeft size={16} /></button>}
            <div className="tabs-scroller" ref={tabsScrollerRef}>
              <div className="tab-list" role={openTabs.length > 0 ? "tablist" : undefined} aria-label={openTabs.length > 0 ? `Открытые заметки: ${viewTitle}` : undefined}>
              {openTabs.map((doc, index) => <div key={doc.id} className={`tab-wrap${doc.id === activeId ? " is-active" : ""}`} onContextMenu={(event) => { event.preventDefault(); setTabMenu({ x: event.clientX, y: event.clientY, id: doc.id }); }} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); void closeTab(doc.id); } }}>
                <button id={`note-tab-${doc.id}`} data-tab-index={index} role="tab" aria-controls="editor-workspace-panel" aria-selected={doc.id === activeId} tabIndex={doc.id === activeId ? 0 : -1} className={`tab${doc.id === activeId ? " active-tab" : ""}`} title={`${doc.title} (Delete — в корзину, Ctrl+W — закрыть, правая кнопка — меню)`} onKeyDown={(event) => handleTabKeyDown(event, index)} onClick={() => selectDocument(doc)}>{doc.pinned && <Star size={11} className="tab-pin" aria-label="Закреплена" />}<span>{doc.title}</span></button>
                <button className="tab-close" tabIndex={-1} aria-hidden="true" title="Закрыть вкладку (изменения сохранятся)" onClick={() => void closeTab(doc.id)}><X size={13} /></button>
              </div>)}
              </div>
              <button className="new-tab" aria-label="Быстро создать заметку" title="Новая заметка" onClick={addDocument}><Plus size={17} /></button>
              {openTabs.length === 0 && <span className="tabs-empty">Нет открытых заметок</span>}
            </div>
            {tabsEdge.overflow && <button type="button" className="tabs-arrow" aria-label="Прокрутить вкладки вправо" title="Вправо" disabled={!tabsEdge.right} onClick={() => tabsScrollerRef.current?.scrollBy({ left: 280, behavior: "smooth" })}><ChevronRight size={16} /></button>}
            {filteredDocs.length > 0 && <details className="note-toolbar-overflow tabs-all">
              <summary aria-label={`Все заметки раздела: ${filteredDocs.length}`} title="Все заметки раздела"><List size={16} /><span>{filteredDocs.length}</span></summary>
              <div className="note-toolbar-menu tabs-all-menu" role="listbox" aria-label="Все заметки раздела" onClick={noteMenuClose}>
                {filteredDocs.map((doc) => <button key={doc.id} role="option" aria-selected={doc.id === activeId} className={doc.id === activeId ? "is-current" : undefined} onClick={() => selectDocument(doc)}><FileText size={14} /><span>{doc.title}</span></button>)}
              </div>
            </details>}
          </div>
          {secondId && activeDoc && !trashPane && <SplitBar leftId={activeDoc.id} rightId={secondId} notes={splitCandidates().map((doc) => ({ id: doc.id, title: doc.title }))} onPickLeft={(id) => { const doc = docs.find((item) => item.id === id); if (doc) selectDocument(doc); }} onPickRight={setSecondId} onMoveRight={() => moveSelection("left")} onMoveLeft={() => moveSelection("right")} onCompare={() => setCompareOpen(true)} onSwap={swapNotes} onClose={() => setSecondId(null)} />}
          {trashPane && noteView === "trash" && <TrashView items={docs.filter((doc) => doc.deletedAt).sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt))).map((doc) => ({ id: doc.id, title: doc.title, deletedAt: String(doc.deletedAt) }))} onRestore={restoreFromTrash} onDeleteForever={deleteOneForever} onEmpty={emptyTrash} onOpen={(id) => { const doc = docsRef.current.find((item) => item.id === id); if (doc) selectDocument(doc); }} />}
          {!activeDoc && !trashPane && <div className="empty-notes" role="region" aria-label="Нет открытых заметок">
            <FileText size={34} aria-hidden="true" />
            <h2>Нет открытых заметок</h2>
            <p>Создайте заметку или откройте файл. Вставьте текст или картинку прямо в редактор.</p>
            <div><button className="empty-primary" onClick={addDocument}><Plus size={15} />Новая заметка</button><button onClick={() => (isHosted() ? void handleHostFileOpen() : textInputRef.current?.click())}><FolderOpen size={15} />Открыть файлы…</button></div>
          </div>}
          <div id="editor-workspace-panel" className={`editor-scroll${secondId ? " is-split" : ""}`} hidden={!activeDoc || trashPane} role="tabpanel" aria-label={activeDoc ? undefined : "Редактор заметки"} aria-labelledby={activeDoc ? `note-tab-${activeDoc.id}` : undefined} tabIndex={0}>
            <div className="editor-column">
              {find && <FindBar host={editor._tiptapEditor as unknown as FindHost} initialTerm={find.term} withReplace={find.replace} onClose={() => { setFind(null); editor.focus(); }} onToggleReplace={() => setFind((c) => c && ({ replace: !c.replace }))} />}
              <div className="editor-card" style={{ "--editor-zoom": zoom / 100 } as React.CSSProperties} onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={(e) => void handleDrop(e)}><BlockNoteView editor={editor} theme={dark ? "dark" : "light"} onChange={handleEditorChange} slashMenu sideMenu={false} /></div>
              {activeDoc && (() => {
                const outgoing = linkIndex.outgoing(activeDoc.id);
                const back = linkIndex.backlinks(activeDoc.id);
                if (back.length + outgoing.length === 0) return null;
                return <details className="links-panel" open={back.length > 0 || undefined}>
                  <summary><Hash size={14} aria-hidden="true" />Связи<span>{back.length} обратных · {outgoing.length} исходящих</span></summary>
                  <div className="links-grid">
                    <div><h3>Упоминают эту заметку</h3>{back.length ? back.map((item) => <button key={item.id} className="link-row" onClick={() => openLinkByTitle(item.title)}><b>{item.title}</b><small>{item.snippet}</small></button>) : <p>Пока никто не ссылается. Напишите [[{activeDoc.title}]] в другой заметке.</p>}</div>
                    <div><h3>Ссылки отсюда</h3>{outgoing.length ? outgoing.map((item) => <button key={item.target} className={`link-row${item.id ? "" : " is-missing"}`} onClick={() => openLinkByTitle(item.target)}><b>{item.target}</b><small>{item.id ? "Открыть заметку" : "Заметки нет — нажмите, чтобы создать"}</small></button>) : <p>В тексте нет ссылок. Ctrl+L — вставить [[ссылку]].</p>}</div>
                  </div>
                </details>;
              })()}
              <input ref={textInputRef} className="visually-hidden" type="file" accept=".txt,text/plain" onChange={handleTextFileOpen} aria-label="Выбрать текстовый файл" />
            </div>
            {secondId && <div className="editor-column second-column" aria-label="Вторая заметка">
              <div className="editor-card second-card"><BlockNoteView editor={editor2} theme={dark ? "dark" : "light"} onChange={handleSecondChange} slashMenu sideMenu={false} /></div>
            </div>}
            {activeInspector === "properties" && <Inspector headings={headingsOf} onJump={jumpToBlock} onClose={() => setActiveInspector(null)} activeDoc={activeDoc} folder={folder} onMove={moveActiveNote} />}
          </div>
          <footer className="statusbar" aria-label="Служебная строка">
            <div className="status-left">
              <span className={`status-save is-${saveState}`} role="status" aria-live="polite" title={savedAt}>{saveState === "saved" ? <Check size={14} aria-hidden="true" /> : saveState === "saving" ? <LoaderCircle size={14} className="ai-spinner" aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}{saveState === "saved" ? "Сохранено" : saveState === "saving" ? "Сохраняется…" : "Не сохранено"}{saveState === "error" && <small>{savedAt.replace(/^Не сохранено:?\s*/i, "").slice(0, 70)}</small>}</span>
              {activeDoc?.modifiedAt && <><span className="status-divider" aria-hidden="true">·</span><span className="status-modified" title="Когда заметку изменили в последний раз">Изменено {new Date(activeDoc.modifiedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></>}
              {activeDoc && backlinkCount > 0 && <><span className="status-divider" aria-hidden="true">·</span><button className="status-links" title="Заметки, которые ссылаются на эту: показать" onClick={() => { const panel = document.querySelector<HTMLDetailsElement>(".links-panel"); if (panel) { panel.open = true; panel.scrollIntoView({ block: "center", behavior: "smooth" }); } }}><Link2 size={13} aria-hidden="true" />Обратных ссылок: {backlinkCount}</button></>}
              {activeDoc && <><span className="status-divider" aria-hidden="true">·</span>
              <button className="status-tags" title="Метки заметки: изменить" onClick={() => setFormDialog({ kind: "tag", title: "Метки заметки", value: tags[activeDoc.id] ?? "", hint: "Метки через запятую" })}><Hash size={13} aria-hidden="true" />{noteTagList.length > 0 ? noteTagList.map((tag) => <span key={tag} className="status-tag">{tag}</span>) : <span className="status-tags-empty">добавить метки</span>}</button></>}
            </div>
            <div className="status-right">
              <span title="Слов и знаков в заметке">{noteStats.words.toLocaleString("ru")} {plural(noteStats.words, ["слово", "слова", "слов"])} · {noteStats.chars.toLocaleString("ru")} {plural(noteStats.chars, ["знак", "знака", "знаков"])}</span>
              <span className="status-divider" aria-hidden="true">·</span>
              <span className="status-zoom" role="group" aria-label="Масштаб текста">
                <button aria-label="Уменьшить масштаб текста" title="Уменьшить (Ctrl −)" disabled={zoom <= 70} onClick={() => setZoom((z) => Math.max(70, z - 10))}><Minus size={13} /></button>
                <button className="status-zoom-value" title="Вернуть 100% (Ctrl 0). Масштаб: Ctrl +, Ctrl −, Ctrl и колесо мыши" onClick={() => setZoom(100)}>{zoom}%</button>
                <button aria-label="Увеличить масштаб текста" title="Увеличить (Ctrl +)" disabled={zoom >= 200} onClick={() => setZoom((z) => Math.min(200, z + 10))}><Plus size={13} /></button>
              </span>
              <span className="status-divider" aria-hidden="true">·</span>
              <button onClick={() => setShowShortcuts(true)} title="Сочетания клавиш (F1)" aria-label="Сочетания клавиш"><Command size={14} /></button>
            </div>
          </footer>
        </main>
      </div>

      {aiSelection && <div className="selection-ai-toolbar" role="toolbar" aria-label="AI-действия с выделением" style={{ top: aiSelection.top, left: aiSelection.left }}>
        <button onMouseDown={(event) => event.preventDefault()} onClick={() => openAiAssistant("selection")}><Sparkles size={15} /> Спросить AI <kbd>Ctrl J</kbd></button>
      </div>}
      {activeInspector === "ai" && <div className="ai-resizer" role="separator" aria-orientation="vertical" aria-valuenow={aiWidth} aria-valuemin={340} aria-valuemax={640} aria-label="Ширина AI-помощника (перетащите; двойной щелчок — по умолчанию)" tabIndex={0} onPointerDown={startAiResize} onDoubleClick={() => setAiWidth(400)} onKeyDown={(event) => { if (event.key === "ArrowLeft") setAiWidth((w) => Math.min(640, w + 20)); else if (event.key === "ArrowRight") setAiWidth((w) => Math.max(340, w - 20)); }} />}
      {activeInspector === "ai" && <AiAssistantPanel
        compactMode={aiCompactMode}
        onExpandAdvanced={() => setAiCompactMode(false)}
        provider={aiProvider}
        onProviderChange={(provider) => { setAiProvider(provider); setAiModel(""); setAiProposal(null); setAiError(""); }}
        model={aiModel}
        onModelChange={setAiModel}
        models={aiModels}
        modelsLoading={aiModelsLoading}
        modelsError={aiModelsError}
        hiddenModels={aiHiddenModels}
        providers={aiProviders}
        scope={aiScope}
        linkedTitles={linkedContext.titles.length ? linkedContext.titles : linkedDocs.map((doc) => doc.title)}
        onScopeChange={setAiScope}
        contextText={aiContextText}
        instruction={aiInstruction}
        onInstructionChange={setAiInstruction}
        writingRule={aiWritingRule}
        onWritingRuleChange={setAiWritingRule}
        onSaveWritingRule={saveWritingRule}
        consent={aiRemoteConsent}
        onConsentChange={setAiRemoteConsent}
        pending={aiPending}
        streamText={aiStreamText}
        firstTokenMs={aiFirstTokenMs}
        elapsedMs={aiElapsedMs}
        error={aiError}
        proposal={aiProposal}
        estimatedCost={estimatedAiCost}
        canRun={Boolean(activeDoc && !activeDoc.deletedAt && aiModel && selectedModel
          && (aiProvider === "ollama" ? aiProviders?.ollama.configured : aiProvider === "compat" ? aiProviders?.compat?.configured : aiProviders?.openrouter.configured)
          && (aiProvider === "ollama" || (aiProvider === "compat" ? (aiRemoteConsent || (aiProviders?.compat?.local && !cloudModelName(aiModel))) : (aiRemoteConsent && (selectedModel.free || estimatedAiCost !== null)))))}
        onImage={openImageDialog}
        canImage={Boolean(activeDoc && !activeDoc.deletedAt)}
        canFormat={Boolean(activeDoc && !activeDoc.deletedAt && formatJob === null)}
        onRun={(operation) => { if (operation === "structure") runAutoFormat(); else if (operation === "custom" && !aiContextText.trim()) { setAiScope("note"); void requestAiTask("custom", { scope: "note" }); } else void requestAiTask(operation); }}
        transformations={transformationList}
        onManageTransformations={() => setTransformationsOpen(true)}
        onAsk={(question) => { setAiScope("note"); void requestAiTask("custom", { scope: "note", instruction: ("Ответь на вопрос по тексту заметки, опираясь только на её содержимое; если в тексте ответа нет, так и скажи. Вопрос: " + question).slice(0, 1000), insightTitle: ("Ответ: " + question).slice(0, 80) }); }}
        onRunTransformation={(id) => { const step = findTransformation(id); if (!step) return; const linked = step.mode === "analyze" && aiScope === "linked"; const scope: AiScope = linked ? "linked" : "note"; setAiScope(scope); void requestAiTask(step.mode === "analyze" ? "analyze" : "custom", { scope, instruction: step.prompt, ...(linked ? {} : { insightTitle: step.title }) }); }}
        onCancel={cancelAiTask}
        onAccept={acceptAiProposal}
        onReject={() => { setAiProposal(null); setAiError(""); setAiStreamText(""); }}
        onCitation={handleAiCitation}
        onClose={closeAiAssistant}
        keyManager={isHosted() ? {
          onSave: async (key) => { await host.aiSetKey(key); setAiProviders((await getAiProviders()).providers); },
          onClear: async () => { await host.aiClearKey(); setAiProviders((await getAiProviders()).providers); },
          onSaveCompat: async (baseUrl, name, key) => { await host.aiCompatSave(baseUrl, name, key); setAiProviders((await getAiProviders()).providers); setAiModels([]); setAiProvider("compat"); setAiModelsReload((n) => n + 1); },
          onClearCompat: async () => { await host.aiCompatClear(); setAiProviders((await getAiProviders()).providers); setAiModels([]); setAiModel(""); setAiModelsReload((n) => n + 1); },
        } : undefined}
      />}
      {conflictDialog && <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConflictDialog(null); }}><div className="form-modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <div className="form-modal-heading"><div><h2 id="conflict-title">Файл изменён другой программой</h2><p>Пока вы правили заметку, файл на диске изменился. Запись в файл остановлена, ничего не потеряно.</p></div><button type="button" className="icon-button" aria-label="Закрыть" onClick={() => setConflictDialog(null)}><X size={18} /></button></div>
        <div className="conflict-actions">
          <button className="form-submit" autoFocus onClick={() => void resolveConflict(conflictDialog, "mine")}>Оставить мою версию<small>Файл будет перезаписан; прежнюю версию файла сохраним в резервных копиях</small></button>
          <button onClick={() => void resolveConflict(conflictDialog, "disk")}>Взять версию с диска<small>Мой текст останется в истории версий</small></button>
          <button className="form-cancel" onClick={() => setConflictDialog(null)}>Решить позже</button>
        </div>
      </div></div>}
      {showShortcuts && <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowShortcuts(false); }}><div className="form-modal shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div className="form-modal-heading"><div><h2 id="shortcuts-title">Сочетания клавиш</h2><p>Работают в любой раскладке клавиатуры</p></div><button type="button" className="icon-button" aria-label="Закрыть" autoFocus onClick={() => setShowShortcuts(false)}><X size={18} /></button></div>
        {SHORTCUT_HELP.map((group) => <section key={group.group}><h3>{group.group}</h3><dl>{group.items.map((item) => <div key={item.keys}><dt>{item.keys.split(" ").map((part, i) => /^[/+−0]$|^[A-Za-z]+$/.test(part) ? <kbd key={i}>{part}</kbd> : <span key={i}> {part} </span>)}</dt><dd>{item.label}</dd></div>)}</dl></section>)}
      </div></div>}
      {linkPicker && <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setLinkPicker(null); }}><div className="form-modal link-picker" role="dialog" aria-modal="true" aria-labelledby="link-picker-title">
        <div className="form-modal-heading"><div><h2 id="link-picker-title">Ссылка на заметку</h2><p>Вставит [[название]] в текст</p></div><button type="button" className="icon-button" aria-label="Закрыть" onClick={() => setLinkPicker(null)}><X size={18} /></button></div>
        <input autoFocus value={linkPicker.query} aria-label="Название заметки" placeholder="Начните вводить название" onChange={(event) => setLinkPicker({ query: event.target.value, index: 0 })}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setLinkPicker((c) => c && { ...c, index: Math.min(c.index + 1, Math.max(0, pickerDocs.length - 1)) }); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setLinkPicker((c) => c && { ...c, index: Math.max(0, c.index - 1) }); }
            else if (event.key === "Enter") { event.preventDefault(); const pick = pickerDocs[linkPicker.index]; if (pick) insertLink(pick.title); else if (linkPicker.query.trim()) insertLink(linkPicker.query); }
          }} />
        <div role="listbox" aria-label="Заметки" className="link-picker-list">{pickerDocs.map((doc, index) => <button key={doc.id} role="option" aria-selected={index === linkPicker.index} className={index === linkPicker.index ? "is-current" : ""} onMouseEnter={() => setLinkPicker((c) => c && { ...c, index })} onClick={() => insertLink(doc.title)}><FileText size={14} /><span>{doc.title}</span><small>{doc.folder}</small></button>)}
          {pickerDocs.length === 0 && <p className="search-empty">{linkPicker.query.trim() ? "Такой заметки нет — Enter вставит ссылку на новую" : "Нет других заметок"}</p>}</div>
      </div></div>}
      {formDialog && <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFormDialog(null); }}><form className="form-modal" role="dialog" aria-modal="true" aria-labelledby="form-title" onSubmit={submitFormDialog}><div className="form-modal-heading"><div><h2 id="form-title">{formDialog.title}</h2><p>{formDialog.hint}</p></div><button type="button" className="icon-button" aria-label="Закрыть" onClick={() => setFormDialog(null)}><X size={18} /></button></div><input autoFocus value={formDialog.value} onChange={(event) => setFormDialog((current) => current ? { ...current, value: event.target.value } : current)} aria-label={formDialog.title} placeholder={formDialog.hint} /><div className="form-modal-actions"><button type="button" className="form-cancel" onClick={() => setFormDialog(null)}>Отмена</button><button type="submit" className="form-submit">Готово</button></div></form></div>}
      {refs && <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setRefs(null); }}><div className="form-modal history-modal" role="dialog" aria-modal="true" aria-labelledby="refs-title">
        <div className="form-modal-heading"><div><h2 id="refs-title">Подтянуть текст из внешних файлов</h2><p>Эти заметки пришли из Блокнота Windows без текста: он хранился в файлах на диске. Выберите, какие файлы прочитать.</p></div><button type="button" className="icon-button" aria-label="Закрыть" onClick={() => setRefs(null)}><X size={18} /></button></div>
        {refs.loading && <p role="status">Поиск…</p>}
        {refs.error && <p role="alert">{refs.error}</p>}
        {!refs.loading && refs.files.length === 0 && !refs.error && <p>Подходящих файлов нет: либо заметки уже заполнены, либо файлы удалены или не являются текстовыми.</p>}
        <ul className="history-list" aria-label="Файлы для чтения">{refs.files.map((file) => <li key={file.id}><label className="refs-row"><input type="checkbox" checked={refs.picked.includes(file.id)} onChange={(event) => setRefs((current) => current ? { ...current, picked: event.target.checked ? [...current.picked, file.id] : current.picked.filter((id) => id !== file.id) } : current)} /><span><strong>{file.title}</strong><small>{file.sourcePath} · {Math.max(1, Math.round(file.bytes / 1024))} КБ</small></span></label></li>)}</ul>
        {refs.files.length > 0 && <div className="form-modal-actions"><button type="button" className="form-cancel" onClick={() => setRefs(null)}>Отмена</button><button type="button" className="form-submit" disabled={refs.picked.length === 0} onClick={() => void applyRefs()}>Подтянуть выбранные ({refs.picked.length})</button></div>}
      </div></div>}
      {history && <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistory(null); }}><div className="form-modal history-modal" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <div className="form-modal-heading"><div><h2 id="history-title">История версий</h2><p>{activeDoc?.title}</p></div><button type="button" className="icon-button" aria-label="Закрыть" onClick={() => setHistory(null)}><X size={18} /></button></div>
        {history.loading && <p role="status">Загрузка…</p>}
        {history.error && <p role="alert">{history.error}</p>}
        {!history.loading && history.entries.length === 0 && !history.error && <p>Прежних версий пока нет. Они появляются, когда вы меняете текст заметки.</p>}
        <ul className="history-list" aria-label="Версии заметки">{history.entries.map((entry) => <li key={entry.name}><button type="button" aria-pressed={history.selected === entry.name} onClick={() => void previewVersion(entry.name)}><strong>{entry.timestampLocal}</strong><small>{entry.preview || "(пусто)"}</small></button></li>)}</ul>
        {history.selected && <><pre className="history-preview" aria-label="Содержимое версии">{history.preview}</pre><div className="form-modal-actions"><button type="button" className="form-cancel" onClick={() => setHistory(null)}>Закрыть</button><button type="button" className="form-submit" onClick={() => void restoreVersion(history.selected!)}>Восстановить эту версию</button></div></>}
      </div></div>}
      {imageDialog?.kind === "generate" && <ImageGenerateDialog initialPrompt={imageDialog.prompt} initialConsent={aiRemoteConsent} autoStart={Boolean(imageDialog.prompt)} suggestSelection={imageDialog.selection} suggestNote={imageDialog.note} serviceReady={Boolean(aiProviders?.compat?.configured)} serviceName={aiProviders?.compat?.name ?? ""} onInsert={insertGeneratedImage} onClose={() => setImageDialog(null)} />}
      {imageDialog?.kind === "edit" && <ImageEditDialog images={noteImages()} startId={imageDialog.startId} onReplace={replaceImage} onClose={() => setImageDialog(null)} />}
      {metaDialog && <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMetaDialog(null); }}><form className="form-modal" role="dialog" aria-modal="true" aria-labelledby="meta-title" onSubmit={applyMetaDialog}>
        <div className="form-modal-heading"><div><h2 id="meta-title">Название и метки</h2><p role="status">{metaDialog.ai === "work" || metaDialog.ai === "wait" ? <LoaderCircle size={13} className="ai-spinner" /> : null} {metaDialog.note}</p></div><button type="button" className="icon-button" aria-label="Закрыть" onClick={() => setMetaDialog(null)}><X size={18} /></button></div>
        <label className="meta-field"><span>Название</span><input autoFocus value={metaDialog.title} onChange={(event) => setMetaDialog((current) => current ? { ...current, title: event.target.value } : current)} placeholder="Название заметки" /></label>
        <label className="meta-field"><span>Метки через запятую</span><input value={metaDialog.tags} onChange={(event) => setMetaDialog((current) => current ? { ...current, tags: event.target.value } : current)} placeholder="например: кошки, привычки" /></label>
        <div className="form-modal-actions"><button type="button" className="form-cancel" onClick={() => setMetaDialog(null)}>Отмена</button><button type="submit" className="form-submit">Применить</button></div>
      </form></div>}
      {transformationsOpen && <TransformationsDialog list={transformationList} onSave={saveCustomTransformations} onProbe={probeTransformation} onClose={() => setTransformationsOpen(false)} />}
      {compareOpen && secondId && <CompareDialog leftTitle={activeDoc?.title ?? ""} rightTitle={docs.find((doc) => doc.id === secondId)?.title ?? ""} left={paragraphsOf(editor.document as never)} right={paragraphsOf(editor2.document as never)} onCopyRight={(text) => appendParagraph(text, "right")} onCopyLeft={(text) => appendParagraph(text, "left")} onClose={() => setCompareOpen(false)} />}
      {confirmDialog && <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmDialog(null); }}><div className="form-modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text">
        <div className="form-modal-heading"><div><h2 id="confirm-title">{confirmDialog.title}</h2><p id="confirm-text">{confirmDialog.message}</p></div></div>
        <div className="form-modal-actions"><button type="button" className="form-cancel" autoFocus onClick={() => setConfirmDialog(null)}>Отмена</button><button type="button" className={`form-submit${confirmDialog.danger ? " is-danger" : ""}`} onClick={() => { const run = confirmDialog.run; setConfirmDialog(null); run(); }}>{confirmDialog.confirm}</button></div>
      </div></div>}
      {tabMenu && <div className="tab-menu-backdrop" onMouseDown={() => setTabMenu(null)} onContextMenu={(event) => { event.preventDefault(); setTabMenu(null); }}><div className="note-toolbar-menu tab-menu" role="menu" style={{ left: Math.min(tabMenu.x, window.innerWidth - 220), top: tabMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
        <button role="menuitem" onClick={() => { const id = tabMenu.id; setTabMenu(null); void closeTab(id); }}>Закрыть вкладку</button>
        <button role="menuitem" onClick={() => { const id = tabMenu.id; setTabMenu(null); setSecondId(id); }}>Открыть справа (две заметки)</button>
        <button role="menuitem" className="destructive-action" onClick={() => requestTrash(tabMenu.id)}><Trash2 size={14} />В корзину…</button>
      </div></div>}
      {notice && <div className="toast"><Check size={15} />{notice}{toastAction && <button type="button" className="toast-action" onClick={() => { const run = toastAction.run; setToastAction(null); run(); }}>{toastAction.label}</button>}</div>}
    </div>
  );
}





