# Reuse Record: Notepad Hub 4

Дата: 2026-10-09. Правило: `D:\MOZG\Runbooks\Reuse_First_Policy.md`. Шаблон: `D:\MOZG\Templates\Reuse Record.md`.

**Честная оговорка.** Запись составлена после реализации основных срезов, а не до неё. Метаданные кандидатов (версии, лицензии, свежесть релизов) в этой сессии по сети не проверялись: графа «Проверено» показывает, что подтверждено на практике. Эти данные нужно перепроверить до релиза.

Вердикты: keep (оставить своё), reuse (как есть), adapt (доработать), replace, from-scratch.

| Потребность | Что рассмотрено | Вердикт | Почему | Проверено |
|---|---|---|---|---|
| Редактор блоков | BlockNote 0.55 (MPL-2.0, уже в проекте Editor Lab), TipTap/ProseMirror напрямую, Lexical | reuse | Уже выбран и проверен в прототипе владельца; XL-пакеты (GPL-3.0) не используются | собирается и проходит тесты в хосте; лицензии пакетов перепроверить |
| Оболочка окна | WPF + WebView2 (платформа Microsoft), Electron, Tauri (Rust), WinUI 3 | reuse | .NET 8 и WebView2 Runtime уже на машине, нет второго рантайма в 100+ МБ; решение из брейншторма владельца (2026-10-02) | WebView2 154 установлен; запуск проверен |
| Fluent-оформление окна | `lepoco/wpfui` (MIT, в реестре «в обиходе»), системный Mica | skip (watch) | Интерфейс рисуется внутри WebView2, готовых WPF-контролов почти нет; Mica невидим под веб-страницей | не оценивалось глубже |
| Формат хранения | Новая БД (SQLite), формат Obsidian/Joplin (папка файлов) | keep | Формат `data-v3` (файл на заметку) уже у владельца и читается версией 3.0.5; миграция не нужна, откат простой | ADR 0002 |
| Конвертер текст ↔ блоки | `blocksToMarkdownLossy` / `tryParseMarkdownToBlocks` из BlockNote, remark | from-scratch (малый) | Markdown-конвертеры теряют или переписывают строки вида `# комментарий`, `- x`, `1.` в обычных заметках; нужен ровный круг «текст → блоки → текст». ~150 строк, 19 тестов | тесты `textFormat.test.mjs` |
| Резервные копии | `System.IO.Compression.ZipFile` (платформа), 7-Zip, Hasleo (у владельца) | reuse (платформа) + обёртка | Формат `.nhub` задан 3.0.5 как ZIP каталога; манифест с хэшами и проверка добавлены поверх | 15 тестов |
| Список готовых зип-проверок | Практики OWASP по zip-slip/zip-bomb | adapt | Правила применены в `NhubBackup` (имена, дубликаты, размеры, хэши); сторонняя библиотека не нужна | обзор безопасности 2026-10-09 |
| AI-клиенты | Официальные SDK (Anthropic/OpenAI), `vercel/ai`, готовые клиенты Ollama/OpenRouter | from-scratch (малый) | Нужны только два REST-вызова со стримингом и жёсткими лимитами (loopback, согласие, цена, секреты); SDK добавили бы зависимости и нестандартные пути данных | 13 тестов с поддельным HTTP |
| Поиск секретов в тексте | `gitleaks` (MIT), `detect-secrets` (Apache-2.0), `trufflehog`, готовые наборы правил | adapt (идеи правил) | Это внешние программы под сканирование репозиториев (Go/Python), тащить в блокнот неоправданно; правила собраны в `SecretScanner` на .NET. **Ограничение:** список правил короче, чем у этих инструментов — перепроверить против их актуальных наборов | 11 тестов формата, 4 на отсутствие ложных срабатываний |
| Evals AI | `promptfoo` (MIT, в Reuse Map) | trial (не внедрено) | Нужен набор из 20–30 реальных заметок; это условие релиза AI-функции | не сделано |
| Хранение ключа | Windows DPAPI (`ProtectedData`), Credential Manager | reuse (платформа) | Привязка к пользователю Windows без собственной криптографии | тест чтения/записи не автоматизирован |
| Тестирование UI | Playwright (в обиходе), axe-core | reuse | Уже установлены у владельца; сквозной сценарий и проверка доступности работают на реальном хосте | 21 проверка |
| Формат ADR | `adr/madr` | keep (упрощённо) | Небольшие ADR в `docs/adr` по смыслу MADR | перепроверить шаблон |

