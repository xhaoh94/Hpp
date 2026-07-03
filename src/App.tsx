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
import { FileSearch } from "./components/shared/FileSearch";
import { saveSessionModel, useDataPersistence } from "./hooks/useDataPersistence";
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useAppStore } from "./stores/app-store";
import { useChatStore, type ModelInfo } from "./stores/chat-store";
import { useProjectStore } from "./stores/project-store";
import TitleBar from "./components/layout/TitleBar";

const isSameModel = (left: ModelInfo | null | undefined, right: ModelInfo | null | undefined) =>
  !!left && !!right && left.id === right.id && left.provider === right.provider;

const ACTIVITY_BAR_WIDTH = 48;
const SIDEBAR_COLLAPSE_THRESHOLD = 160;
const SIDEBAR_MAX_WIDTH = 520;
const CHAT_MIN_WIDTH = 360;
const SIDEBAR_KEYBOARD_STEP = 16;
const SIDEBAR_KEYBOARD_LARGE_STEP = 48;

function matchShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split("+").map((s) => s.trim().toLowerCase());
  const key = event.key.toLowerCase();
  return (
    parts.includes("ctrl") === event.ctrlKey &&
    parts.includes("shift") === event.shiftKey &&
    parts.includes("alt") === event.altKey &&
    parts.includes("cmd") === event.metaKey &&
    !["ctrl", "shift", "alt", "cmd"].includes(key) &&
    parts.includes(key)
  );
}

export default function App() {
  useDataPersistence();
  const [showFileSearch, setShowFileSearch] = useState(false);
  const layoutContentRef = useRef<HTMLDivElement>(null);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarHoverExpanded, setSidebarHoverExpanded] = useState(false);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);

  // Load shortcuts from settings
  const [shortcuts, setShortcuts] = useState({
    sendKey: "Enter",
    fileSearch: "Ctrl+P",
    switchToFiles: "Ctrl+Shift+F",
    prevModel: "Ctrl+[",
    nextModel: "Ctrl+]",
  });

  useEffect(() => {
    window.electronAPI.loadData("settings").then((data: any) => {
      if (data?.shortcuts) {
        const { cycleModel, ...rest } = data.shortcuts;
        setShortcuts((prev) => ({ ...prev, ...rest }));
      }
    });
  }, []);

  const cycleModel = useCallback((direction: "prev" | "next") => {
    const { favoriteModels, availableModels, currentModel, setCurrentModel } = useChatStore.getState();
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
    setCurrentModel(nextModel);

    const sessionId = useProjectStore.getState().activeSessionId;
    if (sessionId) saveSessionModel(sessionId, nextModel);
    void window.electronAPI.agentSetModel(nextModel.provider, nextModel.id, sessionId || undefined).catch((error) => {
      console.error("[model] shortcut switch failed:", error);
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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

  const handleFileSelect = useCallback((filePath: string) => {
    // Switch to files tab and could highlight the file
    useAppStore.getState().setSidebarTab("files");
    useChatStore.getState().setHighlightedFile(filePath);
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

  const handleLayoutPointerEnter = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!useAppStore.getState().sidebarCollapsed) return;
    const rect = layoutContentRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (event.clientX - rect.left <= ACTIVITY_BAR_WIDTH) setSidebarHoverExpanded(true);
  }, []);

  const handleLayoutPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!useAppStore.getState().sidebarCollapsed) return;
    const rect = layoutContentRef.current?.getBoundingClientRect();
    if (!rect) return;

    const localX = event.clientX - rect.left;
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
  }, [sidebarHoverExpanded, sidebarWidth]);

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
  }, [applySidebarWidth, finishSidebarResize, sidebarCollapsed]);

  const handleSidebarResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? SIDEBAR_KEYBOARD_LARGE_STEP : SIDEBAR_KEYBOARD_STEP;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    applySidebarWidth(sidebarWidth + direction * step);
  }, [applySidebarWidth, sidebarWidth]);

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
    document.body.classList.remove("layout-sidebar-resizing");
  }, []);

  const hoverExpanded = sidebarCollapsed && sidebarHoverExpanded;

  return (
    <div className="layout">
      <TitleBar />
      <div
        ref={layoutContentRef}
        className={`layout-content ${sidebarCollapsed ? "collapsed" : ""} ${hoverExpanded ? "hover-expanded" : ""} ${sidebarResizing ? "resizing" : ""}`}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
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
        <ChatPanel sendKey={shortcuts.sendKey} />
      </div>
      <FileSearch
        isOpen={showFileSearch}
        onClose={() => setShowFileSearch(false)}
        onSelect={handleFileSelect}
      />
    </div>
  );
}
