import { useLayoutEffect, useMemo } from "react";
import type { MutableRefObject, RefObject } from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type VirtualItem,
} from "@tanstack/react-virtual";

export type ChatScrollToIndexOptions = {
  align?: "auto" | "start" | "center" | "end";
  behavior?: ScrollBehavior;
};

export type ChatVirtualizerHandle = {
  getTotalSize: () => number;
  getVirtualItems: () => readonly VirtualItem[];
  scrollToIndex: (index: number, options?: ChatScrollToIndexOptions) => void;
  scrollToEnd: (behavior?: ScrollBehavior) => void;
  measure: () => void;
  isIndexMounted: (index: number) => boolean;
};

export type ChatVirtualizerRef = MutableRefObject<ChatVirtualizerHandle | null>;

type UseChatVirtualizerOptions = {
  count: number;
  itemKeys: readonly string[];
  scrollRef: RefObject<HTMLDivElement | null>;
  estimateSize: (index: number) => number;
  pinnedIndexes?: ReadonlySet<number>;
  gap?: number;
  anchorTo?: "start" | "end";
  overscan?: number;
};

/**
 * The chat keeps one real scroll container. This hook only virtualizes the
 * message rows inside it, so sticky process controls and the scroll-bottom
 * state can continue to use the existing container.
 */
export function useChatVirtualizer({
  count,
  itemKeys,
  scrollRef,
  estimateSize,
  pinnedIndexes,
  gap = 12,
  anchorTo = "end",
  overscan = 12,
}: UseChatVirtualizerOptions) {
  const rangeExtractor = useMemo(
    () => (range: Range) => {
      if (!pinnedIndexes || pinnedIndexes.size === 0) return defaultRangeExtractor(range);
      return Array.from(new Set([
        ...defaultRangeExtractor(range),
        ...pinnedIndexes,
      ])).sort((left, right) => left - right);
    },
    [pinnedIndexes],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey: (index) => itemKeys[index] || index,
    rangeExtractor,
    overscan,
    gap,
    // Let the virtualizer preserve the visible anchor when an estimated row is
    // replaced by its measured height. Bottom-following is coordinated by
    // useChatScroll, so this option must not force every append to the bottom.
    anchorTo,
    scrollEndThreshold: 50,
    useAnimationFrameWithResizeObserver: true,
  });

  const handle = useMemo<ChatVirtualizerHandle>(() => ({
    getTotalSize: () => virtualizer.getTotalSize(),
    getVirtualItems: () => virtualizer.getVirtualItems(),
    scrollToIndex: (index, options) => virtualizer.scrollToIndex(index, options),
    scrollToEnd: (behavior = "auto") => virtualizer.scrollToEnd({ behavior }),
    measure: () => virtualizer.measure(),
    isIndexMounted: (index) => virtualizer.getVirtualItems().some((item) => item.index === index),
  }), [virtualizer]);

  return { virtualizer, handle };
}

export function useExposeChatVirtualizer(
  ref: ChatVirtualizerRef | undefined,
  handle: ChatVirtualizerHandle,
) {
  useLayoutEffect(() => {
    if (!ref) return;
    ref.current = handle;
    return () => {
      if (ref.current === handle) ref.current = null;
    };
  }, [handle, ref]);
}
