import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { ContentArea } from "./components/layout/ContentArea";
import { ChatPanel } from "./components/layout/ChatPanel";
import { EditorArea } from "./components/editor/EditorArea";
import { FileSearch, type FileSearchSelection } from "./components/shared/FileSearch";
import { useDataPersistence } from "./hooks/useDataPersistence";
import { useEditorPersistence } from "./hooks/useEditorPersistence";
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useAppStore } from "./stores/app-store";
import { useEditorStore } from "./stores/editor-store";
import { useAgentCatalogStore } from "./stores/agent-catalog-store";
import { useChatStore } from "./stores/chat-store";
import { useProjectStore } from "./stores/project-store";
import {
  getFloatingToastText,
  getModelSwitchToastText,
  HPP_FLOATING_TOAST_EVENT,
  showFloatingToastMessage,
} from "./lib/floating-toast";
import TitleBar from "./components/layout/TitleBar";
import { AppDialogHost } from "./components/shared/AppDialogHost";
import { CheckCircle2 } from "lucide-react";
import { isSameModel } from "@shared/models";
import { SessionCommandCoordinator } from "./lib/session-command-coordinator";
import {
  DEFAULT_SHORTCUTS,
  matchShortcut,
  normalizeShortcuts,
  SHORTCUTS_UPDATED_EVENT,
  type ShortcutConfig,
} from "./lib/shortcuts";

const ACTIVITY_BAR_WIDTH = 48;
const SIDEBAR_COLLAPSE_THRESHOLD = 160;
const SIDEBAR_MAX_WIDTH = 520;
const CHAT_MIN_WIDTH = 360;
const DEFAULT_CHAT_WIDTH = 420;
/** 编辑器模式下聊天区可拖动的最小宽度。 */
const CHAT_RESIZE_MIN_WIDTH = 300;
/** 编辑器列宽低于此值时自动切回预览模式。 */
const EDITOR_MIN_WIDTH = 240;
const SIDEBAR_KEYBOARD_STEP = 16;
const SIDEBAR_KEYBOARD_LARGE_STEP = 48;
const CHAT_RESIZE_KEYBOARD_STEP = 16;
const CHAT_RESIZE_KEYBOARD_LARGE_STEP = 48;

