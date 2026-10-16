// Bridge to the native host (WebView2). Contract v1 — see docs/adr/0003-bridge-contract.md.
// The page never touches the file system: every path and every byte of user data goes through these calls.
// Outside the host (plain browser: dev server, orca-ui, Playwright) an in-memory mock answers the same calls.

export const CONTRACT = 1;

export type HostProject = { id: string; name: string; order: number; isSystem: boolean; showInTabs: boolean };
export type HostNote = {
  id: string; title: string; projectId: string; tags: string;
  createdUtc: string; updatedUtc: string; lastOpenedUtc: string;
  isPinned: boolean; isArchived: boolean; isDeleted: boolean; externalOnly: boolean;
  legacySourceGuid: string; sourcePath: string; sourceType: string; contentType: string; writeThrough?: boolean;
  content: string; blocksJson: string | null;
};
export type HostSettings = { activeProjectId: string; selectedNoteId: string; theme: "system" | "light" | "dark"; sidebarVisible: boolean };
export type Bootstrap = { contract: number; hostVersion: string; mode: "host" | "mock"; projects: HostProject[]; notes: HostNote[]; settings: HostSettings };
export type UpsertNote = {
  id: string; projectId: string; title: string; tags: string; pinned: boolean; archived: boolean; deleted: boolean;
  content?: string; blocksJson?: string;
};
export type HistoryEntry = { name: string; timestampLocal: string; bytes: number; preview: string };
export type ImportSummary = { created: number; updated: number; skipped: number; emptyWithExternalFile: number; warnings: string[]; cancelled?: boolean };

export class HostError extends Error {
  constructor(public code: string, message: string, public status?: number) { super(message); }
}

type Transport = (type: string, payload: unknown) => Promise<unknown>;

// ------------------------------------------------------------------ real host (WebView2)

type WebViewApi = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: "message", handler: (e: { data: unknown }) => void) => void;
};

function webview(): WebViewApi | undefined {
  return (window as unknown as { chrome?: { webview?: WebViewApi } }).chrome?.webview;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number };
const pending = new Map<number, Pending>();
let nextId = 1;
const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
let listening = false;

function ensureListener(wv: WebViewApi) {
  if (listening) return;
  listening = true;
  wv.addEventListener("message", (e) => {
    const m = e.data as { id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string; status?: number }; event?: string; payload?: unknown } | null;
    if (!m || typeof m !== "object") return;
    if (typeof m.id === "number") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      window.clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new HostError(m.error?.code ?? "error", m.error?.message ?? "Ошибка хоста", m.error?.status));
    } else if (typeof m.event === "string") {
      eventHandlers.get(m.event)?.forEach((h) => h(m.payload));
    }
  });
}

const hostTransport = (wv: WebViewApi): Transport => (type, payload) => {
  ensureListener(wv);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = window.setTimeout(() => { pending.delete(id); reject(new HostError("timeout", `Хост не ответил на «${type}»`)); }, 120_000);
    pending.set(id, { resolve, reject, timer });
    wv.postMessage({ contract: CONTRACT, id, type, payload });
  });
};

export function onHostEvent(event: string, handler: (payload: unknown) => void): () => void {
  const wv = webview();
  if (wv) ensureListener(wv);
  const set = eventHandlers.get(event) ?? new Set();
  set.add(handler);
  eventHandlers.set(event, set);
  return () => set.delete(handler);
}

// ------------------------------------------------------------------ in-memory mock for browser development

