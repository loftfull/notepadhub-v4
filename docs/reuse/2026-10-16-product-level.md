# Продуктовый срез: приложение целиком

Дата: 2026-10-16. Аналоги изучены для верхнего уровня (расположение разделов, вкладки, список заметок, экран пустой заметки, две заметки, панель ИИ).

## Продуктовые аналоги

| Продукт | Ссылка | Что взято / что отвергнуто |
|---|---|---|
| Notion | https://www.notion.com | Один сайдбар, одно действие «Новая», узкая колонка текста. Не взято: облако |
| Obsidian | https://obsidian.md | Заметки файлами на диске, вкладки, две панели рядом, палитра команд. Не взято: плагины |
| Apple Notes | https://www.apple.com/icloud/ | Список заметок рядом с редактором, поиск в углу |
| Bear | https://bear.app | Тихий статус сохранения, метки в сайдбаре. Не взято: только Apple |
| OneNote | https://www.onenote.com | Группы команд на ленте (правка, вставка, вид) |
| Evernote | https://evernote.com | Опасные действия (корзина) спрятаны в меню |
| Typora | https://typora.io | Предпросмотр как переключатель вида |
| Craft | https://www.craft.do | Один выделенный акцент на кнопке ИИ |
| Open Notebook | https://github.com/lfnovo/open-notebook | Преобразования над материалом, свои инструкции с пробой |
| Standard Notes | https://standardnotes.com | Локальность и приватность как главный довод |

## Стек

| Слой | Решение | Ссылка |
|---|---|---|
| Основа окна | WPF + WebView2 | https://learn.microsoft.com/microsoft-edge/webview2/ |
| Редактор | BlockNote 0.55 | https://www.blocknotejs.org |
| Интерфейс | React 19 + Vite | https://react.dev |
| Данные | Файл на заметку, без базы | https://github.com/lfnovo/open-notebook (идея разделения материала и заметки) |
| Значки | lucide-react | https://lucide.dev |
| ИИ | Ollama, OpenRouter, любой сервис OpenAI-формата, по умолчанию Pollinations | https://ollama.com |
| Авторизация | Не нужна: приложение локальное | https://learn.microsoft.com/windows/win32/api/dpapi/ (ключи сервисов в DPAPI) |
