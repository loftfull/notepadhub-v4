import { useState } from "react";
import { LoaderCircle, Pencil, Play, Trash2, X } from "lucide-react";
import { MAX_CUSTOM, MAX_CUSTOM_PROMPT, newCustomId, sanitizeCustom, type Transformation } from "../transformations";

/** The owner's own transformations: a title and a prompt, a "probe" on a sample text without saving anything into a note, then save. */
export function TransformationsDialog({ list, onSave, onProbe, onClose }: {
  list: Transformation[];
  onSave: (custom: Transformation[]) => void;
  onProbe: (prompt: string, sample: string) => Promise<string>;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Transformation[]>(() => list.filter((t) => t.custom));
  const [editing, setEditing] = useState<{ id: string; title: string; prompt: string } | null>(null);
  const [sample, setSample] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = (t?: Transformation) => { setEditing({ id: t?.id ?? newCustomId(), title: t?.title ?? "", prompt: t?.prompt ?? "" }); setResult(""); setError(""); };
  const valid = editing ? sanitizeCustom(editing) : null;
  const commit = () => {
    if (!valid) { setError("Название: 2–40 знаков, инструкция: 8–" + MAX_CUSTOM_PROMPT + " знаков."); return; }
    const next = items.some((t) => t.id === valid.id) ? items.map((t) => t.id === valid.id ? valid : t) : [...items, valid].slice(0, MAX_CUSTOM);
    setItems(next); onSave(next); setEditing(null); setResult(""); setError("");
  };
  const probe = async () => {
    if (!editing || editing.prompt.trim().length < 8 || sample.trim().length < 20) { setError("Для пробы нужны инструкция и пример текста (от 20 знаков)."); return; }
    setBusy(true); setError(""); setResult("");
    try { setResult(await onProbe(editing.prompt.trim(), sample.trim())); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось выполнить пробу."); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="form-modal image-modal tf-modal" role="dialog" aria-modal="true" aria-labelledby="tf-title">
        <div className="form-modal-heading"><div><h2 id="tf-title">Свои трансформации</h2><p>Инструкция, которую можно выполнить над любым материалом. Результат попадает в заметку отдельным инсайтом.</p></div><button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={18} /></button></div>
        {!editing && <>
          {items.length === 0 && <p className="tf-empty">Пока нет своих трансформаций. Пример: «Выпиши все даты и сроки списком».</p>}
          <ul className="tf-list">{items.map((t) => <li key={t.id}><span><b>{t.title}</b><small>{t.prompt.slice(0, 90)}{t.prompt.length > 90 ? "…" : ""}</small></span>
            <button type="button" aria-label={`Изменить «${t.title}»`} onClick={() => start(t)}><Pencil size={14} /></button>
            <button type="button" aria-label={`Удалить «${t.title}»`} onClick={() => { const next = items.filter((x) => x.id !== t.id); setItems(next); onSave(next); }}><Trash2 size={14} /></button></li>)}</ul>
          <div className="form-modal-actions"><button type="button" className="form-cancel" onClick={onClose}>Закрыть</button><button type="button" className="form-submit" disabled={items.length >= MAX_CUSTOM} onClick={() => start()}>Новая трансформация</button></div>
        </>}
        {editing && <>
          <label className="meta-field"><span>Название</span><input autoFocus value={editing.title} maxLength={40} onChange={(event) => setEditing({ ...editing, title: event.target.value })} placeholder="Например: Сроки и даты" /></label>
          <label className="meta-field"><span>Инструкция для модели ({editing.prompt.length}/{MAX_CUSTOM_PROMPT})</span><textarea rows={3} maxLength={MAX_CUSTOM_PROMPT} value={editing.prompt} onChange={(event) => setEditing({ ...editing, prompt: event.target.value })} placeholder="Например: Выпиши все даты и сроки из текста маркированным списком; ничего не придумывай." /></label>
          <label className="meta-field"><span>Проба: пример текста (ничего не сохраняется)</span><textarea rows={3} value={sample} onChange={(event) => setSample(event.target.value)} placeholder="Вставьте абзац, на котором проверить инструкцию" /></label>
          {result && <figure className="tf-result"><figcaption>Результат пробы</figcaption><pre>{result}</pre></figure>}
          {error && <p role="alert" className="image-error">{error}</p>}
          <div className="form-modal-actions">
            <button type="button" className="form-cancel" onClick={() => { setEditing(null); setError(""); }}>Назад</button>
            <button type="button" className="form-cancel" disabled={busy} onClick={() => void probe()}>{busy ? <><LoaderCircle size={14} className="ai-spinner" /> Проверяю…</> : <><Play size={14} /> Проба</>}</button>
            <button type="button" className="form-submit" disabled={!valid} onClick={commit}>Сохранить</button>
          </div>
        </>}
      </div>
    </div>
  );
}
