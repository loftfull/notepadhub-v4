import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, RotateCcw, RotateCw, FlipHorizontal2, FlipVertical2, Sparkles, X } from "lucide-react";
import { host } from "../bridge";
import { cropRect, defaultParams, isUnchanged, outputSize, renderEdited, type EditParams } from "../imageEdit";

const ASSET_HOST = "https://assets.notepadhub.local/";
export const assetName = (url: string) => (url.startsWith(ASSET_HOST) ? url.slice(ASSET_HOST.length) : "");

export type NoteImage = { id: string; url: string; caption: string };

// ---------------------------------------------------------------- creating a new picture

const SIZES: Array<{ id: string; label: string; w: number; h: number }> = [
  { id: "sq", label: "Квадрат 768×768", w: 768, h: 768 },
  { id: "wide", label: "Широкая 1024×576", w: 1024, h: 576 },
  { id: "tall", label: "Высокая 576×1024", w: 576, h: 1024 },
];

export function ImageGenerateDialog({ suggestSelection, suggestNote, serviceReady, serviceName, initialPrompt, initialConsent, autoStart, onInsert, onClose }: {
  suggestSelection: string;
  suggestNote: string;
  serviceReady: boolean;
  serviceName: string;
  /** a description typed in the AI panel: it starts the picture at once */
  initialPrompt?: string;
  initialConsent?: boolean;
  autoStart?: boolean;
  onInsert: (url: string, caption: string) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [size, setSize] = useState("sq");
  const [via, setVia] = useState<"pollinations" | "service">("pollinations");
  const [model, setModel] = useState(() => { try { return localStorage.getItem("nh4-image-model") ?? ""; } catch { return ""; } });
  const [consent, setConsent] = useState(initialConsent ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const chosen = SIZES.find((item) => item.id === size) ?? SIZES[0];

  const generate = async () => {
    setBusy(true); setError(""); setResult(null);
    try {
      try { localStorage.setItem("nh4-image-model", model); } catch { /* optional */ }
      const { file } = await host.generateImage(prompt.trim(), chosen.w, chosen.h, via, model.trim(), consent);
      setResult(ASSET_HOST + file);
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось создать картинку."); }
    finally { setBusy(false); }
  };

  useEffect(() => { if (autoStart && prompt.trim() && consent) void generate(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="form-modal image-modal" role="dialog" aria-modal="true" aria-labelledby="img-gen-title">
        <div className="form-modal-heading"><div><h2 id="img-gen-title">Создать изображение</h2><p>Опишите картинку словами или возьмите текст из заметки.</p></div><button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={18} /></button></div>
        <label className="meta-field"><span>Описание</span><textarea autoFocus rows={3} maxLength={600} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Например: акварельная иллюстрация, рыжая кошка спит на подоконнике" /></label>
        <div className="image-quick">
          <button type="button" disabled={!suggestSelection.trim()} onClick={() => setPrompt(suggestSelection.trim().slice(0, 600))}>По выделенному тексту</button>
          <button type="button" disabled={!suggestNote.trim()} onClick={() => setPrompt(("Иллюстрация к тексту: " + suggestNote.trim()).slice(0, 600))}>По содержимому заметки</button>
        </div>
        <label className="meta-field"><span>Размер</span><select value={size} onChange={(event) => setSize(event.target.value)}>{SIZES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="meta-field"><span>Откуда взять картинку</span>
          <select value={via} onChange={(event) => setVia(event.target.value as "pollinations" | "service")}>
            <option value="pollinations">Pollinations: бесплатно, без ключа</option>
            <option value="service" disabled={!serviceReady}>{serviceReady ? `Мой сервис: ${serviceName}` : "Мой сервис (не настроен в настройках AI)"}</option>
          </select>
        </label>
        {via === "service" && <label className="meta-field"><span>Модель для картинок</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="например: dall-e-3 или imagen-4.0-generate-001" spellCheck={false} /></label>}
        <label className="ais-check"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> Разрешаю отправить это описание {via === "pollinations" ? "на image.pollinations.ai (сторонний бесплатный сервис без гарантий)" : `сервису «${serviceName}»`}. Текст заметки не отправляется, только описание выше.</label>
        {error && <p role="alert" className="image-error">{error}</p>}
        {result && <figure className="image-result"><img src={result} alt={prompt} /><figcaption>Готово. Вставить в заметку или создать ещё.</figcaption></figure>}
        <div className="form-modal-actions">
          <button type="button" className="form-cancel" onClick={onClose}>Закрыть</button>
          {result && <button type="button" className="form-submit" onClick={() => { onInsert(result, prompt.trim()); onClose(); }}><ImagePlus size={14} /> Вставить в заметку</button>}
          <button type="button" className={result ? "form-cancel" : "form-submit"} disabled={busy || !consent || prompt.trim().length < 3 || (via === "service" && !model.trim())} onClick={() => void generate()}>{busy ? <><LoaderCircle size={14} className="ai-spinner" /> Создаю…</> : <><Sparkles size={14} /> {result ? "Создать ещё" : "Создать"}</>}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- editing a picture of the note

function loadImage(base64: string, mime: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Не удалось открыть картинку."));
    img.src = `data:${mime};base64,${base64}`;
  });
}

const mimeOf = (name: string) => (name.endsWith(".jpg") ? "image/jpeg" : name.endsWith(".gif") ? "image/gif" : name.endsWith(".webp") ? "image/webp" : "image/png");

export function ImageEditDialog({ images, startId, onReplace, onClose }: {
  images: NoteImage[];
  startId?: string;
  onReplace: (id: string, url: string) => void;
  onClose: () => void;
}) {
  const [currentId, setCurrentId] = useState(startId && images.some((i) => i.id === startId) ? startId : images[0]?.id ?? "");
  const current = images.find((i) => i.id === currentId);
  const [params, setParams] = useState<EditParams>(defaultParams);
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const preview = useRef<HTMLCanvasElement>(null);
  const name = current ? assetName(current.url) : "";

  useEffect(() => {
    setSource(null); setError(""); setParams(defaultParams());
    if (!name) { if (current) setError("Редактировать можно только картинки, сохранённые в заметке."); return; }
    let alive = true;
    host.readAsset(name).then(({ data }) => loadImage(data, mimeOf(name))).then((img) => { if (alive) setSource(img); }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : "Не удалось прочитать картинку."); });
    return () => { alive = false; };
  }, [name, current]);

  useEffect(() => {
    if (!source || !preview.current) return;
    try {
      const full = renderEdited(source, params);
      const ratio = Math.min(1, 460 / full.width, 340 / full.height);
      const canvas = preview.current;
      canvas.width = Math.max(1, Math.round(full.width * ratio));
      canvas.height = Math.max(1, Math.round(full.height * ratio));
      canvas.getContext("2d")?.drawImage(full, 0, 0, canvas.width, canvas.height);
    } catch (e) { setError(e instanceof Error ? e.message : "Ошибка предпросмотра."); }
  }, [source, params]);

  const size = useMemo(() => (source ? outputSize(source.width, source.height, params) : null), [source, params]);
  const set = (patch: Partial<EditParams>) => setParams((p) => ({ ...p, ...patch }));
  const setCrop = (side: keyof EditParams["crop"], value: number) => setParams((p) => ({ ...p, crop: { ...p.crop, [side]: value } }));
  const turn = (delta: 90 | -90) => setParams((p) => ({ ...p, rotate: ((p.rotate + delta + 360) % 360) as EditParams["rotate"] }));

  const save = async () => {
    if (!source || !current) return;
    setBusy(true); setError("");
    try {
      const canvas = renderEdited(source, params);
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Не удалось собрать картинку.");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const { file } = await host.saveAsset(btoa(binary));
      onReplace(current.id, ASSET_HOST + file);
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить картинку."); }
    finally { setBusy(false); }
  };

  const crop = source ? cropRect(source.width, source.height, params.crop) : null;
  return (
    <div className="modal-backdrop form-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="form-modal image-modal image-edit" role="dialog" aria-modal="true" aria-labelledby="img-edit-title">
        <div className="form-modal-heading"><div><h2 id="img-edit-title">Редактировать изображение</h2><p>Поворот, отражение, обрезка, яркость, контраст, насыщенность, размер. Исходная картинка не меняется: в заметке она заменяется новой.</p></div><button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={18} /></button></div>
        {images.length === 0 && <p>В заметке нет изображений. Вставьте картинку (Ctrl+V) или создайте новую.</p>}
        {images.length > 1 && <div className="image-pick" role="listbox" aria-label="Изображения заметки">{images.map((item, index) => <button key={item.id} type="button" role="option" aria-selected={item.id === currentId} className={item.id === currentId ? "is-on" : ""} onClick={() => setCurrentId(item.id)}><img src={item.url} alt={item.caption || `Изображение ${index + 1}`} /></button>)}</div>}
        {current && <>
          <div className="image-stage">{source ? <canvas ref={preview} aria-label="Предпросмотр результата" /> : <p role="status">{error || "Загружаю…"}</p>}</div>
          {source && size && <p className="image-size">{source.width}×{source.height} → {size.w}×{size.h} px</p>}
          <div className="image-tools">
            <div className="image-buttons" role="group" aria-label="Поворот и отражение">
              <button type="button" onClick={() => turn(-90)} title="Повернуть влево"><RotateCcw size={15} /></button>
              <button type="button" onClick={() => turn(90)} title="Повернуть вправо"><RotateCw size={15} /></button>
              <button type="button" aria-pressed={params.flipH} className={params.flipH ? "is-on" : ""} onClick={() => set({ flipH: !params.flipH })} title="Отразить по горизонтали"><FlipHorizontal2 size={15} /></button>
              <button type="button" aria-pressed={params.flipV} className={params.flipV ? "is-on" : ""} onClick={() => set({ flipV: !params.flipV })} title="Отразить по вертикали"><FlipVertical2 size={15} /></button>
              <label className="image-check"><input type="checkbox" checked={params.gray} onChange={(event) => set({ gray: event.target.checked })} /> Чёрно-белое</label>
            </div>
            {([["brightness", "Яркость"], ["contrast", "Контраст"], ["saturation", "Насыщенность"]] as const).map(([key, label]) => <label key={key} className="image-slider"><span>{label}</span><input type="range" min={-100} max={100} value={params[key]} onChange={(event) => set({ [key]: Number(event.target.value) } as Partial<EditParams>)} /><output>{params[key]}</output></label>)}
            {([["left", "Обрезать слева"], ["right", "Обрезать справа"], ["top", "Обрезать сверху"], ["bottom", "Обрезать снизу"]] as const).map(([side, label]) => <label key={side} className="image-slider"><span>{label}</span><input type="range" min={0} max={45} value={params.crop[side]} onChange={(event) => setCrop(side, Number(event.target.value))} /><output>{params.crop[side]}%</output></label>)}
            <label className="image-slider"><span>Макс. ширина</span><select value={params.maxWidth} onChange={(event) => set({ maxWidth: Number(event.target.value) })}><option value={0}>Как есть</option><option value={1600}>1600 px</option><option value={1024}>1024 px</option><option value={640}>640 px</option></select></label>
          </div>
          {error && source && <p role="alert" className="image-error">{error}</p>}
        </>}
        <div className="form-modal-actions">
          <button type="button" className="form-cancel" onClick={() => setParams(defaultParams())} disabled={isUnchanged(params)}>Сбросить</button>
          <button type="button" className="form-cancel" onClick={onClose}>Отмена</button>
          <button type="button" className="form-submit" disabled={!source || busy || isUnchanged(params) || (crop?.w ?? 0) < 1} onClick={() => void save()}>{busy ? "Сохраняю…" : "Применить к заметке"}</button>
        </div>
      </div>
    </div>
  );
}
