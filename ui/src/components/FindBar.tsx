import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

type Find = {
  searchTerm: string;
  results: unknown[];
  currentIndex: number | null;
};

// Minimal structural view of the Tiptap editor used by BlockNote (commands come from @tiptap/extension-find-and-replace).
export type FindHost = {
  commands: Record<string, (...args: never[]) => boolean> & { setSearchTerm: (v: string) => boolean };
  storage: { findAndReplace: Find };
  on: (event: "transaction", cb: () => void) => void;
  off: (event: "transaction", cb: () => void) => void;
};

export function FindBar({ host, withReplace, onClose, onToggleReplace }: { host: FindHost; withReplace: boolean; onClose: () => void; onToggleReplace: () => void }) {
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // host.commands is rebuilt on every access, so always read it fresh and keep effects keyed to the editor only
  const cmd = new Proxy({}, { get: (_t, name: string) => (arg?: unknown) => (host.commands as unknown as Record<string, (a?: unknown) => boolean>)[name](arg) }) as Record<string, (arg?: unknown) => boolean>;

  useEffect(() => {
    const refresh = () => setTick((n) => n + 1);
    host.on("transaction", refresh);
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      host.off("transaction", refresh);
      (host.commands as unknown as Record<string, () => boolean>).clearSearch();
    };
  }, [host]);

  const update = useCallback((next: { term?: string; caseSensitive?: boolean; wholeWord?: boolean }) => {
    if (next.caseSensitive !== undefined) { setCaseSensitive(next.caseSensitive); cmd.setCaseSensitive(next.caseSensitive); }
    if (next.wholeWord !== undefined) { setWholeWord(next.wholeWord); cmd.setWholeWord(next.wholeWord); }
    if (next.term !== undefined) { setTerm(next.term); cmd.setSearchTerm(next.term); }
  }, [host]);

  const state = host.storage.findAndReplace;
  const total = state.results.length;
  const current = state.currentIndex === null ? 0 : state.currentIndex + 1;
  const counter = term ? (total ? `${current} из ${total}` : "Нет совпадений") : "";

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    else if (event.key === "Enter") { event.preventDefault(); if (event.target === inputRef.current) event.shiftKey ? cmd.goToPreviousResult() : cmd.goToNextResult(); else { cmd.setReplaceTerm(replacement); cmd.replace(); } }
  };

  return (
    <div className="find-bar" role="search" aria-label="Найти в заметке" onKeyDown={onKeyDown}>
      <div className="find-row">
        <input ref={inputRef} className="find-input" value={term} placeholder="Найти" aria-label="Что найти" onChange={(e) => update({ term: e.target.value })} />
        <span className="find-count" role="status" aria-live="polite">{counter}</span>
        <button className={`find-toggle${caseSensitive ? " is-on" : ""}`} aria-pressed={caseSensitive} title="Учитывать регистр" onClick={() => update({ caseSensitive: !caseSensitive })}>Аа</button>
        <button className={`find-toggle${wholeWord ? " is-on" : ""}`} aria-pressed={wholeWord} title="Слово целиком" onClick={() => update({ wholeWord: !wholeWord })}>«а»</button>
        <button className="icon-button quiet" aria-label="Предыдущее совпадение" title="Предыдущее (Shift+Enter)" disabled={!total} onClick={() => cmd.goToPreviousResult()}><ChevronUp size={16} /></button>
        <button className="icon-button quiet" aria-label="Следующее совпадение" title="Следующее (Enter)" disabled={!total} onClick={() => cmd.goToNextResult()}><ChevronDown size={16} /></button>
        <button className={`find-toggle${withReplace ? " is-on" : ""}`} aria-pressed={withReplace} title="Замена (Ctrl+H)" onClick={onToggleReplace}>Замена</button>
        <button className="icon-button quiet" aria-label="Закрыть поиск" title="Закрыть (Esc)" onClick={onClose}><X size={16} /></button>
      </div>
      {withReplace && (
        <div className="find-row">
          <input className="find-input" value={replacement} placeholder="Заменить на" aria-label="Чем заменить" onChange={(e) => { setReplacement(e.target.value); cmd.setReplaceTerm(e.target.value); }} />
          <button className="find-action" disabled={!total} onClick={() => { cmd.setReplaceTerm(replacement); cmd.replace(); }}>Заменить</button>
          <button className="find-action" disabled={!total} onClick={() => { cmd.setReplaceTerm(replacement); cmd.replaceAll(); }}>Заменить все</button>
        </div>
      )}
    </div>
  );
}
