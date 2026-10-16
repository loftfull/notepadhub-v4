// Pasting copied web content: the text and its formatting come through BlockNote as they are; the pictures are made local.
// A picture in copied HTML is either embedded (data:) or a web address. Both are stored by the host next to the notes, so the note
// keeps them when the page or the connection is gone. Anything else (file:, blob:, scripts) is dropped, never fetched.

export const MAX_PASTED_PICTURES = 20;
const MAX_BASE64_CHARS = 14_500_000;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i;

export type PictureStore = {
  /** stores base64 bytes, returns the address to show the picture from */
  saveBase64: (base64: string) => Promise<string>;
  /** downloads a web address through the host, returns the address to show the picture from */
  fetchUrl: (url: string) => Promise<string>;
};

export function embeddedBase64(src: string): string | null {
  const match = DATA_IMAGE.exec(src.trim());
  return match ? match[1].replace(/\s+/g, "") : null;
}

export function isWebAddress(src: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(src.trim());
}

/** Rewrites every picture of the HTML to a stored one. Returns the new HTML and how many pictures were kept and dropped. */
export async function localizePictures(html: string, store: PictureStore): Promise<{ html: string; kept: number; dropped: number }> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, iframe, object, embed").forEach((node) => node.remove());
  const images = [...doc.querySelectorAll("img")];
  let kept = 0;
  let dropped = 0;
  const drop = (img: Element) => {
    const alt = (img.getAttribute("alt") ?? "").trim();
    img.replaceWith(doc.createTextNode(alt ? `[${alt}]` : ""));
    dropped += 1;
  };
  let next = 0;
  const work = async (img: Element, index: number) => {
    const src = img.getAttribute("src") ?? "";
    if (index >= MAX_PASTED_PICTURES) { drop(img); return; }
    try {
      const base64 = embeddedBase64(src);
      if (base64 !== null) {
        if (base64.length > MAX_BASE64_CHARS) throw new Error("too large");
        img.setAttribute("src", await store.saveBase64(base64));
      } else if (isWebAddress(src)) {
        img.setAttribute("src", await store.fetchUrl(src));
      } else throw new Error("unsupported address");
      for (const name of ["srcset", "sizes", "loading", "width", "height", "style", "class"]) img.removeAttribute(name);
      kept += 1;
    } catch { drop(img); }
  };
  await Promise.all(Array.from({ length: Math.min(3, images.length) }, async () => { while (next < images.length) { const index = next++; await work(images[index], index); } }));
  return { html: doc.body.innerHTML, kept, dropped };
}
