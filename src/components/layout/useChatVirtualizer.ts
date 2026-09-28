import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
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
  // virtual-core 把回调的「函数身份」当作 memo 依赖（见其 getMeasurementOptions /
  // getVirtualIndexes）。若每次渲染都传新函数，它会在每次渲染重建 O(count) 的
  // measurements 缓存——流式期间每 120ms 一次。这里统一用 ref 读取最新值，
  // 把传给 virtualizer 的身份固定下来。
  const itemKeysRef = useRef(itemKeys);
  itemKeysRef.current = itemKeys;
  const estimateSizeRef = useRef(estimateSize);
  estimateSizeRef.current = estimateSize;
  const pinnedIndexesRef = useRef(pinnedIndexes);
  pinnedIndexesRef.current = pinnedIndexes;

  const getItemKey = useCallback((index: number) => itemKeysRef.current[index] ?? index, []);
  const stableEstimateSize = useCallback((index: number) => estimateSizeRef.current(index), []);
  const getScrollElement = useCallback(() => scrollRef.current, [scrollRef]);

  // 展开的过程行必须常驻，否则滚动位置会跳。只有展开集合的内容真变了才换
  // rangeExtractor 身份，避免每次渲染都让 virtual-core 重算可见索引。
  const pinnedSignature = useMemo(
    () => (pinnedIndexes && pinnedIndexes.size > 0
      ? Array.from(pinnedIndexes).sort((left, right) => left - right).join(",")
      : ""),
    [pinnedIndexes],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const pinned = pinnedIndexesRef.current;
      if (!pinned || pinned.size === 0) return defaultRangeExtractor(range);
      return Array.from(new Set([
        ...defaultRangeExtractor(range),
        ...pinned,
      ])).sort((left, right) => left - right);
    },
    // pinnedSignature 只用于决定何时更换身份，实际数据从 ref 读取。
    [pinnedSignature],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getScrollElement,
    estimateSize: stableEstimateSize,
    getItemKey,
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

  // 条数变化由 virtual-core 自己增量处理；但「条数不变、首条换了」（切换会话、
  // 整体替换消息）不会：旧行高缓存按 key 已全部失效，显式重算一次避免行高错位。
  const firstKey = itemKeys[0];
  const previousFirstKeyRef = useRef(firstKey);
  useLayoutEffect(() => {
    if (previousFirstKeyRef.current === firstKey) return;
    previousFirstKeyRef.current = firstKey;
    virtualizer.measure();
  }, [firstKey, virtualizer]);

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
