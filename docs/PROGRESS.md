# Прогресс проекта NotepadHub_v4

Собрано `progress_ledger.py` 2026-10-17 09:58. Не править руками: файл пересобирается.

- Ветка: `main`; хэш кода: `c373936d80ce8314`; несохранённых изменений: 22
- Ворота: пройдено 11, не пройдено 3
- Требования владельца: 37; без указанной проверки: 0

## Ворота, которые не пройдены

- G3 Владелец выбрал вариант по макетам (0 png): строка «Выбран вариант: N» и дословный ответ
- G4 Первый рабочий экран показан владельцу (docs/evidence/vertical-slice.md с его ответом)
- G7 Последний отчёт критика (docs/critic/*.md): все вердикты verified, хэш кода текущий

## Последние требования владельца

| № | Дата | Требование | Проверка |
|---|---|---|---|
| R30 | 2026-10-17 | Из разбора QuickNote AI: строка «Все заметки» над проектами; открытая из поиска заметка ср | `ideas-e2e.mjs` |
| R31 | 2026-10-17 | «снизу в информационной панели добавь кнопки режима Фокус, Сравнения заметок, Тэги» | `ideas-e2e.mjs`, `layout-e2e.mjs` |
| R32 | 2026-10-17 | «должен ни в чём не уступать стандартному блокноту Windows» | `ideas-e2e.mjs`, `docs/design/2026-10-17-parity.md` |
| R33 | 2026-10-17 | «разный шрифт, нет правильного центрирования» | `layout-e2e.mjs` |
| R34 | 2026-10-17 | «продолжай» после разбора: рекомендованные пункты из сравнения с топовыми приложениями | `ideas-e2e.mjs` |
| R35 | 2026-10-17 | «шаблоны не нужны, пароль можно, несколько окон не нужно» | `NotePasswordTests.cs`, `passwords-e2e.mjs` |
| R36 | 2026-10-17 | «найти и реализовать крутые анимационные фишки» | `ideas-e2e.mjs` (анимация окна запускается, при «уменьшить д |
| R37 | 2026-10-17 | Из разбора плана SingularityApp: вычисление выражения в тексте (Alt и =, команда палитры), | `calc.test.mjs`, `ideas-e2e.mjs` |

## Последние изменения

- 69b45da 2026-10-17 AI_CONTEXT, PROGRESS ledger, journey.cmd; evidence refreshed by the vault tool
- 25418fc 2026-10-17 Audit of the design process and the Obsidian vault
- 8ac04f5 2026-10-17 Fix the cold-start timing assertion that failed CI on every push; review of external claims
- dd77e16 2026-10-17 Calculation in text (Alt+=), HTML export, SingularityApp analysis; block side menu stays off (it destabilised image and password scenarios)
- 66859e6 2026-10-17 Smooth fold of date groups and nested projects (Fold), test fixes
- 3606acd 2026-10-16 Motion: tokens, dialogs, menus, save tick, lock screen, focus, drop feedback, toast timer, reduced-motion switch
- 89babea 2026-10-16 Note passwords: AES-256-GCM per note, lock screen, idle lock, tests
- 0962a2c 2026-10-16 Take over from the external workspace: line endings, SSRF guard, decoding, wiki links in tables, CI; one print path
- e9fe9f0 2026-10-16 Take over from the external workspace: tiered history retention, proxy opt-in, code splitting, reload race fix
- 6b996a9 2026-10-16 Fix test infra, AI SSRF/cancel paths, line endings, import decoding; add print, dev AI guard, CI
- 0c459e6 2026-10-16 Pick several notes (Ctrl/Shift), bulk move/archive/trash, drag notes to projects
- 7e24505 2026-10-16 Status bar buttons (Focus, Compare, Tags), collapse button to sidebar bottom, no back/forward, Notepad parity (print, save as txt, F5, go to line, caret position, wrap, font), one UI font

## Ждёт решения владельца

Список ведётся в `docs/OPEN_QUESTIONS.md` (если файла нет, открытых вопросов не записано).

