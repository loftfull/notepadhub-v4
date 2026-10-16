import { RotateCcw, Trash2, X } from "lucide-react";

export type TrashItem = { id: string; title: string; deletedAt: string };

const DAY = 24 * 60 * 60 * 1000;
export const TRASH_DAYS = 30;

/** "только что", "5 мин назад", "2 ч назад", "3 дн. назад" for the moment a note was deleted. */
export function agoRu(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "только что";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн. назад`;
}

/** Whole days left before the note leaves the trash for good (never below 0). */
export function daysLeft(iso: string, now = Date.now()): number {
  const age = now - Date.parse(iso);
  return Number.isFinite(age) ? Math.max(0, TRASH_DAYS - Math.floor(age / DAY)) : TRASH_DAYS;
}

/** The trash as a list in the main area: what was deleted and when, restore or delete for good on every row, clean all at the bottom. */
export function TrashView({ items, onRestore, onDeleteForever, onOpen, onEmpty }: {
  items: TrashItem[];
  onRestore: (id: string) => void;
  onDeleteForever: (id: string) => void;
  onOpen: (id: string) => void;
  onEmpty: () => void;
}) {
  return (
    <section className="trash-view" aria-label="Корзина">
      <header>
        <h1>Корзина</h1>
        <p>{items.length === 0 ? "Корзина пуста." : `Удалённых заметок: ${items.length}. Заметки удаляются навсегда через ${TRASH_DAYS} дней.`}</p>
      </header>
      {items.length > 0 && <ul className="trash-list">
        {items.map((item) => <li key={item.id}>
          <button type="button" className="trash-title" onClick={() => onOpen(item.id)} title="Открыть заметку для просмотра"><b>{item.title}</b><small>удалена {agoRu(item.deletedAt)} · осталось {daysLeft(item.deletedAt)} дн.</small></button>
          <button type="button" className="trash-restore" onClick={() => onRestore(item.id)}><RotateCcw size={14} aria-hidden="true" />Восстановить</button>
          <button type="button" className="trash-forever" aria-label={`Удалить «${item.title}» навсегда`} title="Удалить навсегда" onClick={() => onDeleteForever(item.id)}><X size={15} aria-hidden="true" /></button>
        </li>)}
      </ul>}
      {items.length > 0 && <div className="trash-footer"><button type="button" className="trash-empty" onClick={onEmpty}><Trash2 size={14} aria-hidden="true" />Очистить корзину</button></div>}
    </section>
  );
}
