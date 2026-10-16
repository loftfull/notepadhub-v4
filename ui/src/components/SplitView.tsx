import { useMemo } from "react";
import { ArrowLeft, ArrowLeftRight, ArrowRight, GitCompare, X } from "lucide-react";
import { compareNotes, type CompareRow, type DiffPart } from "../compareNotes";

export type PickNote = { id: string; title: string };

/** The strip above two open notes: a note is chosen on each side, the selection moves across, compare, swap, close. */
export function SplitBar({ leftId, rightId, notes, onPickLeft, onPickRight, onMoveRight, onMoveLeft, onCompare, onSwap, onClose }: {
  leftId: string;
  rightId: string;
  notes: PickNote[];
  onPickLeft: (id: string) => void;
  onPickRight: (id: string) => void;
  onMoveRight: () => void;
  onMoveLeft: () => void;
  onCompare: () => void;
  onSwap: () => void;
  onClose: () => void;
}) {
  const side = (label: string, value: string, other: string, onPick: (id: string) => void, cls: string) => (
    <label className={`split-pick ${cls}`}>
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onPick(event.target.value)}>
        {notes.filter((item) => item.id !== other).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
    </label>
  );
  return (
    <div className="split-bar" role="toolbar" aria-label="Две заметки на экране">
      {side("Слева", leftId, rightId, onPickLeft, "is-left")}
      <span className="split-actions">
        <button type="button" onClick={onMoveRight} title="Выделите текст или блоки слева и нажмите: они добавятся в правую заметку"><ArrowRight size={14} />Копировать вправо</button>
        <button type="button" onClick={onMoveLeft} title="Выделите текст или блоки справа и нажмите: они добавятся в левую заметку"><ArrowLeft size={14} />Копировать влево</button>
        <button type="button" onClick={onCompare}><GitCompare size={14} />Сравнить</button>
        <button type="button" onClick={onSwap} aria-label="Поменять заметки местами" title="Поменять заметки местами"><ArrowLeftRight size={14} /></button>
      </span>
      {side("Справа", rightId, leftId, onPickRight, "is-right")}
      <button type="button" className="split-close" aria-label="Закрыть правую заметку" title="Закрыть правую заметку" onClick={onClose}><X size={15} /></button>
    </div>
  );
}

const renderParts = (parts: DiffPart[], kind: "del" | "ins") => parts.map((part, index) => part.kind === "same" ? <span key={index}>{part.text}</span> : part.kind === kind ? (kind === "del" ? <del key={index}>{part.text}</del> : <ins key={index}>{part.text}</ins>) : null);

/** Side-by-side comparison of two notes, paragraph by paragraph, words inside a changed pair; any paragraph can be copied across. */
export function CompareDialog({ leftTitle, rightTitle, left, right, onCopyRight, onCopyLeft, onClose }: {
  leftTitle: string;
  rightTitle: string;
  left: string[];
  right: string[];
  onCopyRight: (text: string) => void;
  onCopyLeft: (text: string) => void;
  onClose: () => void;
}) {
  const result = useMemo(() => compareNotes(left, right), [left, right]);
  const cell = (row: CompareRow, side: "left" | "right") => {
    if (row.kind === "same") return <p className="cmp-same">{side === "left" ? row.left : row.right}</p>;
    if (row.kind === "changed") return <p className="cmp-changed">{side === "left" ? renderParts(row.leftParts, "del") : renderParts(row.rightParts, "ins")}</p>;
    if (row.kind === "left-only") return side === "left" ? <p className="cmp-del">{row.left}</p> : <p className="cmp-gap" aria-hidden="true">—</p>;
    return side === "right" ? <p className="cmp-ins">{row.right}</p> : <p className="cmp-gap" aria-hidden="true">—</p>;
  };
  return (
    <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="form-modal compare-modal" role="dialog" aria-modal="true" aria-labelledby="cmp-title">
        <div className="form-modal-heading"><div><h2 id="cmp-title">Сравнение заметок</h2>
          <p>Совпадение {Math.round(result.similarity * 100)}%: одинаковых абзацев {result.same}, изменённых {result.changed}, только слева {result.leftOnly}, только справа {result.rightOnly}.</p></div>
          <button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={18} /></button></div>
        <div className="cmp-head"><strong title={leftTitle}>{leftTitle}</strong><span /><strong title={rightTitle}>{rightTitle}</strong></div>
        <div className="cmp-body" role="table" aria-label="Абзацы двух заметок">
          {result.rows.map((row, index) => (
            <div className={`cmp-row is-${row.kind}`} role="row" key={index}>
              <div className="cmp-cell" role="cell">{cell(row, "left")}</div>
              <div className="cmp-mid">
                {(row.kind === "left-only" || row.kind === "changed") && <button type="button" title="Скопировать абзац в конец правой заметки" aria-label="Скопировать абзац вправо" onClick={() => onCopyRight(row.left)}><ArrowRight size={13} /></button>}
                {(row.kind === "right-only" || row.kind === "changed") && <button type="button" title="Скопировать абзац в конец левой заметки" aria-label="Скопировать абзац влево" onClick={() => onCopyLeft(row.right)}><ArrowLeft size={13} /></button>}
              </div>
              <div className="cmp-cell" role="cell">{cell(row, "right")}</div>
            </div>
          ))}
          {result.rows.length === 0 && <p className="cmp-empty">Обе заметки пусты.</p>}
        </div>
        <div className="form-modal-actions"><button type="button" className="form-submit" onClick={onClose}>Закрыть</button></div>
      </div>
    </div>
  );
}