function createMock(): Transport {
  const now = () => new Date().toISOString();
  const projects: HostProject[] = [
    { id: "inbox", name: "Входящие", order: 0, isSystem: true, showInTabs: true },
    { id: "import-windows", name: "Импорт Windows", order: 9999, isSystem: true, showInTabs: false },
  ];
  const notes = new Map<string, HostNote>();
  const settings: HostSettings = { activeProjectId: "inbox", selectedNoteId: "", theme: "light", sidebarVisible: true };
  const seed = (id: string, title: string, content: string) => notes.set(id, {
    id, title, projectId: "inbox", tags: "", createdUtc: now(), updatedUtc: now(), lastOpenedUtc: "", isPinned: false, isArchived: false,
    isDeleted: false, externalOnly: false, legacySourceGuid: "", sourcePath: "", sourceType: "local", contentType: "text", content, blocksJson: null,
  });
  seed("demo1", "Первая заметка", "# Первая заметка\nЭто демонстрационные данные: хост не подключён.\n- [ ] проверить сохранение");
  seed("demo2", "Список дел", "купить хлеб\nпозвонить\n\n1. раз\n2. два");
  return async (type, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    switch (type) {
      case "bootstrap": return { contract: CONTRACT, hostVersion: "mock", mode: "mock", projects: structuredClone(projects), notes: [...notes.values()].map((n) => structuredClone(n)), settings: { ...settings } } satisfies Bootstrap;
      case "createProject": {
        const name = String(p.name ?? "").trim();
        const found = projects.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (found) return found;
        const proj = { id: crypto.randomUUID().replace(/-/g, ""), name, order: projects.length, isSystem: false, showInTabs: true };
        projects.push(proj); return proj;
      }
      case "upsertNote": {
        const u = p as unknown as UpsertNote;
        const cur = notes.get(u.id) ?? { id: u.id, createdUtc: now(), lastOpenedUtc: "", externalOnly: false, legacySourceGuid: "", sourcePath: "", sourceType: "local", contentType: "text", content: "", blocksJson: null } as HostNote;
        Object.assign(cur, { title: u.title, projectId: u.projectId, tags: u.tags, isPinned: u.pinned, isArchived: u.archived, isDeleted: u.deleted, updatedUtc: now() });
        if (u.content !== undefined) { cur.content = u.content; cur.blocksJson = u.blocksJson ?? null; }
        notes.set(u.id, cur); return { id: cur.id, updatedUtc: cur.updatedUtc };
      }
      case "deleteNote": notes.delete(String(p.id)); return {};
      case "saveSettings": Object.assign(settings, p); return {};
      case "listHistory": return [];
      case "readHistory": return "";
      case "importWindowsSnapshot": return { created: 0, updated: 0, skipped: 0, emptyWithExternalFile: 0, warnings: ["В режиме без хоста импорт недоступен."], cancelled: true } satisfies ImportSummary;
      case "openFiles": return { created: [], cancelled: true };
      case "flushAck": return {};
      case "checkpoint": return {};
      case "previewReferencedFiles": return { files: [] };
      case "resolveReferencedFiles": return { filled: 0 };
      case "createBackup": case "restoreBackup": return { cancelled: true };
      default: throw new HostError("unknown", `Команда «${type}» недоступна без хоста`);
    }
  };
}

let transport: Transport | null = null;
function getTransport(): Transport {
  if (transport) return transport;
  const wv = webview();
  transport = wv ? hostTransport(wv) : createMock();
  return transport;
}

export const isHosted = () => Boolean(webview());

const call = <T,>(type: string, payload?: unknown) => getTransport()(type, payload) as Promise<T>;
export const callHost = <T = unknown,>(type: string, payload?: unknown) => call<T>(type, payload);

export const host = {
  bootstrap: () => call<Bootstrap>("bootstrap"),
  createProject: (name: string) => call<HostProject>("createProject", { name }),
  upsertNote: (note: UpsertNote) => call<{ id: string; updatedUtc: string }>("upsertNote", note),
  deleteNote: (id: string) => call<Record<string, never>>("deleteNote", { id }),
  saveSettings: (s: Partial<HostSettings>) => call<Record<string, never>>("saveSettings", s),
  listHistory: (id: string) => call<HistoryEntry[]>("listHistory", { id }),
  readHistory: (id: string, name: string) => call<string>("readHistory", { id, name }),
  importWindowsSnapshot: () => call<ImportSummary>("importWindowsSnapshot"),
  setWriteThrough: (id: string, enabled: boolean) => call<{ id: string; enabled: boolean }>("setWriteThrough", { id, enabled }),
  resolveSourceConflict: (id: string, choice: "mine" | "disk") => call<{ id: string; updatedUtc: string }>("resolveSourceConflict", { id, choice }),
  saveAsset: (data: string) => call<{ file: string }>("saveAsset", { data }),
  fetchImage: (url: string) => call<{ file: string }>("fetchImage", { url }),
  readAsset: (name: string) => call<{ data: string }>("readAsset", { name }),
  generateImage: (prompt: string, width: number, height: number, via: string, model: string, consent: boolean) => call<{ file: string }>("generateImage", { prompt, width, height, via, model, consent }),
  openFiles: () => call<{ created: string[]; cancelled?: boolean; warnings?: string[] }>("openFiles"),
  flushAck: (result?: { ok: boolean; failed: number }) => call<Record<string, never>>("flushAck", result ?? { ok: true, failed: 0 }),
  previewReferencedFiles: () => call<{ files: Array<{ id: string; title: string; sourcePath: string; bytes: number }> }>("previewReferencedFiles"),
  resolveReferencedFiles: (ids: string[]) => call<{ filled: number }>("resolveReferencedFiles", { ids }),
  checkpoint: (id: string) => call<Record<string, never>>("checkpoint", { id }),
  createBackup: () => call<{ cancelled: boolean; fileName?: string; noteCount?: number; projectCount?: number }>("createBackup"),
  restoreBackup: () => call<{ cancelled: boolean; restoredNotes?: number; rollbackFileName?: string }>("restoreBackup"),
  aiSetKey: (key: string) => call<Record<string, never>>("aiSetKey", { key }),
  aiClearKey: () => call<Record<string, never>>("aiClearKey"),
  aiCompatSave: (baseUrl: string, name: string, key: string) => call<Record<string, never>>("aiCompatSave", { baseUrl, name, key }),
  aiCompatClear: () => call<Record<string, never>>("aiCompatClear"),
};

