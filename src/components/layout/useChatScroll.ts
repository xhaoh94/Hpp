import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEvent as ReactUIEvent,
} from "react";

const SCROLL_BOTTOM_THRESHOLD = 50;

export function useChatScroll({
  activeSessionId,
  activeSessionInitialized,
  questionnairePaneHeight,
}: {
  activeSessionId: string | null;
  activeSessionInitialized: boolean;
  questionnairePaneHeight: number | null;
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
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current) return;
      current.scrollTop = current.scrollHeight;
      updateScrollBottomState(current);
    });
  }, [updateScrollBottomState]);

  const scrollToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    autoFollowBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    updateScrollBottomState(el);
  }, [updateScrollBottomState]);

  const scrollToMessage = useCallback((msgId: string) => {
    const el = scrollRef.current;
    if (!el) return;
    const msgEl = el.querySelector(`[data-msg-id="${msgId}"]`);
    if (msgEl) {
      msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
      const htmlEl = msgEl as HTMLElement;
      htmlEl.classList.add("chat-msg-highlight");
      setTimeout(() => {
        htmlEl.classList.remove("chat-msg-highlight");
      }, 1500);
    }
  }, []);

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
