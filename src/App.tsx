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
import { useAgentCatalogStore } from "./stores/agent-catalog-store";
import { useChatStore, type ModelInfo } from "./stores/chat-store";
import { useProjectStore } from "./stores/project-store";
import {
  getFloatingToastText,
  getModelSwitchToastText,
  HPP_FLOATING_TOAST_EVENT,
  showFloatingToastMessage,
} from "./lib/floating-toast";
import { requiresProviderActivation } from "./lib/agents";
import TitleBar from "./components/layout/TitleBar";

const isSameModel = (left: ModelInfo | null | undefined, right: ModelInfo | null | undefined) =>
  !!left && !!right && left.id === right.id && left.provider === right.provider;

const ACTIVITY_BAR_WIDTH = 48;
const SIDEBAR_COLLAPSE_THRESHOLD = 160;
const SIDEBAR_MAX_WIDTH = 520;
const CHAT_MIN_WIDTH = 360;
const SIDEBAR_KEYBOARD_STEP = 16;
const SIDEBAR_KEYBOARD_LARGE_STEP = 48;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getShortcutPatch(value: unknown): Partial<typeof DEFAULT_SHORTCUTS> {
  const shortcuts = asRecord(value);
  return Object.fromEntries(
    Object.entries(shortcuts).filter(([, shortcut]) => typeof shortcut === "string")
  ) as Partial<typeof DEFAULT_SHORTCUTS>;
}

const DEFAULT_SHORTCUTS = {
  sendKey: "Enter",
  fileSearch: "Ctrl+P",
  switchToFiles: "Ctrl+Shift+F",
  prevModel: "Ctrl+[",
  nextModel: "Ctrl+]",
};

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
  const [floatingToast, setFloatingToast] = useState<{ id: number; text: string } | null>(null);
  const layoutContentRef = useRef<HTMLDivElement>(null);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  const floatingToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarHoverExpanded, setSidebarHoverExpanded] = useState(false);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);

  // Load shortcuts from settings
  const [shortcuts, setShortcuts] = useState(DEFAULT_SHORTCUTS);

  useEffect(() => {
    void useAgentCatalogStore.getState().loadAgents();
  }, []);

  useEffect(() => {
    window.electronAPI.loadData("settings").then((data) => {
      const settings = asRecord(data);
      const savedShortcuts = asRecord(settings.shortcuts);
      if (Object.keys(savedShortcuts).length > 0) {
        const { cycleModel: _cycleModel, ...rest } = savedShortcuts;
        setShortcuts((prev) => ({ ...prev, ...getShortcutPatch(rest) }));
      }
    });
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
    }, 2200);
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
    const {
      activeAgentId,
      favoriteModels,
      availableModels,
      currentModel,
      setAvailableModels,
      setCurrentModel,
    } = useChatStore.getState();
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
    const activeProject = projectState.projects.find((project) => project.id === projectState.activeProjectId);
    const activeSession = activeProject?.sessions.find((session) => session.id === sessionId);
    const agentId = activeSession?.agentId || activeAgentId;
    const switchingProvider =
      requiresProviderActivation(agentId) &&
      !!currentModel &&
      currentModel.provider !== nextModel.provider;

    try {
      if (switchingProvider) {
        const currentSessionRunning = sessionId
          ? projectState.agentStatuses[sessionId] === "running"
          : useChatStore.getState().isStreaming;
        if (currentSessionRunning) {
          window.alert("切换 Agent 渠道需要等当前 Agent 运行结束后再操作。");
          return;
        }

        const activateResult = await window.electronAPI.agentConfigActivate(agentId, nextModel.provider);
        if (!activateResult.success) {
          window.alert(activateResult.error || "切换 Agent 渠道失败，请稍后重试。");
          return;
        }
        if (activateResult.models && activateResult.models.length > 0) {
          setAvailableModels(activateResult.models);
        }
      }

      const result = await window.electronAPI.agentSetModel(nextModel.provider, nextModel.id, sessionId || undefined);
      if (!result.success) {
        console.error("[model] shortcut switch failed:", result.error || "Unknown error");
        return;
      }

      setCurrentModel(nextModel);
      if (sessionId) saveSessionModel(sessionId, nextModel);
      showFloatingToastMessage(getModelSwitchToastText(agentId, nextModel.provider, nextModel.name || nextModel.id));
    } catch (error) {
      console.error("[model] shortcut switch failed:", error);
    }
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
    if (floatingToastTimerRef.current) clearTimeout(floatingToastTimerRef.current);
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
      {floatingToast && (
        <div
          key={floatingToast.id}
          className="app-floating-toast"
          role="status"
          aria-live="polite"
        >
          {floatingToast.text}
        </div>
      )}
    </div>
  );
}
