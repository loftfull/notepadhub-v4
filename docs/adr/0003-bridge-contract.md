# ADR 0003. Мост между страницей и хостом (контракт v1)

Статус: принято, 2026-10-09.

## Схема
```
 страница (React) ──postMessage──▶ хост (WPF/WebView2) ──▶ BridgeDispatcher ──▶ NoteStore / AiService / NhubBackup
        ◀───── ответ {id, ok, result | error{code, message, status?}} ─────┘
        ◀───── события {event, payload}: flush, libraryChanged, aiEvent
```

## Правила
1. Страница никогда не называет путь. Файлы выбирает пользователь в окнах Windows (открыть, сохранить, подтвердить).
2. Хост принимает сообщения только со страницы `https://app.notepadhub.local`. Переходы и новые окна вне этого имени отменяются; наружу открываются только http/https.
3. Идентификаторы заметок проверяются (`SafeId`), имена версий истории — по шаблону. Размеры и количество проверяются в хосте.
4. Сообщения об ошибках для страницы не содержат путей и текста заметок; внутренние ошибки пишутся в журнал хоста.
5. Ключ OpenRouter хранится только в хосте (DPAPI). Страница может его записать или удалить, но не прочитать.

## Команды
`bootstrap`, `createProject`, `renameProject`, `deleteProject`, `upsertNote`, `deleteNote`, `saveSettings`, `listHistory`, `readHistory`, `checkpoint`, `importWindowsSnapshot`, `openFiles`, `previewReferencedFiles`, `resolveReferencedFiles`, `createBackup`, `restoreBackup`, `aiStatus`, `aiModels`, `aiStreamStart`, `aiCancel`, `aiSetKey`, `aiClearKey`, `flushAck`.

## Совместимость
Поле `contract` в ответе `bootstrap` равно 1. Страница отказывается работать с другим значением и показывает понятную ошибку.
