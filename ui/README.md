# Notepad Hub — BlockNote Editor Lab

Isolated editor prototype for UX and editor-schema evaluation. It is not the production application, does not connect to the installed Notepad Hub process, and does not read or write `%LOCALAPPDATA%\\NotepadHub\\data-v3`.

## Requirements

- Node.js 20.19+ or 22.12+
- npm 10+

## Run

```powershell
npm install
npm run dev
```

The Vite server binds only to `127.0.0.1`. `npm run build` performs TypeScript checking and produces a static test bundle in `dist/`.

## Prototype scope

- BlockNote 0.55.0 with the Russian dictionary and a local notebook demo. `Ctrl+K` opens the unified note finder; type `>` to switch to command mode for note actions and saved prompt recipes. Choosing a saved recipe opens AI and fills its instruction without changing the current scope/context or starting inference.
- Fluent-inspired design tokens adapted from the existing WPF shell (`src/MainWindow.xaml`): Windows accent blue, Segoe UI system fonts, light surfaces, clear hover/pressed/disabled/focus states, compact spacing, a floating editor sheet, and horizontal project-note tabs. Includes responsive navigation, light/dark theme, note properties, create/move folder dialogs, editable note labels, keyboard navigation and full-text search, rename/duplicate/archive/trash/restore/permanent delete, Ctrl+S immediate local save, slash menu, checklist, headings, bullets, text-file opening, Markdown export, and Editor Lab JSON backup/restore.
- Windows Notepad transfer is available from a user-selected ZIP snapshot containing `TabState/*.bin`. The importer reads the archive in memory, accepts at most 50 MiB compressed / 100 MiB total tab data / 8 MiB per tab, and never opens a local source path stored inside the snapshot. It restores embedded plain text into a separate `Импорт Windows` project; unsupported or malformed tabs are reported as skipped, and tabs whose content exists only in an external source file are imported as empty with a warning. Rich formatting and external files are not imported.
- Documents, folders, tags, theme, active note, and BlockNote block arrays are saved as schema-versioned JSON in this browser origin's `localStorage` after a short debounce; Ctrl+S writes the current block snapshot immediately. This is only the isolated editor lab's browser storage: it does not read or write Hub files, `%LOCALAPPDATA%\\NotepadHub\\data-v3`, or production `.nhub` backups. Clearing browser site data removes this lab snapshot. There is no WPF bridge, collaboration, or cloud connection.
- Markdown export is explicitly lossy for block types not representable by BlockNote's lossy Markdown serializer.

## Donor coverage audit

The lab supports project folders plus a separate library for pinned, recent, archived, and trashed notes; note pinning and most-recently-opened order persist in the browser. Global search spans non-deleted notes and shows each result's folder. The read-only HTML preview serializes only known text block types, escapes note content, and runs inside an iframe with an empty sandbox (no scripts or active content). Closing it returns to the editor without applying changes.

File actions are grouped under the labelled **Файлы и копии** control: regular text-file opening, Windows Notepad ZIP-snapshot import, lossy Markdown export, and Editor Lab JSON backup/restore. Existing CRUD, move/duplicate, archive/trash/restore/permanent delete, and autosave remain available. The donor has no export-to-Windows-Notepad format feature; the transfer direction is Windows Notepad → Hub. Markdown export is not a Windows Notepad export or a complete backup.

## Dependency licensing

The BlockNote core/react/mantine packages are MPL-2.0. This prototype does not depend on the BlockNote XL packages (GPL-3.0). Review the complete transitive dependency licenses and include applicable notices before redistributing a bundled build. The importer uses browser-native ZIP decompression and does not add a ZIP runtime dependency.

## Next integration gate

Do not connect this editor to the production profile until a versioned bridge contract exists and fixture-copy round trips demonstrate preservation of text, headings, lists, checklist state, links, metadata, and block order. Keep the WPF editor and production data unchanged through this prototype stage.

## Local AI and backups

AI runs through Vite development-server routes and is not included in the static production build. The editor uses `/api/ai/stream` for local Ollama and OpenRouter; `/api/ai/status` reports configuration and `/api/ai/models` provides the model catalog. Local Ollama inference stays on this computer. Install and start Ollama locally, then download a model suited to your hardware. Small models can respond quickly but may be less reliable; larger models can take substantially longer, especially on CPU.

OpenRouter can provide free or paid text models. Create a local `.env.local` file containing `OPENROUTER_API_KEY=your_key` and restart Vite; never commit or paste the key into the browser. The key is read only by the development server. Public model listings and price data load from OpenRouter, while inference requires a valid key and uses the development-server route. The UI previews the exact context, requires explicit remote-transfer consent, and asks for separate confirmation for each paid request; models without trustworthy pricing are blocked.

The AI assistant supports selected text, the current paragraph, or the whole note; editing operations produce a reviewable proposal that is applied only on explicit acceptance. **Структурировать заметку** is a dedicated whole-note operation: it formats the complete note as clear Markdown, preserves every fact/date/name/decision/action/risk, and invents nothing. It is available only with the `note` scope, never runs automatically, and must be explicitly accepted or rejected from the proposal preview. Analysis is read-only and may include citations to source blocks in the note. A collapsed quick-prompt library offers reusable instructions without adding persistent toolbar clutter. Streaming can be cancelled, and stale proposals are rejected if their source text changes. These endpoints are development-server middleware, not a production backend.

The **Копия JSON** and **Восстановить JSON** actions preserve the Editor Lab schema and BlockNote blocks. This file is not a production `.nhub` backup. Regular TXT opening creates an independent note. Markdown export is lossy for unsupported block types.

### Browser-local notebook state

The local-storage snapshot remains `schemaVersion: 1` at `notepad-hub-blocknote-lab-v1`. New optional note fields (`pinned` and `lastOpenedAt`) are read with defaults when older version-1 snapshots omit them, then saved alongside existing documents and block arrays. Existing version-1 notes, folders, tags, active note, theme, and content are retained; deleted notes are omitted from pin/recent and global-search results. Clearing browser site data removes this isolated lab snapshot.

This preview and every other editor capability run only inside the prototype browser origin. The lab does not connect to the production profile, WPF process, `.nhub` files, or `%LOCALAPPDATA%\\NotepadHub\\data-v3`; it does not sync to a cloud service.

## Design source

The initial style reference is the existing WPF shell at `../src/MainWindow.xaml`: its role-based palette (`Accent`, `TextPrimary`, `TextSecondary`, `GlassCard`, `GlassSoft`, `Stroke`, `Hover`), Segoe UI, Fluent-like 8px button geometry, and hover/pressed/disabled states. `src/design-system.css` maps those roles to browser tokens and raises editor text to 16px while preserving a restrained compact spacing scale. The reference document `../DESIGN_REFERENCES.md` names external conceptual references, not a separate ready-made donor stylesheet.
