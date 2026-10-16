import type { PartialBlock } from "@blocknote/core";
import { host, HostError, type Bootstrap, type HostNote, type UpsertNote } from "./bridge";
import type { DocItem, LabState } from "./labState";
import { blocksToText, textToBlocks, type LooseBlock } from "./textFormat";

const asBlocks = (value: unknown): PartialBlock[] => value as PartialBlock[];

export function formatUpdated(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (sameDay(d, now)) return `сегодня, ${time}`;
  if (sameDay(d, yesterday)) return `вчера, ${time}`;
  return `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}, ${time}`;
}

export function blocksOf(note: HostNote): PartialBlock[] {
  if (note.externalOnly) {
    return [{ type: "paragraph", content: `Этот файл не загружен в редактор (слишком большой или не текстовый) и не изменяется: ${note.sourcePath || note.title}` }];
  }
  if (note.blocksJson) {
    try {
      const parsed: unknown = JSON.parse(note.blocksJson);
      if (Array.isArray(parsed) && parsed.length > 0) return asBlocks(parsed);
    } catch { /* falls through to the text mirror */ }
  }
  return asBlocks(textToBlocks(note.content));
}

/** `parents` maps a project name to the name of the project it is nested in (top-level projects are absent). */
export type LoadedHost = { state: LabState; boot: Bootstrap; projectIds: Map<string, string>; parents: Record<string, string> };

