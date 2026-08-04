import { useCallback, useEffect, useRef, type RefObject } from "react";

const AUTO_SCROLL_SPEED = 1.5;
const AUTO_SCROLL_EDGE = 56;

/** Keeps a scroll container moving while a dragged item is held near an edge. */
export function useDragAutoScroll(containerRef: RefObject<HTMLElement | null>) {
  const frameRef = useRef<number | null>(null);
  const directionRef = useRef<-1 | 0 | 1>(0);

  const stop = useCallback(() => {
    directionRef.current = 0;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    const container = containerRef.current;
    const direction = directionRef.current;
    if (!container || direction === 0) {
      frameRef.current = null;
      return;
    }

    const previousScrollTop = container.scrollTop;
    container.scrollTop += direction * AUTO_SCROLL_SPEED;
    if (container.scrollTop === previousScrollTop) {
      stop();
      return;
    }
    frameRef.current = requestAnimationFrame(tick);
  }, [containerRef, stop]);

  const update = useCallback((clientY: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const edge = Math.min(AUTO_SCROLL_EDGE, rect.height / 3);
    const nextDirection: -1 | 0 | 1 = clientY <= rect.top + edge
      ? -1
      : clientY >= rect.bottom - edge
        ? 1
        : 0;

    if (nextDirection === 0) {
      stop();
      return;
    }
    if (directionRef.current === nextDirection && frameRef.current !== null) return;
    directionRef.current = nextDirection;
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(tick);
    }
  }, [containerRef, stop, tick]);

  useEffect(() => stop, [stop]);

  return { update, stop };
}