## Что пересмотреть до релиза
1. Версии и лицензии BlockNote, Mantine, lucide-react, WebView2 SDK, `System.Security.Cryptography.ProtectedData` (перечень уведомлений о лицензиях в сборку).
2. Правила `SecretScanner` против актуальных наборов gitleaks/detect-secrets.
3. Evals через `promptfoo` или собственный набор на заметках владельца.
4. Нужен ли `lepoco/wpfui`, если появятся нативные окна (настройки, мастер установки).

## 2026-10-10 — Find & replace in the note
- Need: Windows 11 Notepad parity (Ctrl+F / Ctrl+H); Obsidian/Joplin have the same.
- Reused: `@tiptap/extension-find-and-replace` 3.31.4 (official Tiptap, MIT, peer deps match installed `@tiptap/core`); registered via BlockNote `_tiptapOptions.extensions` (internal option — re-check on BlockNote upgrades). Alternatives rejected: `prosemirror-search` (no ready commands/counter), `@sereneinserenade/tiptap-search-and-replace` (Tiptap 2).
- Built ourselves: only the small bar `components/FindBar.tsx` and CSS (`injectCSS:false` because of the CSP). Regex mode not exposed.
- Also added: word/character counter in the status bar (derived from the note text, no dependency).
- Verified: e2e (find count, replace-all reaches disk, text restored) — 25/25; UI tests 30/30.

## 2026-10-10 — [[links]], backlinks, ranked search, tags
- Need: Obsidian-style links between notes; audit vs Open Notebook (docs/AUDIT_vs_OpenNotebook.md).
- Reused: Open Notebook ideas only (user-controlled AI context, citations) — its code is Python/SurrealDB/Docker, no fit. Tiptap/ProseMirror `Plugin` + `Decoration` (already installed) for link highlighting; no maintained BlockNote 0.55 wikilink package found, the plugin is ~50 lines (`wikiLinkExtension.ts`).
- Built: `wikiLinks.ts` (parse/index/cache), `searchNotes.ts` (ranked search), link picker, Links panel, tags (same single-string field as 3.0.5).
- Verified: ui unit tests 38/38, e2e (picker, highlight, panel, Ctrl+click, backlink) — see host-e2e.mjs.

## 2026-10-15 — Продукты-аналоги «свои источники → чат» (уровень возможностей)
- Зачем: Reuse-First требует сравнить продукты, а не только пакеты. Метаданные взяты из `D:\MOZG\Knowledge\Local_AI_Tools_Catalog.md` (проверено по GitHub API 2026-10-15). Код не переносится: записи реестра источников `catalog-only`.
- Что не проверялось: работа продуктов на этом ПК и их интерфейс вживую. Сравнение по документации.

| Продукт | Лицензия | Что умеет по возможностям | Вердикт для Notepad Hub 4 |
|---|---|---|---|
| AnythingLLM | MIT | рабочие области с документами, чат по своим источникам, выбор локальной или облачной модели | watch: идея «область = набор заметок» близка нашей области «linked»; код (Node, отдельный сервер) не подходит оболочке WPF |
| Open WebUI | собственная (BSD-3 плюс условие о бренде; исключение до 50 пользователей) | веб-чат поверх Ollama, база знаний, права пользователей | watch: источник идей про ссылки на источники в ответе; встраивать нельзя из-за лицензии и Docker/Python |
| PrivateGPT | Apache-2.0 | локальный вопрос-ответ по документам без облака | skip: серверный Python-проект; наш случай (до сотен заметок, одно окно) закрыт областью `note + linked` без поискового индекса |

Вывод: свой модуль «ИИ по заметкам» остаётся (from-scratch, малый), ничего не заимствуется кодом. Что взять идеей: ссылки на заметки-источники в ответе ИИ (Open WebUI, AnythingLLM). Если заметок станет тысячи, смотреть векторный поиск `nomic-embed-text` (уже в Ollama у владельца, см. каталог).
