<!-- autopilot:start -->
# Notepad Hub Editor Lab

Интерфейс Notepad Hub 4: React 19 / BlockNote 0.55 / Mantine внутри WPF + WebView2 (хост в `../src`, мост v1 в `src/bridge.ts`). Запускается как production-приложение; `npm run dev` — только браузерный режим с mock-хостом для разработки.

**Состояние на 2026-10-10 (актуально, раздел «Текущее состояние» ниже — историческая справка о прототипе 2026-10-04):** заметки хранятся хостом (файл на заметку), есть вкладки с закрытием, метки, `[[ссылки]]` и обратные ссылки, найти/заменить, AI-панель (Ollama/OpenRouter, область «заметка + связанные»), открытие файлов на месте. Проверки: `npm test` (юнит), `../tests/e2e/host-e2e.mjs` (окно программы на копии профиля), `dotnet test ../tests/NotepadHub.Core.Tests`. Документы: `../docs/PROJECT_PASSPORT.md`, `../docs/CRITIC_REPORT.md`, `../docs/AUDIT_vs_OpenNotebook.md`.

## Команды

| Команда | Что делает |
|---------|------------|
| `npm install` | Установить зависимости |
| `npm run dev` | Запустить локально |
| `npm run build` | Проверить типы и собрать прототип |

## Как здесь работает Autopilot

Требования, спецификация и таски — в `.autopilot/`. Прогресс — `.autopilot/dashboard.html`.
Требование из `manifest.md` может снять только пользователь.

Если работа продолжается — скажи «продолжи автопилот»: состояние поднимется
из `.autopilot/state.js`, переспрашивать ничего не нужно.
<!-- autopilot:end -->

## Текущее состояние проекта (2026-10-04)

- Изолированный React 19 / TypeScript / Vite прототип с BlockNote 0.55 и Mantine. Это не production-приложение: нет WPF-моста, доступа к `.nhub`/профилю Notepad Hub или облачной синхронизации.
- Заметки хранятся в `localStorage` текущего browser origin: ключ `notepad-hub-blocknote-lab-v1`, schemaVersion 1, BlockNote blocks. Очистка данных сайта удаляет копию прототипа; старые schema v1 остаются форматом совместимости.
- AI UI вызывает типизированный provider-neutral API в `src/ai.ts`; Vite middleware в `vite.config.ts` обслуживает `/api/ai/status`, `/api/ai/models` и `/api/ai/stream` для Ollama/OpenRouter. OpenRouter secret (`OPENROUTER_API_KEY`) читается dev-сервером из окружения или `.env.local`; удалённая отправка требует согласия, платная генерация — подтверждения стоимости. Изменения AI — предложения с явным применением и проверкой актуальности источника. OpenRouter inference в рамках этой проверки не проверялся.
- Ключевые файлы: `src/main.tsx` (инициализация приложения), `src/App.tsx` (заметки, BlockNote и основная композиция), `src/components/AiAssistantPanel.tsx` (AI UI), `src/ai.ts` (клиент/типы AI), `src/windowsNotepadImport.ts` (импорт снимка Windows Notepad), `vite.config.ts` (dev middleware), `docs/adr/0001-ai-editor-boundaries.md` и `.autopilot/ai-native-editor/interfaces.md` (архитектурные границы и межмодульные контракты).
- Окружение по README: Node.js 20.19+ или 22.12+, npm 10+. `npm install`, `npm run dev` документированы; `npm run build` проверяет TypeScript и собирает `dist/`. Проверено здесь: Node 24.19.0, npm 11.17.0, `npm run build` — успешно; Vite сообщил предупреждение о чанке больше 500 kB.
- Импорт Windows Notepad принимает выбранный ZIP-снимок `TabState/*.bin`; переносит доступный встроенный plain text, но не rich formatting и не внешние файлы. Markdown export lossy; JSON backup относится только к схеме Editor Lab, не к `.nhub`. AI endpoints — только dev middleware и не входят в production build.
