import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEvent as ReactUIEvent,
} from "react";
import type { ChatVirtualizerRef } from "./useChatVirtualizer";

const SCROLL_BOTTOM_THRESHOLD = 50;
const AUTO_FOLLOW_BOTTOM_EPSILON = 2;
const POINTER_SCROLL_INTENT_THRESHOLD = 2;
const USER_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function useChatScroll({
  activeSessionId,
  activeSessionInitialized,
  questionnairePaneHeight,
  virtualizerRef,
  getMessageIndex,
}: {
  activeSessionId: string | null;
  activeSessionInitialized: boolean;
  questionnairePaneHeight: number | null;
  virtualizerRef?: ChatVirtualizerRef;
  getMessageIndex?: (messageId: string) => number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoFollowBottomRef = useRef(true);
  const bottomLockSessionRef = useRef<string | null>(activeSessionId);
  const userScrollInProgressRef = useRef(false);
  const userScrollOperationRef = useRef(0);
  const scrollOperationRef = useRef(0);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const getDistanceFromScrollBottom = useCallback((el: HTMLDivElement) => {
    return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
  }, []);

  const updateScrollBottomState = useCallback((el = scrollRef.current) => {
    if (!el) return false;
    const awayFromBottom = getDistanceFromScrollBottom(el) > SCROLL_BOTTOM_THRESHOLD;
    setShowScrollBottom(awayFromBottom || !autoFollowBottomRef.current);
    return awayFromBottom;
  }, [getDistanceFromScrollBottom]);

  const beginScrollOperation = useCallback(() => {
    scrollOperationRef.current += 1;
    return scrollOperationRef.current;
  }, []);

  const isBottomLocked = useCallback(() => (
    !!activeSessionId && bottomLockSessionRef.current === activeSessionId
  ), [activeSessionId]);

  const lockToActiveSessionBottom = useCallback(() => {
    const operation = beginScrollOperation();
    userScrollInProgressRef.current = false;
    bottomLockSessionRef.current = activeSessionId;
    autoFollowBottomRef.current = true;
    return operation;
  }, [activeSessionId, beginScrollOperation]);

  const stopAutoFollow = useCallback(() => {
    const operation = beginScrollOperation();
    userScrollInProgressRef.current = false;
    bottomLockSessionRef.current = null;
    autoFollowBottomRef.current = false;
    return operation;
  }, [beginScrollOperation]);

  const startUserScroll = useCallback(() => {
    const operation = beginScrollOperation();
    userScrollInProgressRef.current = true;
    userScrollOperationRef.current = operation;
    bottomLockSessionRef.current = null;
    // Disable following before the browser applies wheel/touch/keyboard scrolling.
    // Otherwise a streaming ResizeObserver callback can pull the viewport back down
    // between the input event and the resulting scroll event.
    autoFollowBottomRef.current = false;
    setShowScrollBottom(true);
  }, [beginScrollOperation]);

  const keepAtBottom = useCallback((el = scrollRef.current) => {
    if (!el) return;
    virtualizerRef?.current?.scrollToEnd("auto");
    el.scrollTop = el.scrollHeight;
    setShowScrollBottom(false);
  }, [virtualizerRef]);

  const shouldKeepAtBottom = useCallback(() => (
    isBottomLocked() || autoFollowBottomRef.current
  ), [isBottomLocked]);

  const handleMessagesScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const awayFromBottom = updateScrollBottomState(el);
    if (isBottomLocked()) {
      autoFollowBottomRef.current = true;
      if (awayFromBottom) keepAtBottom(el);
    }
    // Do not infer user intent from `scroll` itself. Virtual row measurement,
    // process collapse and scroll-height clamping all emit the same event.
  }, [isBottomLocked, keepAtBottom, updateScrollBottomState]);

  // A selected session remains bottom-locked while virtual rows settle. Direct
  // user input takes ownership before the browser changes scrollTop; scrollend
  // is the only event allowed to re-enable following after a manual scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const isIsolatedScrollTarget = (target: EventTarget | null) => (
      target instanceof Element && !!target.closest(".chat-user-history-popup")
    );
    const releaseBottomLock = () => {
      if (bottomLockSessionRef.current === activeSessionId) {
        bottomLockSessionRef.current = null;
      }
    };
    const finishUserScroll = () => {
      if (!userScrollInProgressRef.current) return;
      userScrollInProgressRef.current = false;
      if (userScrollOperationRef.current !== scrollOperationRef.current) return;
      autoFollowBottomRef.current = getDistanceFromScrollBottom(el) <= AUTO_FOLLOW_BOTTOM_EPSILON;
      updateScrollBottomState(el);
    };
    const handleWheel = (event: WheelEvent) => {
      if (isIsolatedScrollTarget(event.target)) return;
      const awayFromBottom = getDistanceFromScrollBottom(el) > AUTO_FOLLOW_BOTTOM_EPSILON;
      if (event.deltaY < 0 || !autoFollowBottomRef.current || awayFromBottom) startUserScroll();
    };
    let pointerGesture: {
      id: number;
      startY: number;
      startScrollTop: number;
      claimed: boolean;
    } | null = null;
    const handlePointerDown = (event: PointerEvent) => {
      if (isIsolatedScrollTarget(event.target)) return;
      releaseBottomLock();
      const bounds = el.getBoundingClientRect();
      const scrollbarStart = bounds.left + el.clientLeft + el.clientWidth;
      const claimed = event.button === 1 || event.clientX >= scrollbarStart;
      pointerGesture = {
        id: event.pointerId,
        startY: event.clientY,
        startScrollTop: el.scrollTop,
        claimed,
      };
      if (claimed) startUserScroll();
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerGesture || pointerGesture.id !== event.pointerId || pointerGesture.claimed) return;
      if (Math.abs(event.clientY - pointerGesture.startY) < POINTER_SCROLL_INTENT_THRESHOLD) return;
      pointerGesture.claimed = true;
      startUserScroll();
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (!pointerGesture || pointerGesture.id !== event.pointerId) return;
      const gesture = pointerGesture;
      pointerGesture = null;
      if (
        gesture.claimed &&
        Math.abs(el.scrollTop - gesture.startScrollTop) <= AUTO_FOLLOW_BOTTOM_EPSILON
      ) finishUserScroll();
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (pointerGesture?.id === event.pointerId) pointerGesture = null;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isIsolatedScrollTarget(event.target) || !USER_SCROLL_KEYS.has(event.key)) return;
      const awayFromBottom = getDistanceFromScrollBottom(el) > AUTO_FOLLOW_BOTTOM_EPSILON;
      const movesAwayFromBottom = event.key === "ArrowUp" || event.key === "PageUp" ||
        event.key === "Home" || (event.key === " " && event.shiftKey);
      if (movesAwayFromBottom || !autoFollowBottomRef.current || awayFromBottom) startUserScroll();
    };

    el.addEventListener("pointerdown", handlePointerDown, { passive: true });
    el.addEventListener("pointermove", handlePointerMove, { passive: true });
    el.addEventListener("pointerup", handlePointerUp, { passive: true });
    el.addEventListener("pointercancel", handlePointerCancel, { passive: true });
    el.addEventListener("wheel", handleWheel, { passive: true });
    el.addEventListener("keydown", handleKeyDown);
    el.addEventListener("scrollend", finishUserScroll);
    return () => {
      el.removeEventListener("pointerdown", handlePointerDown);
      el.removeEventListener("pointermove", handlePointerMove);
      el.removeEventListener("pointerup", handlePointerUp);
      el.removeEventListener("pointercancel", handlePointerCancel);
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("keydown", handleKeyDown);
      el.removeEventListener("scrollend", finishUserScroll);
    };
  }, [activeSessionId, getDistanceFromScrollBottom, startUserScroll, updateScrollBottomState]);

  const handleContentChange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (shouldKeepAtBottom()) keepAtBottom(el);
    else updateScrollBottomState(el);
  }, [keepAtBottom, shouldKeepAtBottom, updateScrollBottomState]);

  useLayoutEffect(() => {
    lockToActiveSessionBottom();
    setShowScrollBottom(false);
    keepAtBottom();
  }, [activeSessionId, keepAtBottom, lockToActiveSessionBottom]);

  useLayoutEffect(() => {
    handleContentChange();
  }, [activeSessionInitialized, questionnairePaneHeight, handleContentChange]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = el?.lastElementChild;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const keepAtBottomAfterLayout = () => {
      frame = 0;
      const current = scrollRef.current;
      if (!current) return;
      if (shouldKeepAtBottom()) keepAtBottom(current);
      else updateScrollBottomState(current);
    };
    const scheduleKeepAtBottom = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(keepAtBottomAfterLayout);
    };
    const observer = new ResizeObserver(scheduleKeepAtBottom);
    observer.observe(el);
    observer.observe(content);
    scheduleKeepAtBottom();

    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [activeSessionId, activeSessionInitialized, keepAtBottom, shouldKeepAtBottom, updateScrollBottomState]);

  const enableAutoFollow = useCallback(() => {
    lockToActiveSessionBottom();
  }, [lockToActiveSessionBottom]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const operation = lockToActiveSessionBottom();
    keepAtBottom(el);
    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current || scrollOperationRef.current !== operation || !shouldKeepAtBottom()) return;
      keepAtBottom(current);
      updateScrollBottomState(current);
    });
  }, [keepAtBottom, lockToActiveSessionBottom, shouldKeepAtBottom, updateScrollBottomState]);

  const scrollToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    lockToActiveSessionBottom();
    keepAtBottom(el);
    updateScrollBottomState(el);
  }, [keepAtBottom, lockToActiveSessionBottom, updateScrollBottomState]);

  const scrollToMessage = useCallback((msgId: string) => {
    const el = scrollRef.current;
    if (!el) return;

    // data-msg-id 在整条回合容器上，而用户消息后面还可能跟着很高的处理过程。
    // 跳转整条回合并居中会把用户发言气泡顶到滚动区域外，所以优先定位用户气泡。
    const getMessageTarget = (root: HTMLDivElement) => {
      const message = root.querySelector<HTMLElement>(`[data-msg-id="${msgId}"]`);
      return message?.querySelector<HTMLElement>(".chat-bubble.user") || message;
    };
    const scrollTargetToTop = (root: HTMLDivElement, target: Element) => {
      const rootRect = root.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      // 让出顶部吸顶区：发言记录 rail(36) + 全局「返回上一条发言」按钮轨道(40)，
      // 避免跳转后的气泡顶部被常驻吸顶按钮遮挡。
      const topInset = 30;
      root.scrollTo({
        top: Math.max(0, root.scrollTop + targetRect.top - rootRect.top - topInset),
        behavior: "auto",
      });
    };

    const messageIndex = getMessageIndex?.(msgId) ?? -1;
    const initialTarget = getMessageTarget(el);
    if (!initialTarget && messageIndex < 0) return;

    // 手动跳转期间禁止底部跟随。目标行可能尚未挂载，虚拟列表会先按索引
    // 定位，之后再等待真实气泡出现并校正顶部位置。
    const operation = stopAutoFollow();
    if (messageIndex >= 0) {
      virtualizerRef?.current?.scrollToIndex(messageIndex, {
        align: "start",
        behavior: "auto",
      });
    }
    if (initialTarget) scrollTargetToTop(el, initialTarget);

    let attempts = 0;
    const settle = () => {
      requestAnimationFrame(() => {
        if (scrollOperationRef.current !== operation) return;
        const current = scrollRef.current;
        const currentMsg = current ? getMessageTarget(current) : null;
        if (!current) return;
        if (!currentMsg && attempts < 8) {
          attempts += 1;
          settle();
          return;
        }
        if (!currentMsg) return;
        scrollTargetToTop(current, currentMsg);
        currentMsg.classList.add("chat-msg-highlight");
        window.setTimeout(() => currentMsg.classList.remove("chat-msg-highlight"), 1_500);
        updateScrollBottomState(current);
        autoFollowBottomRef.current = false;
      });
    };
    settle();
  }, [getMessageIndex, stopAutoFollow, updateScrollBottomState, virtualizerRef]);

  const preserveScrollDuringLayoutChange = useCallback((action: () => void, anchor?: HTMLElement | null) => {
    const el = scrollRef.current;
    if (!el) {
      action();
      return;
    }

    const anchorTop = anchor?.getBoundingClientRect().top;
    const previousScrollTop = el.scrollTop;
    const operation = stopAutoFollow();

    action();

    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current || scrollOperationRef.current !== operation) return;
      if (anchor && typeof anchorTop === "number") {
        const nextTop = anchor.getBoundingClientRect().top;
        current.scrollTop += nextTop - anchorTop;
      } else {
        current.scrollTop = previousScrollTop;
      }
      autoFollowBottomRef.current = getDistanceFromScrollBottom(current) <= AUTO_FOLLOW_BOTTOM_EPSILON;
      updateScrollBottomState(current);
    });
  }, [getDistanceFromScrollBottom, stopAutoFollow, updateScrollBottomState]);

  const preserveScrollDuringAutoLayoutChange = useCallback((action: () => void) => {
    const el = scrollRef.current;
    if (!el) {
      action();
      return;
    }

    if (autoFollowBottomRef.current && !userScrollInProgressRef.current) {
      const operation = beginScrollOperation();
      const settleAtBottom = () => {
        const current = scrollRef.current;
        if (
          !current ||
          scrollOperationRef.current !== operation ||
          !shouldKeepAtBottom()
        ) return;
        keepAtBottom(current);
        updateScrollBottomState(current);
      };
      action();
      settleAtBottom();
      requestAnimationFrame(settleAtBottom);
      return;
    }

    const bounds = el.getBoundingClientRect();
    const sampleX = Math.min(bounds.right - 8, Math.max(bounds.left + 8, bounds.left + bounds.width / 2));
    const sampleOffsets = [24, bounds.height * 0.25, bounds.height * 0.5, bounds.height * 0.75, bounds.height - 24];
    let anchor: HTMLElement | null = null;
    let responseAnchor: {
      messageId: string;
      viewportY: number;
      contentOffset: number;
      processElement: HTMLElement;
    } | null = null;
    for (const offset of sampleOffsets) {
      const viewportY = Math.min(bounds.bottom - 8, bounds.top + offset);
      const candidate = document.elementFromPoint(sampleX, viewportY);
      if (candidate instanceof HTMLElement && el.contains(candidate)) {
        if (!anchor) anchor = candidate;
        const processOutput = candidate.closest<HTMLElement>(".chat-process-output");
        const messageWrapper = processOutput?.closest<HTMLElement>("[data-msg-id]");
        const messageId = messageWrapper?.dataset.msgId;
        if (processOutput && messageId) {
          responseAnchor = {
            messageId,
            viewportY,
            contentOffset: viewportY - processOutput.getBoundingClientRect().top,
            processElement: processOutput,
          };
          break;
        }
      }
    }

    const anchorTop = anchor?.getBoundingClientRect().top;
    const previousScrollTop = el.scrollTop;
    const userOwnsScroll = userScrollInProgressRef.current;
    const operation = userOwnsScroll ? scrollOperationRef.current : beginScrollOperation();
    bottomLockSessionRef.current = null;
    autoFollowBottomRef.current = false;

    const correctReadingAnchor = () => {
      const current = scrollRef.current;
      if (!current || scrollOperationRef.current !== operation) return;
      const transitionedMessage = responseAnchor
        ? Array.from(current.querySelectorAll<HTMLElement>("[data-msg-id]"))
          .find((element) => element.dataset.msgId === responseAnchor.messageId)
        : null;
      const transitionedBody = transitionedMessage?.querySelector<HTMLElement>(".chat-bubble-content");
      if (responseAnchor?.processElement.isConnected) {
        const targetY = responseAnchor.processElement.getBoundingClientRect().top + responseAnchor.contentOffset;
        current.scrollTop += targetY - responseAnchor.viewportY;
      } else if (responseAnchor && transitionedBody) {
        const targetY = transitionedBody.getBoundingClientRect().top + responseAnchor.contentOffset;
        current.scrollTop += targetY - responseAnchor.viewportY;
      } else if (anchor?.isConnected && typeof anchorTop === "number") {
        current.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
      } else {
        current.scrollTop = previousScrollTop;
      }
      updateScrollBottomState(current);
    };

    action();
    // The caller flushes the final-response commit, so this first correction
    // happens before paint. A non-interactive transition gets one measured-frame
    // verification; an active gesture keeps sole ownership after this point.
    correctReadingAnchor();
    if (!userOwnsScroll) requestAnimationFrame(correctReadingAnchor);
  }, [beginScrollOperation, keepAtBottom, shouldKeepAtBottom, updateScrollBottomState]);

  return {
    scrollRef,
    showScrollBottom,
    handleMessagesScroll,
    scrollToBottom,
    scrollToBottomNow,
    scrollToMessage,
    preserveScrollDuringLayoutChange,
    preserveScrollDuringAutoLayoutChange,
    enableAutoFollow,
    handleContentChange,
  };
}
