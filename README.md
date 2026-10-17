# Notepad Hub 4

Заметки для Windows: быстрый редактор, вставка текста и картинок, автоформат, помощник ИИ (бесплатная онлайн-модель по умолчанию, локальная Ollama, OpenRouter, любой сервис с интерфейсом OpenAI), две заметки рядом со сравнением, корзина, метки, резервные копии.

Приложение: окно WPF + WebView2 (`src/NotepadHub.Host`), логика и хранение (`src/NotepadHub.Core`), интерфейс на React 19 и BlockNote (`ui`). Заметки хранятся на компьютере владельца, по файлу на заметку. Облака нет.

## Быстрый старт
```
cd ui && npm install && npm run build      # собирает интерфейс в ui/dist
cd .. && dotnet build src/NotepadHub.Host -c Debug
src/NotepadHub.Host/bin/Debug/net8.0-windows/NotepadHub4.exe
```
Нужны: Windows 10/11, .NET 8 SDK, Node.js 20+, WebView2 Runtime.

## Проверки
| Что | Команда |
|---|---|
| Модульные тесты интерфейса | `cd ui && npm test` |
| Тесты ядра | `dotnet test tests/NotepadHub.Core.Tests` |
| Окно программы (Playwright по CDP на копии профиля) | `node tests/e2e/host-e2e.mjs <NotepadHub4.exe> <профиль.zip>` (также `features2`, `features3`, `paste`, `layout`, `ideas`, `passwords`, `journey`) |

Сквозные тесты используют архив профиля владельца (в репозиторий не входит) и Playwright из `~/.local/share/orca-design-tools`. Без них запускайте первые две строки таблицы.

## Как подключить другую модель ИИ
1. **Любой сервис с интерфейсом OpenAI** (`/chat/completions`, `/models`, по желанию `/images/generations`): в панели ИИ выберите «Онлайн» → «Сервис», вставьте адрес и ключ. Ключ шифруется DPAPI, адрес лежит в `ai-compat.json` рядом с заметками.
2. **Готовая кнопка в списке сервисов:** добавьте запись в `COMPAT_PRESETS` в `ui/src/components/AiAssistantPanel.tsx` (название, адрес, примечание, без ключа или с ключом).
3. **Другой протокол** (не OpenAI): добавьте ветку провайдера в `src/NotepadHub.Core/Ai/AiService.cs` рядом с `ollama`, `openrouter`, `compat` и тип в `ui/src/ai.ts`.
4. **Подсказки для модели** лежат в `src/NotepadHub.Core/Ai/AiPrompts.cs`; защита (проверка секретов, согласие, лимиты, подтверждение стоимости) — в `AiService.CompatRequestAsync`.
5. **Корпоративный прокси:** по умолчанию сетевые запросы наружу (онлайн-сервисы ИИ, скачивание картинок) идут без прокси, а каждое соединение закрепляется за публичным адресом (`src/NotepadHub.Core/Net/NetworkGuard.cs`). Если единственный выход в интернет — через прокси, задайте перед запуском переменную окружения `NOTEPADHUB_USE_PROXY=1`: приложение перейдёт на системный прокси. В этом режиме закрепление по адресам отключается (реальный адрес назначения разрешает сам прокси), поэтому включайте флаг только на доверенном прокси.

Подробнее для моделей-помощников — в `AGENTS.md`.

## Документы
`docs/PROJECT_PASSPORT.md` (паспорт), `docs/specs/` (спецификации срезов), `docs/design/` (решения по интерфейсу), `docs/reuse/` (сравнение с готовыми продуктами), `docs/CRITIC_REPORT.md` и `docs/QA_REPORT*.md` (замечания и проверки).
