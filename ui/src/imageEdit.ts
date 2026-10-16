// Picture editing in the note: rotate, flip, crop, brightness, contrast, saturation, grey, shrink. Done on the page with a canvas, no model.
// The geometry and the filter string are pure functions (tested); drawing needs a browser.

export type EditParams = {
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /** percent cut from each side, 0-45 */
  crop: { left: number; top: number; right: number; bottom: number };
  /** longest allowed width of the result in pixels, 0 = keep */
  maxWidth: number;
  brightness: number;   // -100..100
  contrast: number;     // -100..100
  saturation: number;   // -100..100
  gray: boolean;
};

export const defaultParams = (): EditParams => ({ rotate: 0, flipH: false, flipV: false, crop: { left: 0, top: 0, right: 0, bottom: 0 }, maxWidth: 0, brightness: 0, contrast: 0, saturation: 0, gray: false });

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));

export function isUnchanged(p: EditParams): boolean {
  const d = defaultParams();
  return p.rotate === d.rotate && !p.flipH && !p.flipV && !p.gray && p.maxWidth === 0 && p.brightness === 0 && p.contrast === 0 && p.saturation === 0
    && p.crop.left === 0 && p.crop.top === 0 && p.crop.right === 0 && p.crop.bottom === 0;
}

/** The part of the source that is kept, in source pixels. At least 1 px wide and high; both opposite sides never cross. */
export function cropRect(width: number, height: number, crop: EditParams["crop"]): { x: number; y: number; w: number; h: number } {
  const l = clamp(crop.left, 0, 45), r = clamp(crop.right, 0, 45), t = clamp(crop.top, 0, 45), b = clamp(crop.bottom, 0, 45);
  const x = Math.round((width * l) / 100), y = Math.round((height * t) / 100);
  return { x, y, w: Math.max(1, Math.round((width * (100 - l - r)) / 100)), h: Math.max(1, Math.round((height * (100 - t - b)) / 100)) };
}

/** The size of the result after crop, rotation and shrinking. */
export function outputSize(width: number, height: number, p: EditParams): { w: number; h: number; scale: number } {
  const c = cropRect(width, height, p.crop);
  const swap = p.rotate === 90 || p.rotate === 270;
  const w = swap ? c.h : c.w, h = swap ? c.w : c.h;
  const scale = p.maxWidth > 0 && w > p.maxWidth ? p.maxWidth / w : 1;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

/** CSS filter for the canvas context: sliders -100..100 become percentages around 100 %. */
export function cssFilter(p: EditParams): string {
  const parts: string[] = [];
  if (p.brightness !== 0) parts.push(`brightness(${100 + clamp(p.brightness, -100, 100)}%)`);
  if (p.contrast !== 0) parts.push(`contrast(${100 + clamp(p.contrast, -100, 100)}%)`);
  if (p.saturation !== 0) parts.push(`saturate(${100 + clamp(p.saturation, -100, 100)}%)`);
  if (p.gray) parts.push("grayscale(100%)");
  return parts.length ? parts.join(" ") : "none";
}

export function renderEdited(source: CanvasImageSource & { width: number; height: number }, p: EditParams): HTMLCanvasElement {
  const { w, h, scale } = outputSize(source.width, source.height, p);
  const c = cropRect(source.width, source.height, p.crop);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Редактор изображений недоступен.");
  ctx.filter = cssFilter(p);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((p.rotate * Math.PI) / 180);
  ctx.scale(p.flipH ? -1 : 1, p.flipV ? -1 : 1);
  ctx.scale(scale, scale);
  ctx.drawImage(source, c.x, c.y, c.w, c.h, -c.w / 2, -c.h / 2, c.w, c.h);
  return canvas;
}
