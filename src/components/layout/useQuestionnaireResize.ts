import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

const QUESTIONNAIRE_RESIZE_MIN_HEIGHT = 180;
const QUESTIONNAIRE_RESIZE_MIN_MESSAGES_HEIGHT = 140;

type UseQuestionnaireResizeOptions = {
  panelRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  resetKey: string | null;
};

export function useQuestionnaireResize({
  panelRef,
  enabled,
  resetKey,
}: UseQuestionnaireResizeOptions) {
  const [questionnairePaneHeight, setQuestionnairePaneHeight] = useState<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setQuestionnairePaneHeight(null);
  }, [resetKey]);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const getPaneHeight = useCallback((clientY: number) => {
    const panel = panelRef.current;
    if (!panel) return null;

    const rect = panel.getBoundingClientRect();
    const header = panel.querySelector<HTMLElement>(".chat-header");
    const headerHeight = header?.offsetHeight ?? 36;
    const minHeight = Math.min(
      QUESTIONNAIRE_RESIZE_MIN_HEIGHT,
      Math.max(120, rect.height - headerHeight - 80)
    );
    const maxHeight = Math.max(
      minHeight,
      rect.height - headerHeight - QUESTIONNAIRE_RESIZE_MIN_MESSAGES_HEIGHT
    );
    const nextHeight = rect.bottom - clientY;

    return Math.min(Math.max(nextHeight, minHeight), maxHeight);
  }, [panelRef]);

  const handleQuestionnaireResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    event.preventDefault();
    cleanupRef.current?.();

    const applyHeight = (clientY: number) => {
      const nextHeight = getPaneHeight(clientY);
      if (nextHeight !== null) {
        setQuestionnairePaneHeight(nextHeight);
      }
    };

    const handleMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      applyHeight(moveEvent.clientY);
    };

    const stopResize = () => {
      document.body.classList.remove("chat-questionnaire-resizing");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      cleanupRef.current = null;
    };

    document.body.classList.add("chat-questionnaire-resizing");
    cleanupRef.current = stopResize;
    applyHeight(event.clientY);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [enabled, getPaneHeight]);

  return {
    questionnairePaneHeight,
    handleQuestionnaireResizeStart,
  };
}
