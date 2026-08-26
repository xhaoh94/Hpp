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
  const suppressAutoScrollUntilRef = useRef(0);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const getDistanceFromScrollBottom = useCallback((el: HTMLDivElement) => {
    return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
  }, []);

  const updateScrollBottomState = useCallback((el = scrollRef.current) => {
    if (!el) return false;
    const shouldShow = getDistanceFromScrollBottom(el) > SCROLL_BOTTOM_THRESHOLD;
    setShowScrollBottom(shouldShow);
    return shouldShow;
  }, [getDistanceFromScrollBottom]);

  const isBottomLocked = useCallback(() => (
    !!activeSessionId && bottomLockSessionRef.current === activeSessionId
  ), [activeSessionId]);

  const lockToActiveSessionBottom = useCallback(() => {
    bottomLockSessionRef.current = activeSessionId;
    autoFollowBottomRef.current = true;
  }, [activeSessionId]);

  const keepAtBottom = useCallback((el = scrollRef.current) => {
    if (!el) return;
    virtualizerRef?.current?.scrollToEnd("auto");
    el.scrollTop = el.scrollHeight;
    setShowScrollBottom(false);
  }, [virtualizerRef]);

  const shouldKeepAtBottom = useCallback(() => (
    isBottomLocked() || (
      autoFollowBottomRef.current &&
      Date.now() >= suppressAutoScrollUntilRef.current
    )
  ), [isBottomLocked]);

  const handleMessagesScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const awayFromBottom = updateScrollBottomState(el);
    if (isBottomLocked()) {
      autoFollowBottomRef.current = true;
      if (awayFromBottom) keepAtBottom(el);
      return;
    }
    autoFollowBottomRef.current = !awayFromBottom;
  }, [isBottomLocked, keepAtBottom, updateScrollBottomState]);

  // A freshly selected session remains bottom-locked while virtual rows replace
  // their estimated heights with measured ones. Only direct user scroll intent
  // releases the lock; layout-driven scroll events must not do that.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const releaseBottomLock = () => {
      if (bottomLockSessionRef.current === activeSessionId) {
        bottomLockSessionRef.current = null;
      }
    };
    el.addEventListener("pointerdown", releaseBottomLock, { passive: true });
    el.addEventListener("wheel", releaseBottomLock, { passive: true });
    el.addEventListener("keydown", releaseBottomLock);
    return () => {
      el.removeEventListener("pointerdown", releaseBottomLock);
      el.removeEventListener("wheel", releaseBottomLock);
      el.removeEventListener("keydown", releaseBottomLock);
    };
  }, [activeSessionId]);

  const handleContentChange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (shouldKeepAtBottom()) keepAtBottom(el);
    else updateScrollBottomState(el);
  }, [keepAtBottom, shouldKeepAtBottom, updateScrollBottomState]);

  useLayoutEffect(() => {
    bottomLockSessionRef.current = activeSessionId;
    autoFollowBottomRef.current = true;
    setShowScrollBottom(false);
    keepAtBottom();
  }, [activeSessionId, keepAtBottom]);

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
    lockToActiveSessionBottom();
    keepAtBottom(el);
    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current) return;
      keepAtBottom(current);
      updateScrollBottomState(current);
    });
  }, [keepAtBottom, lockToActiveSessionBottom, updateScrollBottomState]);

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
    bottomLockSessionRef.current = null;
    autoFollowBottomRef.current = false;
    suppressAutoScrollUntilRef.current = Date.now() + 1_200;
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
  }, [getMessageIndex, updateScrollBottomState, virtualizerRef]);

  const preserveScrollDuringLayoutChange = useCallback((action: () => void, anchor?: HTMLElement | null) => {
    const el = scrollRef.current;
    if (!el) {
      action();
      return;
    }

    const anchorTop = anchor?.getBoundingClientRect().top;
    const previousScrollTop = el.scrollTop;
    bottomLockSessionRef.current = null;
    autoFollowBottomRef.current = false;
    suppressAutoScrollUntilRef.current = Date.now() + 300;

    action();

    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current) return;
      if (anchor && typeof anchorTop === "number") {
        const nextTop = anchor.getBoundingClientRect().top;
        current.scrollTop += nextTop - anchorTop;
      } else {
        current.scrollTop = previousScrollTop;
      }
      const awayFromBottom = updateScrollBottomState(current);
      autoFollowBottomRef.current = !awayFromBottom;
    });
  }, [updateScrollBottomState]);

  const preserveScrollDuringAutoLayoutChange = useCallback((action: () => void) => {
    const el = scrollRef.current;
    if (!el) {
      action();
      return;
    }

    if (autoFollowBottomRef.current) {
      action();
      requestAnimationFrame(() => {
        const current = scrollRef.current;
        if (!current) return;
        current.scrollTop = current.scrollHeight;
        updateScrollBottomState(current);
      });
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
          };
          break;
        }
      }
    }

    const anchorTop = anchor?.getBoundingClientRect().top;
    const previousScrollTop = el.scrollTop;
    bottomLockSessionRef.current = null;
    autoFollowBottomRef.current = false;
    suppressAutoScrollUntilRef.current = Date.now() + 300;
    action();

    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current) return;
      const transitionedMessage = responseAnchor
        ? Array.from(current.querySelectorAll<HTMLElement>("[data-msg-id]"))
          .find((element) => element.dataset.msgId === responseAnchor.messageId)
        : null;
      const transitionedBody = transitionedMessage?.querySelector<HTMLElement>(".chat-bubble-content");
      if (responseAnchor && transitionedBody) {
        const targetY = transitionedBody.getBoundingClientRect().top + responseAnchor.contentOffset;
        current.scrollTop += targetY - responseAnchor.viewportY;
      } else if (anchor?.isConnected && typeof anchorTop === "number") {
        current.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
      } else {
        current.scrollTop = previousScrollTop;
      }
      updateScrollBottomState(current);
      autoFollowBottomRef.current = false;
    });
  }, [updateScrollBottomState]);

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
