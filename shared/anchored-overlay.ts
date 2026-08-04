import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export type OverlayRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export function getAnchoredOverlayPosition(
  anchor: OverlayRect,
  overlay: Pick<OverlayRect, "width" | "height">,
  viewport: { width: number; height: number },
  gap = 6,
  padding = 12,
) {
  const maxLeft = Math.max(padding, viewport.width - padding - overlay.width);
  const centeredLeft = anchor.left + anchor.width / 2 - overlay.width / 2;
  const left = Math.min(maxLeft, Math.max(padding, centeredLeft));
  const maxTop = Math.max(padding, viewport.height - padding - overlay.height);
  const preferredTop = anchor.top - gap - overlay.height;
  const fallbackTop = anchor.top + anchor.height + gap;
  const top = preferredTop >= padding
    ? Math.min(maxTop, preferredTop)
    : Math.min(maxTop, Math.max(padding, fallbackTop));

  return { left, top };
}

export function useAnchoredOverlay(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  overlayRef: RefObject<HTMLElement | null>,
  options?: { gap?: number; padding?: number },
): CSSProperties | undefined {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const anchor = anchorRef.current;
    const overlay = overlayRef.current;
    if (!anchor || !overlay) return;

    const update = () => {
      setPosition(getAnchoredOverlayPosition(
        anchor.getBoundingClientRect(),
        overlay.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        options?.gap,
        options?.padding,
      ));
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    observer.observe(overlay);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open, options?.gap, options?.padding, overlayRef]);

  if (!open) return undefined;
  return {
    position: "fixed",
    left: position?.left ?? 0,
    top: position?.top ?? 0,
    right: "auto",
    bottom: "auto",
    visibility: position ? "visible" : "hidden",
  };
}
