import { useEffect, useState, type ReactNode } from "react";

/**
 * Smooth fold / unfold of a block of any height: the grid row goes 0fr ↔ 1fr (no height measuring, works in WebView2).
 * The content stays in the page while it closes (EXIT_MS) and leaves it afterwards, so a folded block costs nothing and
 * is out of the tab order. The first render of an open block has no animation.
 */
const EXIT_MS = 200;

export function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  const [present, setPresent] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = window.setTimeout(() => setPresent(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);
  if (!present) return null;
  return <div className="fold" data-open={shown}><div className="fold-inner">{children}</div></div>;
}