export function toLabState(boot: Bootstrap): LoadedHost {
  const projects = [...boot.projects].sort((a, b) => a.order - b.order);
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const projectIds = new Map(projects.map((p) => [p.name, p.id]));
  const docs: DocItem[] = [];
  const contents: Record<string, PartialBlock[]> = {};
  const tags: Record<string, string> = {};
  for (const n of boot.notes) {
    const opened = Date.parse(n.lastOpenedUtc);
    const modified = Date.parse(n.updatedUtc);
    docs.push({
      id: n.id, title: n.title, folder: nameById.get(n.projectId) ?? projects[0]?.name ?? "Входящие",
      updated: formatUpdated(n.updatedUtc), icon: "note",
      ...(n.legacySourceGuid ? { legacyGuid: n.legacySourceGuid } : {}),
      ...(n.isArchived ? { archived: true } : {}),
      ...(n.isDeleted ? { deletedAt: n.updatedUtc } : {}),
      ...(n.isPinned ? { pinned: true } : {}),
      ...(Number.isFinite(opened) ? { lastOpenedAt: opened } : {}),
      ...(Number.isFinite(modified) ? { modifiedAt: modified } : {}),
      ...(n.externalOnly || n.locked ? { readOnly: true } : {}),
      ...(n.isProtected ? { protected: true } : {}),
      ...(n.locked ? { locked: true } : {}),
      ...(n.sourcePath && !n.externalOnly && n.sourceType === "file" ? { sourcePath: n.sourcePath } : {}),
      ...(n.writeThrough ? { writeThrough: true } : {}),
    });
    contents[n.id] = blocksOf(n);
    if (n.tags) tags[n.id] = n.tags;
  }
  const folders = projects.map((p) => p.name);
  const activeProject = nameById.get(boot.settings.activeProjectId) ?? folders[0] ?? "Входящие";
  const live = docs.filter((d) => !d.deletedAt);
  const selected = live.find((d) => d.id === boot.settings.selectedNoteId)
    ?? live.find((d) => d.folder === activeProject && !d.archived) ?? live.find((d) => !d.archived) ?? null;
  const dark = boot.settings.theme === "dark" || (boot.settings.theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  const parents: Record<string, string> = {};
  for (const p of projects) { const parent = p.parentId ? nameById.get(p.parentId) : undefined; if (parent) parents[p.name] = parent; }
  return {
    boot, projectIds, parents,
    state: { schemaVersion: 1, docs, contents, activeId: selected?.id ?? null, folder: selected?.folder ?? activeProject, folders, dark, tags },
  };
}

export async function loadFromHost(): Promise<LoadedHost> {
  const boot = await host.bootstrap();
  if (boot.contract !== 1) throw new HostError("contract", `Версия хоста (${boot.contract}) не поддерживается этим интерфейсом.`);
  return toLabState(boot);
}

// ---------------------------------------------------------------------------------------------------------------------

export type SyncInput = {
  docs: DocItem[]; contents: Record<string, PartialBlock[]>; folders: string[]; parents: Record<string, string>; tags: Record<string, string>;
  activeId: string | null; folder: string; dark: boolean;
};
export type SyncStatus = { state: "idle" | "saving" | "saved" | "error"; message: string };
export type FlushResult = { ok: boolean; failed: number };

/** Mirrors NoteStore.EditorLimitChars. Checked here too, so one oversized note is reported instead of being sent and rejected. */
export const EDITOR_LIMIT_CHARS = 262144;

/**
 * Pushes UI state to the host as idempotent per-note upserts. It only ever creates and updates:
 * a note disappearing from the UI is never deleted on disk (permanent deletion is an explicit user action, see deleteNote).
 * Notes are saved independently: one that fails (too long, host error) is reported by name and retried later,
 * and never stops the others from being saved.
 */
export class HostSync {
  private known = new Map<string, { sig: string; blocks: unknown; blocksJson: string }>();
  private projectIds: Map<string, string>;
  private knownParents: Record<string, string> = {};
  private latest: SyncInput | null = null;
  private running: Promise<void> | null = null;
  private lastSettings = "";
  private externalIds = new Set<string>();
  private failed = new Map<string, string>();      // note id -> short reason
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private onStatus: (s: SyncStatus) => void = () => {};

  constructor(initial: LoadedHost) {
    this.projectIds = new Map(initial.projectIds);
    this.knownParents = { ...initial.parents };
    this.seed(initial);
  }

  setStatusHandler(handler: (s: SyncStatus) => void) { this.onStatus = handler; }

  /** Re-baseline after the UI state was replaced from the host (for example after an import or a restore). */
  reset(loaded: LoadedHost) {
    this.cancelRetry();
    this.known.clear(); this.externalIds.clear(); this.failed.clear(); this.latest = null; this.retries = 0;
    this.projectIds = new Map(loaded.projectIds);
    this.knownParents = { ...loaded.parents };
    this.seed(loaded);
  }

  private seed(initial: LoadedHost) {
    for (const n of initial.boot.notes) {
      this.known.set(n.id, {
        sig: this.sig({ title: n.title, folder: initial.boot.projects.find((p) => p.id === n.projectId)?.name ?? "", pinned: n.isPinned, archived: n.isArchived, deleted: n.isDeleted, tag: n.tags }),
        blocks: initial.state.contents[n.id], blocksJson: JSON.stringify(initial.state.contents[n.id]),
      });
      if (n.externalOnly) this.externalIds.add(n.id);
    }
    this.lastSettings = this.settingsSig(initial.state);
  }

  private sig(m: { title: string; folder: string; pinned: boolean; archived: boolean; deleted: boolean; tag: string }) {
    return JSON.stringify([m.title, m.folder, m.pinned, m.archived, m.deleted, m.tag]);
  }
  private settingsSig(s: { activeId: string | null; folder: string; dark: boolean }) { return JSON.stringify([s.activeId, s.folder, s.dark]); }

  forget(id: string) { this.known.delete(id); this.failed.delete(id); }

  push(input: SyncInput): void {
    this.cancelRetry();
    this.latest = input;
    this.retries = 0;
    if (!this.running) this.running = this.drain();
  }

  private cancelRetry() { if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; } }

  /** Failed notes are retried a few times in the background; this timer is NOT awaited by flush(). */
  private scheduleRetry(snapshot: SyncInput) {
    if (this.retries >= 3 || this.retryTimer) return;
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.latest) this.latest = snapshot;
      if (!this.running) this.running = this.drain();
    }, 2000 * this.retries);
  }

  /** Waits until everything pushed so far has been attempted. Never waits forever: a failing note is reported, not retried here. */
  async flush(): Promise<FlushResult> {
    while (this.running) await this.running;
    return { ok: this.failed.size === 0, failed: this.failed.size };
  }

  private async drain(): Promise<void> {
    try {
      while (this.latest) {
        const snapshot = this.latest;
        this.latest = null;
        await this.run(snapshot);
        if (this.failed.size > 0 && !this.latest) this.scheduleRetry(snapshot);
      }
    } finally { this.running = null; }
  }

  private async run(input: SyncInput): Promise<void> {
    const s: SyncInput = { ...input, parents: input.parents ?? {} };
    this.onStatus({ state: "saving", message: "Сохраняем…" });
    const titles = new Map(s.docs.map((d) => [d.id, d.title]));
    let written = 0;
    try {
      for (const name of s.folders) {
        if (this.projectIds.has(name)) continue;
        const project = await host.createProject(name, this.projectIds.get(s.parents[name] ?? "") ?? "");
        this.projectIds.set(project.name, project.id);
        this.knownParents[name] = s.parents[name] ?? "";
      }
      for (const name of s.folders) {
        const id = this.projectIds.get(name);
        if (!id || (this.knownParents[name] ?? "") === (s.parents[name] ?? "")) continue;
        await host.moveProject(id, this.projectIds.get(s.parents[name] ?? "") ?? "");
        this.knownParents[name] = s.parents[name] ?? "";
      }
      for (const doc of s.docs) {
        try {
          if (await this.saveOne(s, doc)) written++;
          this.failed.delete(doc.id);
        } catch (error) {
          this.failed.set(doc.id, error instanceof Error ? error.message : "ошибка сохранения");
        }
      }
      const settings = this.settingsSig(s);
      if (settings !== this.lastSettings) {
        await host.saveSettings({ activeProjectId: this.projectIds.get(s.folder) ?? "inbox", selectedNoteId: s.activeId ?? "", theme: s.dark ? "dark" : "light" });
        this.lastSettings = settings;
      }
    } catch (error) {
      // folders/settings could not be saved: report, keep notes state for the retry
      this.onStatus({ state: "error", message: error instanceof Error ? error.message : "Не удалось сохранить" });
      return;
    }
    if (this.failed.size > 0) {
      const [firstId, reason] = [...this.failed.entries()][0];
      const name = titles.get(firstId) ?? "заметка";
      this.onStatus({ state: "error", message: this.failed.size === 1 ? `«${name}» не сохранена: ${reason}` : `Не сохранено заметок: ${this.failed.size} (например «${name}»: ${reason})` });
    } else {
      this.onStatus({ state: "saved", message: written > 0 ? "Сохранено" : "Все изменения сохранены" });
    }
  }

  /** Returns true when something was written. Throws with a short reason when this one note cannot be saved. */
  private async saveOne(s: SyncInput, doc: DocItem): Promise<boolean> {
    const projectId = this.projectIds.get(doc.folder) ?? "inbox";
    const meta = { title: doc.title, folder: doc.folder, pinned: Boolean(doc.pinned), archived: Boolean(doc.archived), deleted: Boolean(doc.deletedAt), tag: s.tags[doc.id] ?? "" };
    const sig = this.sig(meta);
    const prev = this.known.get(doc.id);
    const blocks = s.contents[doc.id];
    const readOnly = Boolean(doc.readOnly) || this.externalIds.has(doc.id);
    const contentRefChanged = !readOnly && blocks !== undefined && (!prev || prev.blocks !== blocks);
    let blocksJson = prev?.blocksJson ?? "";
    let payloadContent: { content: string; blocksJson: string } | null = null;
    if (contentRefChanged) {
      blocksJson = JSON.stringify(blocks);
      if (!prev || blocksJson !== prev.blocksJson || this.failed.has(doc.id)) {
        const content = blocksToText(blocks as unknown as LooseBlock[]);
        if (content.length > EDITOR_LIMIT_CHARS) throw new Error("слишком длинная (больше 262 144 символов): разделите текст на несколько заметок");
        payloadContent = { content, blocksJson };
      }
    }
    if (prev && prev.sig === sig && !payloadContent) { if (contentRefChanged) this.known.set(doc.id, { ...prev, blocks }); return false; }
    const body: UpsertNote = {
      id: doc.id, projectId, title: doc.title, tags: meta.tag, pinned: meta.pinned, archived: meta.archived, deleted: meta.deleted,
      ...(payloadContent ?? (!prev && !readOnly ? { content: "", blocksJson: "[]" } : {})),
    };
    await host.upsertNote(body);
    this.known.set(doc.id, { sig, blocks: contentRefChanged ? blocks : prev?.blocks, blocksJson });
    return true;
  }
}