export default function App() {
  useDataPersistence();
  useEditorPersistence();
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [floatingToast, setFloatingToast] = useState<{ id: number; text: string } | null>(null);
  const layoutContentRef = useRef<HTMLDivElement>(null);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  const chatResizeCleanupRef = useRef<(() => void) | null>(null);
  const floatingToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarHoverExpanded, setSidebarHoverExpanded] = useState(false);
  const [chatResizing, setChatResizing] = useState(false);
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const editorMode = useEditorStore((s) => s.mode);

  // Load shortcuts from settings
  const [shortcuts, setShortcuts] = useState(DEFAULT_SHORTCUTS);

  useEffect(() => {
    void useAgentCatalogStore.getState().loadAgents();
  }, []);

  useEffect(() => {
    window.electronAPI.loadData("settings").then((data) => {
      const settings = data && typeof data === "object" && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {};
      setShortcuts(normalizeShortcuts(settings.shortcuts));
    });
    const handleShortcutsUpdated = (event: Event) => {
      setShortcuts(normalizeShortcuts((event as CustomEvent<ShortcutConfig>).detail));
    };
    window.addEventListener(SHORTCUTS_UPDATED_EVENT, handleShortcutsUpdated);
    return () => window.removeEventListener(SHORTCUTS_UPDATED_EVENT, handleShortcutsUpdated);
  }, []);

  const showFloatingToast = useCallback((text: string) => {
    if (floatingToastTimerRef.current) {
      clearTimeout(floatingToastTimerRef.current);
      floatingToastTimerRef.current = null;
    }
    setFloatingToast({ id: Date.now(), text });
    floatingToastTimerRef.current = setTimeout(() => {
      setFloatingToast(null);
      floatingToastTimerRef.current = null;
    }, 2600);
  }, []);

  useEffect(() => {
    const handleFloatingToast = (event: Event) => {
      const text = getFloatingToastText(event);
      if (text) showFloatingToast(text);
    };

    window.addEventListener(HPP_FLOATING_TOAST_EVENT, handleFloatingToast);
    return () => window.removeEventListener(HPP_FLOATING_TOAST_EVENT, handleFloatingToast);
  }, [showFloatingToast]);

  const cycleModel = useCallback(async (direction: "prev" | "next") => {
    const { favoriteModels, availableModels, currentModel } = useChatStore.getState();
    const availableFavoriteModels = favoriteModels.filter((favorite) =>
      availableModels.some((model) => isSameModel(model, favorite))
    );
    if (availableFavoriteModels.length < 2) return;

    const idx = availableFavoriteModels.findIndex((model) => isSameModel(model, currentModel));
    let newIdx: number;
    if (direction === "next") {
      newIdx = idx < availableFavoriteModels.length - 1 ? idx + 1 : 0;
    } else {
      newIdx = idx > 0 ? idx - 1 : availableFavoriteModels.length - 1;
    }
    const nextModel = availableFavoriteModels[newIdx];

    const projectState = useProjectStore.getState();
    const sessionId = projectState.activeSessionId;
    if (!sessionId) return;
    const activeSession = projectState.projects.flatMap((project) => project.sessions)
      .find((session) => session.id === sessionId);
    try {
      await SessionCommandCoordinator.setModel(sessionId, nextModel, { models: availableModels });
      showFloatingToastMessage(getModelSwitchToastText(activeSession?.agentId || "agent", nextModel.provider, nextModel.name || nextModel.id));
    } catch (error) {
      console.error("[model] shortcut switch failed:", error);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      // File search (Ctrl+P)
      if (matchShortcut(e, shortcuts.fileSearch)) {
        e.preventDefault();
        setShowFileSearch((v) => !v);
        return;
      }
      // Switch to files (Ctrl+Shift+F)
      if (matchShortcut(e, shortcuts.switchToFiles)) {
        e.preventDefault();
        useAppStore.getState().setSidebarTab("files");
        return;
      }
      // Previous model (Ctrl+[)
      if (matchShortcut(e, shortcuts.prevModel)) {
        e.preventDefault();
        cycleModel("prev");
        return;
      }
      // Next model (Ctrl+])
      if (matchShortcut(e, shortcuts.nextModel)) {
        e.preventDefault();
        cycleModel("next");
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts, cycleModel]);

  const handleFileSelect = useCallback((selection: FileSearchSelection) => {
    if (selection.isDirectory) {
      useAppStore.getState().revealFile(selection.path, { preview: false });
      return;
    }
    if (useEditorStore.getState().mode) {
      useEditorStore.getState().openFile(selection.path);
    } else {
      useAppStore.getState().revealFile(selection.path, { preview: true });
    }
  }, []);

  const getSidebarMaxWidth = useCallback(() => {
    const layoutWidth = layoutContentRef.current?.getBoundingClientRect().width || window.innerWidth;
    const available = layoutWidth - ACTIVITY_BAR_WIDTH - CHAT_MIN_WIDTH;
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, available));
  }, []);

  const applySidebarWidth = useCallback((nextWidth: number) => {
    if (nextWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
      setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
      setSidebarCollapsed(true);
      return false;
    }

    const maxWidth = getSidebarMaxWidth();
    setSidebarCollapsed(false);
    setSidebarWidth(Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, nextWidth)));
    return true;
  }, [getSidebarMaxWidth, setSidebarCollapsed, setSidebarWidth]);

  const finishSidebarResize = useCallback(() => {
    document.body.classList.remove("layout-sidebar-resizing");
    setSidebarResizing(false);
  }, []);

  const isSidebarToggleTarget = useCallback((target: EventTarget | null) => (
    target instanceof Element && !!target.closest("[data-sidebar-toggle]")
  ), []);

  const handleLayoutPointerEnter = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!useAppStore.getState().sidebarCollapsed) return;
    if (isSidebarToggleTarget(event.target)) return;
    const rect = layoutContentRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (event.clientX - rect.left <= ACTIVITY_BAR_WIDTH) setSidebarHoverExpanded(true);
  }, [isSidebarToggleTarget]);

  const handleLayoutPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!useAppStore.getState().sidebarCollapsed) return;
    const rect = layoutContentRef.current?.getBoundingClientRect();
    if (!rect) return;

    const localX = event.clientX - rect.left;
    if (isSidebarToggleTarget(event.target)) {
      setSidebarHoverExpanded(false);
      return;
    }

    if (localX <= ACTIVITY_BAR_WIDTH) {
      setSidebarHoverExpanded(true);
      return;
    }

    if (
      sidebarHoverExpanded &&
      localX > ACTIVITY_BAR_WIDTH + sidebarWidth
    ) {
      setSidebarHoverExpanded(false);
    }
  }, [isSidebarToggleTarget, sidebarHoverExpanded, sidebarWidth]);

  const handleLayoutPointerLeave = useCallback(() => {
    setSidebarHoverExpanded(false);
  }, []);

  const handlePermanentSidebarExpand = useCallback(() => {
    setSidebarHoverExpanded(false);
    setSidebarCollapsed(false);
  }, [setSidebarCollapsed]);

  const handlePermanentSidebarCollapse = useCallback(() => {
    setSidebarHoverExpanded(false);
    setSidebarCollapsed(true);
  }, [setSidebarCollapsed]);

  const handleSidebarResizePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (sidebarCollapsed || event.button !== 0) return;
    event.preventDefault();
    const layoutRect = layoutContentRef.current?.getBoundingClientRect();
    if (!layoutRect) return;

    setSidebarResizing(true);
    document.body.classList.add("layout-sidebar-resizing");

    const cleanupPointerListeners = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("blur", handlePointerUp);
      sidebarResizeCleanupRef.current = null;
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = moveEvent.clientX - layoutRect.left - ACTIVITY_BAR_WIDTH;
      if (!applySidebarWidth(nextWidth)) {
        cleanupPointerListeners();
        finishSidebarResize();
      }
    };

    const handlePointerUp = () => {
      cleanupPointerListeners();
      finishSidebarResize();
    };

    sidebarResizeCleanupRef.current?.();
    sidebarResizeCleanupRef.current = cleanupPointerListeners;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    window.addEventListener("blur", handlePointerUp);
  }, [applySidebarWidth, finishSidebarResize, sidebarCollapsed]);

  const handleSidebarResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? SIDEBAR_KEYBOARD_LARGE_STEP : SIDEBAR_KEYBOARD_STEP;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    applySidebarWidth(sidebarWidth + direction * step);
  }, [applySidebarWidth, sidebarWidth]);

  // ---- Chat width (editor mode) ----
  const getChatMaxWidth = useCallback(() => {
    const layoutWidth = layoutContentRef.current?.getBoundingClientRect().width || window.innerWidth;
    return Math.max(CHAT_RESIZE_MIN_WIDTH, layoutWidth - ACTIVITY_BAR_WIDTH - sidebarWidth - EDITOR_MIN_WIDTH);
  }, [sidebarWidth]);

  const applyChatWidth = useCallback((nextWidth: number) => {
    const maxWidth = getChatMaxWidth();
    setChatWidth(Math.min(Math.max(CHAT_RESIZE_MIN_WIDTH, nextWidth), Math.max(CHAT_RESIZE_MIN_WIDTH, maxWidth)));
  }, [getChatMaxWidth]);

  const finishChatResize = useCallback(() => {
    document.body.classList.remove("layout-chat-resizing");
    setChatResizing(false);
  }, []);

  const handleChatResizePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const layoutRect = layoutContentRef.current?.getBoundingClientRect();
    if (!layoutRect) return;

    setChatResizing(true);
    document.body.classList.add("layout-chat-resizing");

    const cleanupPointerListeners = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("blur", handlePointerUp);
      chatResizeCleanupRef.current = null;
    };

    // 拖动时不做上限钳制：一旦编辑区窄于 EDITOR_MIN_WIDTH，由自动切换 effect 切回预览模式。
    const handlePointerMove = (moveEvent: PointerEvent) => {
      setChatWidth(Math.max(CHAT_RESIZE_MIN_WIDTH, layoutRect.right - moveEvent.clientX));
    };

    const handlePointerUp = () => {
      cleanupPointerListeners();
      finishChatResize();
    };

    chatResizeCleanupRef.current?.();
    chatResizeCleanupRef.current = cleanupPointerListeners;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    window.addEventListener("blur", handlePointerUp);
  }, [finishChatResize]);

  const handleChatResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? CHAT_RESIZE_KEYBOARD_LARGE_STEP : CHAT_RESIZE_KEYBOARD_STEP;
    const direction = event.key === "ArrowLeft" ? 1 : -1;
    applyChatWidth(chatWidth + direction * step);
  }, [applyChatWidth, chatWidth]);

  // 编辑器模式下编辑区过窄时自动切回预览模式，并重置聊天区宽度。
  useEffect(() => {
    if (!editorMode) return;
    const check = () => {
      const layoutWidth = layoutContentRef.current?.getBoundingClientRect().width || window.innerWidth;
      const editorWidth = layoutWidth - ACTIVITY_BAR_WIDTH - sidebarWidth - chatWidth;
      if (editorWidth < EDITOR_MIN_WIDTH) {
        useEditorStore.getState().setMode(false);
        setChatWidth(DEFAULT_CHAT_WIDTH);
        // 若正在拖动聊天区分隔条，立即终止拖动，避免 pointermove 继续覆盖已重置的宽度。
        chatResizeCleanupRef.current?.();
        finishChatResize();
      }
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [editorMode, sidebarWidth, chatWidth, finishChatResize]);

  useEffect(() => {
    if (!sidebarCollapsed) {
      const maxWidth = getSidebarMaxWidth();
      if (sidebarWidth > maxWidth) setSidebarWidth(maxWidth);
    }
  }, [getSidebarMaxWidth, setSidebarWidth, sidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    const handleResize = () => {
      if (useAppStore.getState().sidebarCollapsed) return;
      const maxWidth = getSidebarMaxWidth();
      const currentWidth = useAppStore.getState().sidebarWidth;
      if (currentWidth > maxWidth) setSidebarWidth(maxWidth);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [getSidebarMaxWidth, setSidebarWidth]);

  useEffect(() => () => {
    sidebarResizeCleanupRef.current?.();
    chatResizeCleanupRef.current?.();
    if (floatingToastTimerRef.current) clearTimeout(floatingToastTimerRef.current);
    document.body.classList.remove("layout-sidebar-resizing");
    document.body.classList.remove("layout-chat-resizing");
  }, []);

  const hoverExpanded = sidebarCollapsed && sidebarHoverExpanded;

  return (
    <div className="layout">
      <TitleBar />
      <div
        ref={layoutContentRef}
        className={`layout-content ${sidebarCollapsed ? "collapsed" : ""} ${hoverExpanded ? "hover-expanded" : ""} ${sidebarResizing ? "resizing" : ""} ${chatResizing ? "chat-resizing" : ""} ${editorMode ? "editor-mode" : ""}`}
        style={{ "--sidebar-width": `${sidebarWidth}px`, "--editor-chat-width": `${chatWidth}px` } as CSSProperties}
        onPointerEnter={handleLayoutPointerEnter}
        onPointerMove={handleLayoutPointerMove}
        onPointerLeave={handleLayoutPointerLeave}
      >
        <Sidebar
          onCollapse={handlePermanentSidebarCollapse}
          onExpand={handlePermanentSidebarExpand}
        />
        <ContentArea />
        <button
          type="button"
          className={`sidebar-resizer ${sidebarResizing ? "resizing" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={getSidebarMaxWidth()}
          aria-valuenow={sidebarWidth}
          tabIndex={sidebarCollapsed ? -1 : 0}
          onPointerDown={handleSidebarResizePointerDown}
          onKeyDown={handleSidebarResizeKeyDown}
        />
        <EditorArea />
        <button
          type="button"
          className={`chat-resizer ${chatResizing ? "resizing" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整聊天区宽度"
          aria-valuemin={CHAT_RESIZE_MIN_WIDTH}
          aria-valuemax={Math.max(CHAT_RESIZE_MIN_WIDTH, getChatMaxWidth())}
          aria-valuenow={chatWidth}
          tabIndex={editorMode ? 0 : -1}
          onPointerDown={handleChatResizePointerDown}
          onKeyDown={handleChatResizeKeyDown}
        />
        <ChatPanel
          sendKey={shortcuts.sendKey}
          previousMessageKey={shortcuts.previousMessage}
          nextMessageKey={shortcuts.nextMessage}
        />
      </div>
      <FileSearch
        isOpen={showFileSearch}
        onClose={() => setShowFileSearch(false)}
        onSelect={handleFileSelect}
      />
      {floatingToast && (
        <div
          key={floatingToast.id}
          className="app-floating-toast"
          role="status"
          aria-live="polite"
        >
          <CheckCircle2 size={17} strokeWidth={2.2} />
          <span>{floatingToast.text}</span>
        </div>
      )}
      <AppDialogHost />
    </div>
  );
}
