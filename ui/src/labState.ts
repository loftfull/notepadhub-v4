import type { PartialBlock } from "@blocknote/core";

export type DocItem = {
  id: string; title: string; folder: string; updated: string; icon: "note" | "task";
  legacyGuid?: string; archived?: boolean; deletedAt?: string; pinned?: boolean; lastOpenedAt?: number;
  /** set for huge files that live only on disk: shown, never overwritten */
  readOnly?: boolean;
  /** the note came from a file on disk; with writeThrough every edit is saved back into that file */
  sourcePath?: string; writeThrough?: boolean;
};

export type LabState = {
  schemaVersion: 1;
  docs: DocItem[];
  contents: Record<string, PartialBlock[]>;
  activeId: string | null;
  folder: string;
  folders: string[];
  dark: boolean;
  tags: Record<string, string>;
};
