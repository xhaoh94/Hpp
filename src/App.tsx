import { useState, useEffect, useCallback } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { ContentArea } from "./components/layout/ContentArea";
import { ChatPanel } from "./components/layout/ChatPanel";
import { FileSearch } from "./components/shared/FileSearch";
import { saveSessionModel, useDataPersistence } from "./hooks/useDataPersistence";
import { useAppStore } from "./stores/app-store";
import { useChatStore, type ModelInfo } from "./stores/chat-store";
import { useProjectStore } from "./stores/project-store";
import TitleBar from "./components/layout/TitleBar";

const isSameModel = (left: ModelInfo | null | undefined, right: ModelInfo | null | undefined) =>
  !!left && !!right && left.id === right.id && left.provider === right.provider;

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
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);

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

  return (
    <div className="layout">
      <TitleBar />
      <div className={`layout-content ${sidebarCollapsed ? "collapsed" : ""}`}>
        <Sidebar />
        <ContentArea />
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
