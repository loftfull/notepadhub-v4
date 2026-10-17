---
doc_type: project-context
authority: normative
status: current
owner: Vladimir
project_id: notepad-hub-4
canonical_root: "C:\\Users\\Vladimir\\Documents\\Projects\\NotepadHub\\v4"
lifecycle: active
authority_status: needs-review
version: 1
last_reviewed: 2026-10-17
---

# Notepad Hub 4: контекст для ИИ-модели

Читай этот файл первым. Он короткий намеренно; подробности по ссылкам.

## Что это
Настольный блокнот для Windows, замена Блокноту Windows с вкладками, проектами, ссылками между заметками, паролем на заметку и ИИ-панелью. Данные лежат файлами на компьютере; облака и сервера нет. Версия 3 читает те же данные (общий формат `data-v3`).

## Стек и пути
- Окно: WPF + WebView2, `src/NotepadHub.Host` (хост), `src/NotepadHub.Core` (ядро, хранилище, ИИ, мост).
- Интерфейс: React 19 + TypeScript + BlockNote + Vite, `ui/` (главный файл `ui/src/App.tsx`).
- Тесты: `ui/tests` (node:test), `tests/NotepadHub.Core.Tests` (xunit), `tests/e2e/*.mjs` (настоящее окно через Playwright по порту отладки, на копии профиля).
- Установка: `tools/Install-NotepadHub4.ps1 -DesktopOnly` (только если программа не запущена; окно владельца не закрывать).
- GitHub: `loftfull/notepadhub-v4`, CI `.github/workflows/ci.yml`.

## Главные документы (нормативные для проекта)
1. `docs/OWNER_REQUIREMENTS.md`: реестр требований владельца R1…; **сверять перед любым изменением расположения и вида**.
2. `DESIGN.md`, `docs/specs/product.md`, `docs/strategy.md`.
3. `docs/design/*.md`: разборы аналогов и решения (Obsidian, Notebook Navigator, QuickNote, SingularityApp, Блокнот Windows, внешний архив, движение).
4. `docs/audit/2026-10-17-vault-audit.md`: что пошло не так в процессе и почему.
5. `docs/PROGRESS.md`: состояние ворот и последние изменения (собирается `progress_ledger.py`).

## Что нельзя менять без решения владельца
- Формат данных `data-v3` (совместимость с версией 3), смысл полей `Project`/`NoteMeta`; новые поля только добавлять.
- Правила размещения из реестра требований (одно действие в одном месте; ИИ только в панели ИИ; служебные данные внизу).
- Не включать боковое меню блоков BlockNote (роняло окно в сценариях с картинками и паролем).
- Шаблоны заметок, несколько окон, облачная синхронизация: решено не делать.

## Как проверять (доказательства)
`npm run build` в `ui/` → `dotnet build src/NotepadHub.Host -c Debug` → `npm test` в `ui/` → `dotnet test tests/NotepadHub.Core.Tests` → `node tests/e2e/<сценарий>-e2e.mjs <exe> <data-v3.zip>`. Хэш журнала сквозного сценария пишет `python -I D:/MOZG/_meta/tools/evidence_refresh.py .`, руками не править.

## Состояние на 2026-10-17
Пройдены ворота G0–G2; **не пройдены G3, G4** (нужны выбор макета и показ первого экрана владельцу), **G5** (признаки имитации), **G6, G7** (журнал и критик на текущем коде). Открытые решения владельца: подсветка кода, граф ссылок, обрезка картинок, автоархив, файл LICENSE, разбиение `App.tsx`.

## Известные нестабильные проверки
`host-e2e` иногда падает на проверке ИИ (ответил сервис по умолчанию вместо поддельной локальной модели); под нехваткой памяти окно падает. Повторять отдельно, причину искать (D06 в базе).
