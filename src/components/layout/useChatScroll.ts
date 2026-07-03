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
  messages,
  activeSessionId,
  activeSessionInitialized,
  questionnairePaneHeight,
}: {
  messages: unknown[];
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

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (autoFollowBottomRef.current && Date.now() >= suppressAutoScrollUntilRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    updateScrollBottomState(el);
  }, [messages, activeSessionId, activeSessionInitialized, questionnairePaneHeight, updateScrollBottomState]);

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
    if (!el || !autoFollowBottomRef.current) return;
    if (getDistanceFromScrollBottom(el) < 100) {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => updateScrollBottomState(el));
    }
  }, [messages, getDistanceFromScrollBottom, updateScrollBottomState]);

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

  return {
    scrollRef,
    showScrollBottom,
    handleMessagesScroll,
    scrollToBottom,
    scrollToBottomNow,
    scrollToMessage,
    preserveScrollDuringLayoutChange,
    enableAutoFollow,
  };
}
