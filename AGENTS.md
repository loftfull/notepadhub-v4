# Instructions for AI coding agents (Codex, Claude, Gemini, others)

Product: Notepad Hub 4, a Windows notes app. Owner writes in Russian: **answer and write user-facing text in Russian**; code and comments in English.

## Layout
- `ui/` React 19 + BlockNote 0.55 + Vite. `src/App.tsx` is a large monolith (state, handlers, layout); `src/components/*` panels and dialogs; `src/autoFormat.ts` deterministic note formatting (pure, unit-tested); `src/ai.ts` AI client/types; `src/bridge.ts` calls into the host.
- `src/NotepadHub.Core` host logic: `NoteStore` (files on disk), `Ai/AiService.cs` + `CompatService.cs` + `AiPrompts.cs`, `ImageFetcher.cs` (SSRF-safe), `Bridge/BridgeDispatcher.cs` (the only door from the page to the host).
- `src/NotepadHub.Host` WPF window with WebView2; serves `ui/dist` from `https://app.notepadhub.local`, pictures from `https://assets.notepadhub.local`.
- `tests/NotepadHub.Core.Tests` xunit; `ui/tests` node:test; `tests/e2e/*.mjs` real window via CDP.

## Rules that matter
1. `dotnet build` does NOT rebuild the UI. After any change in `ui/`, run `npm run build` first, otherwise the host serves the old page and tests lie.
2. Never delete or rewrite the owner's data silently. Destructive actions ask first and are undoable; do not swallow errors with empty `catch`.
3. No new npm/NuGet packages without the owner's decision. Official sources only.
4. Secrets: keys are stored with DPAPI on the host and never go to the page or to logs. The page has a strict CSP (`ui/vite.config.ts`): no outside scripts, only `assets.notepadhub.local` pictures.
5. Honest UI: every control works or is hidden. No duplicated controls: one action, one place; one thing, one word (project, not folder).
6. Verify before claiming: run the tests that touch your change and report what was not verified.
7. PowerShell/bash heredocs corrupt `\n` and backslashes in TS/C# strings; verify with `npx tsc --noEmit -p ui`.

## Adding an AI provider
See "Как подключить другую модель ИИ" in `README.md`. OpenAI-compatible services need no code: they are configured in the AI panel (`CompatSettings`). New protocols go into `AiService.cs`; keep consent, secret scan and rate limits.
