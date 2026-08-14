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

  const handleMessagesScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const awayFromBottom = updateScrollBottomState(event.currentTarget);
    autoFollowBottomRef.current = !awayFromBottom;
  }, [updateScrollBottomState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const awayFromBottom = updateScrollBottomState(el);
      autoFollowBottomRef.current = !awayFromBottom;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => el.removeEventListener("scroll", handleScroll);
  }, [updateScrollBottomState]);

  const handleContentChange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (autoFollowBottomRef.current && Date.now() >= suppressAutoScrollUntilRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    updateScrollBottomState(el);
    if (autoFollowBottomRef.current && getDistanceFromScrollBottom(el) < 100) {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => updateScrollBottomState(el));
    }
  }, [getDistanceFromScrollBottom, updateScrollBottomState]);

  useLayoutEffect(() => {
    handleContentChange();
  }, [activeSessionId, activeSessionInitialized, questionnairePaneHeight, handleContentChange]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (autoFollowBottomRef.current && Date.now() >= suppressAutoScrollUntilRef.current) {
        el.scrollTop = el.scrollHeight;
      }
      updateScrollBottomState(el);
    });
    observer.observe(el);
    const lastChild = el.lastElementChild;
    if (lastChild) observer.observe(lastChild);

    return () => {
      observer.disconnect();
    };
  }, [activeSessionId, activeSessionInitialized, updateScrollBottomState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    autoFollowBottomRef.current = true;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      updateScrollBottomState(el);
    });
  }, [activeSessionId, activeSessionInitialized, updateScrollBottomState]);

  const enableAutoFollow = useCallback(() => {
    autoFollowBottomRef.current = true;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    autoFollowBottomRef.current = true;
    setShowScrollBottom(false);
    virtualizerRef?.current?.scrollToEnd("auto");
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current) return;
      virtualizerRef?.current?.scrollToEnd("auto");
      current.scrollTop = current.scrollHeight;
      updateScrollBottomState(current);
    });
  }, [updateScrollBottomState, virtualizerRef]);

  const scrollToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    autoFollowBottomRef.current = true;
    virtualizerRef?.current?.scrollToEnd("auto");
    el.scrollTop = el.scrollHeight;
    updateScrollBottomState(el);
  }, [updateScrollBottomState, virtualizerRef]);

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
