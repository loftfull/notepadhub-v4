import { useState } from "react";
import { Lock, X } from "lucide-react";

/** The cover of a note that has a password and is not unlocked: the text is not in the page at all, only this form. */
export function LockScreen({ title, onUnlock }: { title: string; onUnlock: (password: string) => Promise<string | null> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true); setError("");
    const problem = await onUnlock(password);
    setBusy(false);
    if (problem) { setError(problem); setPassword(""); }
  };
  return (
    <form className="lock-screen" role="group" aria-label="Заметка защищена паролем" onSubmit={(event) => void submit(event)}>
      <Lock size={30} aria-hidden="true" />
      <h2>Заметка защищена паролем</h2>
      <p>«{title}». Текст зашифрован и откроется после ввода пароля.</p>
      <input type="password" autoFocus autoComplete="off" aria-label="Пароль заметки" placeholder="Пароль" value={password} onChange={(event) => setPassword(event.target.value)} />
      {error && <p className="lock-error" role="alert">{error}</p>}
      <button type="submit" className="form-submit" disabled={!password || busy}>{busy ? "Проверяем…" : "Открыть"}</button>
    </form>
  );
}

/** Asks for a new password (twice) or for the current one before it is taken off. */
export function PasswordDialog({ kind, title, onSubmit, onClose }: {
  kind: "set" | "remove";
  title: string;
  onSubmit: (password: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (kind === "set") {
      if (password.length < 4) { setError("Пароль короче 4 знаков."); return; }
      if (password !== repeat) { setError("Пароли не совпадают."); return; }
    }
    setBusy(true); setError("");
    const problem = await onSubmit(password);
    setBusy(false);
    if (problem) setError(problem); else onClose();
  };
  return (
    <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="form-modal" role="dialog" aria-modal="true" aria-labelledby="pw-title" onSubmit={(event) => void submit(event)}>
        <div className="form-modal-heading">
          <div><h2 id="pw-title">{kind === "set" ? "Защитить паролем" : "Снять пароль"}</h2><p>{title}</p></div>
          <button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={18} /></button>
        </div>
        {kind === "set" && <p className="pw-warning">Забытый пароль восстановить нельзя: текст заметки, её блоки и история версий будут зашифрованы. Название, метки и проект останутся видны. Ключ хранится только в памяти и забывается при закрытии программы.</p>}
        <input type="password" autoFocus autoComplete="off" aria-label={kind === "set" ? "Новый пароль" : "Пароль заметки"} placeholder={kind === "set" ? "Новый пароль" : "Пароль заметки"} value={password} onChange={(event) => setPassword(event.target.value)} />
        {kind === "set" && <input type="password" autoComplete="off" aria-label="Повторите пароль" placeholder="Повторите пароль" value={repeat} onChange={(event) => setRepeat(event.target.value)} />}
        {error && <p className="lock-error" role="alert">{error}</p>}
        <div className="form-modal-actions">
          <button type="button" className="form-cancel" onClick={onClose}>Отмена</button>
          <button type="submit" className="form-submit" disabled={busy || !password}>{busy ? "Подождите…" : "Готово"}</button>
        </div>
      </form>
    </div>
  );
}
