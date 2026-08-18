import { useCallback, useEffect, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import { FileCode, FolderOpen, Pin, PinOff, Search, X } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useEditorStore, type EditorTab } from "@/stores/editor-store";
import { showAppConfirm } from "@/lib/app-dialog";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import { uiText } from "@/i18n/text";
import { EditorPane } from "./EditorPane";
import type { TmStatus } from "./tm-highlight";
import "./EditorArea.css";

interface TabMenuState {
  x: number;
  y: number;
  key: string;
}

interface ConfirmCloseState {
  key: string;
}

function EditorTabItem({
  tab,
  active,
  onSelect,
  onClose,
  onContextMenu,
}: {
  tab: EditorTab;
  active: boolean;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onContextMenu: (tab: EditorTab, event: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`editor-tab${active ? " active" : ""}`}
      data-tab-key={tab.key}
      onClick={() => onSelect(tab.key)}
      onAuxClick={(event) => {
        if (event.button === 1) onClose(tab.key);
      }}
      onContextMenu={(event) => onContextMenu(tab, event)}
      title={tab.path}
    >
      <FileCode size={13} strokeWidth={1.8} className="editor-tab-icon" aria-hidden="true" />
      <span className="editor-tab-name">{tab.name}</span>
      {tab.dirty && <span className="editor-tab-dirty" aria-label="未保存" />}
      {tab.pinned && <Pin size={12} strokeWidth={2} className="editor-tab-pin" aria-hidden="true" />}
      <button
        type="button"
        className="editor-tab-close"
        onClick={(event) => {
          event.stopPropagation();
          onClose(tab.key);
        }}
        title={uiText.editor.closeTab}
        aria-label={`${uiText.editor.closeTab}: ${tab.name}`}
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}

export function EditorArea() {
  const tabs = useEditorStore((state) => state.tabs);
  const activeKey = useEditorStore((state) => state.activeKey);
  const closeTab = useEditorStore((state) => state.closeTab);
  const closeOthers = useEditorStore((state) => state.closeOthers);
  const closeAll = useEditorStore((state) => state.closeAll);
  const closeSaved = useEditorStore((state) => state.closeSaved);
  const setActiveTab = useEditorStore((state) => state.setActiveTab);
  const togglePin = useEditorStore((state) => state.togglePin);

  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
  const [confirmClose, setConfirmClose] = useState<ConfirmCloseState | null>(null);
  const [tmStatusMap, setTmStatusMap] = useState<Record<string, TmStatus>>({});
  const saveFnsRef = useRef(new Map<string, () => Promise<boolean>>());
  const tabsRef = useRef<HTMLDivElement>(null);

  const handleTmStatus = useCallback((key: string) => (status: TmStatus) => {
    setTmStatusMap((prev) => {
      if (prev[key] === status) return prev;
      return { ...prev, [key]: status };
    });
  }, []);

  const handleTabsWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const el = tabsRef.current;
    if (!el) return;
    const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (delta !== 0) {
      el.scrollLeft += delta;
      event.preventDefault();
    }
  }, []);

  const activeTab = tabs.find((tab) => tab.key === activeKey) || null;
  const pinnedTabs = tabs.filter((tab) => tab.pinned);
  const regularTabs = tabs.filter((tab) => !tab.pinned);

  const handleDirtyChange = useCallback((key: string) => (dirty: boolean) => {
    useEditorStore.getState().setDirty(key, dirty);
  }, []);

  const handleSaved = useCallback((path: string) => {
    showFloatingToastMessage(uiText.editor.saved(path.split(/[\\/]/).pop() || path));
  }, []);

  const handleSaveError = useCallback((_path: string, error: string) => {
    showFloatingToastMessage(`${uiText.editor.saveFailed}：${error}`);
  }, []);

  const registerSave = useCallback((path: string, fn: () => Promise<boolean>) => {
    saveFnsRef.current.set(path, fn);
    return () => {
      saveFnsRef.current.delete(path);
    };
  }, []);

  const requestClose = useCallback(
    (key: string) => {
      const tab = tabs.find((item) => item.key === key);
      if (!tab) return;
      if (tab.dirty) setConfirmClose({ key });
      else closeTab(key);
    },
    [closeTab, tabs],
  );

  const saveAndClose = useCallback(async () => {
    if (!confirmClose) return;
    const key = confirmClose.key;
    const saveFn = saveFnsRef.current.get(key);
    if (saveFn) {
      const saved = await saveFn();
      if (!saved) return;
    }
    closeTab(key);
    setConfirmClose(null);
  }, [closeTab, confirmClose]);

  const discardAndClose = useCallback(() => {
    if (!confirmClose) return;
    closeTab(confirmClose.key);
    setConfirmClose(null);
  }, [closeTab, confirmClose]);

  const openContextMenu = useCallback((tab: EditorTab, event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setTabMenu({ x: event.clientX, y: event.clientY, key: tab.key });
  }, []);

  const runBulkClose = useCallback(
    (kind: "others" | "all", anchorKey: string) => {
      const closeable =
        kind === "others"
          ? tabs.filter((tab) => tab.key !== anchorKey && !tab.pinned)
          : tabs.filter((tab) => !tab.pinned);
      const dirtyCount = closeable.filter((tab) => tab.dirty).length;
      const execute = () => {
        if (kind === "others") closeOthers(anchorKey);
        else closeAll();
      };
      if (dirtyCount > 0) {
        const message =
          kind === "others"
            ? uiText.editor.closeOthersConfirm(dirtyCount)
            : uiText.editor.closeAllConfirm(dirtyCount);
        void showAppConfirm(message, {
          title: uiText.editor.unsavedTitle,
          confirmLabel: uiText.editor.discardChanges,
          cancelLabel: uiText.editor.cancel,
        }).then((confirmed) => {
          if (confirmed) execute();
        });
      } else {
        execute();
      }
      setTabMenu(null);
    },
    [closeAll, closeOthers, tabs],
  );

  const handleRevealInSidebar = useCallback((path: string) => {
    useAppStore.getState().revealFile(path, { preview: false });
    setTabMenu(null);
  }, []);

  const handleOpenInSystemExplorer = useCallback(async (path: string) => {
    try {
      await window.electronAPI.showItemInFolder(path);
    } catch (error) {
      showFloatingToastMessage(`${uiText.editor.openInSystemExplorer}失败：${error instanceof Error ? error.message : String(error)}`);
    }
    setTabMenu(null);
  }, []);

  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
    };
  }, [tabMenu]);

  // When the active tab changes, scroll it into the visible part of the tab bar.
  useEffect(() => {
    if (!activeKey) return;
    const el =
      tabsRef.current?.querySelector<HTMLElement>(
        `[data-tab-key="${CSS.escape(activeKey)}"]`,
      ) ?? null;
    if (!el || !tabsRef.current) return;
    const container = tabsRef.current;
    // Use getBoundingClientRect for viewport-relative positions —
    // offsetLeft can be wrong when offsetParent is not the scroll container.
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const tabLeft = elRect.left - containerRect.left; // position within visible viewport
    const tabRight = tabLeft + elRect.width;
    if (tabLeft < 0) {
      // Tab is off-screen to the left — bring it to the left edge.
      container.scrollLeft += tabLeft;
    } else if (tabRight > container.clientWidth) {
      // Tab is off-screen to the right — bring it to the right edge.
      container.scrollLeft += tabRight - container.clientWidth;
    }
  }, [activeKey, tabs.length]);

  const menuTab = tabMenu ? tabs.find((tab) => tab.key === tabMenu.key) || null : null;

  return (
    <div className="editor-area">
      <div
        ref={tabsRef}
        className="editor-tabs"
        role="tablist"
        aria-label="打开的编辑器标签"
        onWheel={handleTabsWheel}
      >
        {tabs.length === 0 && (
          <div className="editor-tabs-empty">
            <span>{uiText.editor.emptyTitle}</span>
          </div>
        )}
        {pinnedTabs.map((tab) => (
          <EditorTabItem
            key={tab.key}
            tab={tab}
            active={tab.key === activeKey}
            onSelect={setActiveTab}
            onClose={requestClose}
            onContextMenu={openContextMenu}
          />
        ))}
        {regularTabs.map((tab) => (
          <EditorTabItem
            key={tab.key}
            tab={tab}
            active={tab.key === activeKey}
            onSelect={setActiveTab}
            onClose={requestClose}
            onContextMenu={openContextMenu}
          />
        ))}
      </div>

      <div className="editor-panes">
        {tabs.map((tab) => (
          <EditorPane
            key={tab.key}
            path={tab.path}
            visible={tab.key === activeKey}
            onDirtyChange={handleDirtyChange(tab.key)}
            onSaved={handleSaved}
            onSaveError={handleSaveError}
            registerSave={registerSave}
            onTmStatus={handleTmStatus(tab.key)}
          />
        ))}
        {tabs.length === 0 && (
          <div className="editor-empty">
            <div className="editor-empty-icon" aria-hidden="true">
              <FileCode size={40} strokeWidth={1.2} />
            </div>
            <div className="editor-empty-title">{uiText.editor.emptyTitle}</div>
            <div className="editor-empty-desc">{uiText.editor.emptyDesc}</div>
          </div>
        )}
      </div>

      {activeTab && (
        <div className="editor-statusbar">
          <span className="editor-status-path" title={activeTab.path}>
            {activeTab.path}
          </span>
          <span className="editor-status-spacer" />
          {activeTab && <TmStatusBadge status={tmStatusMap[activeTab.key]} />}
          <span>UTF-8</span>
          <span>LF</span>
        </div>
      )}

      {tabMenu && menuTab && (
        <div
          className="editor-tab-menu"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => { togglePin(tabMenu.key); setTabMenu(null); }}>
            {menuTab.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {menuTab.pinned ? uiText.editor.unpin : uiText.editor.pin}
          </button>
          <button type="button" onClick={() => { requestClose(tabMenu.key); setTabMenu(null); }}>
            <X size={14} />
            {uiText.editor.close}
          </button>
          <div className="editor-tab-menu-sep" />
          <button type="button" onClick={() => handleRevealInSidebar(menuTab.path)}>
            <Search size={14} />
            {uiText.editor.revealInSidebar}
          </button>
          <button type="button" onClick={() => void handleOpenInSystemExplorer(menuTab.path)}>
            <FolderOpen size={14} />
            {uiText.editor.openInSystemExplorer}
          </button>
          <div className="editor-tab-menu-sep" />
          <button type="button" onClick={() => runBulkClose("others", tabMenu.key)}>
            {uiText.editor.closeOthers}
          </button>
          <button type="button" onClick={() => { closeSaved(); setTabMenu(null); }}>
            {uiText.editor.closeSaved}
          </button>
          <button type="button" onClick={() => runBulkClose("all", tabMenu.key)}>
            {uiText.editor.closeAll}
          </button>
        </div>
      )}

      {confirmClose && (
        <div className="editor-confirm-overlay" onClick={() => setConfirmClose(null)}>
          <div
            className="editor-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label={uiText.editor.unsavedTitle}
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="editor-confirm-title">{uiText.editor.unsavedTitle}</h3>
            <p className="editor-confirm-message">{uiText.editor.unsavedMessage}</p>
            <div className="editor-confirm-actions">
              <button type="button" className="editor-confirm-btn" onClick={discardAndClose}>
                {uiText.editor.discardChanges}
              </button>
              <button type="button" className="editor-confirm-btn" onClick={() => setConfirmClose(null)}>
                {uiText.editor.cancel}
              </button>
              <button
                type="button"
                className="editor-confirm-btn primary"
                onClick={() => void saveAndClose()}
              >
                {uiText.editor.saveAndClose}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TmStatusBadge({ status }: { status: TmStatus | undefined }) {
  // 永远渲染：undefined/idle 也显示灰色“等待中”，便于确认代码是否生效。
  const kind: TmStatus["kind"] = status?.kind ?? "idle";
  const map: Record<TmStatus["kind"], { text: string; className: string; title?: string }> = {
    on: { text: "TextMate ✓", className: "tm-badge tm-badge-on", title: "TextMate 语法高亮已启用" },
    off: {
      text: "TextMate ✗",
      className: "tm-badge tm-badge-off",
      title: status?.kind === "off" ? status.reason : "TextMate 未启用",
    },
    error: {
      text: "TextMate ✗",
      className: "tm-badge tm-badge-error",
      title: status?.kind === "error" ? status.reason : "TextMate 引擎错误",
    },
    idle: {
      text: "TextMate –",
      className: "tm-badge tm-badge-off",
      title: "等待 TextMate 引擎初始化；若打开 .cs/.lua 后仍显示此状态，请按 Ctrl+R 强制刷新或重启 dev",
    },
  };
  const item = map[kind];
  return (
    <span className={item.className} title={item.title}>
      {item.text}
    </span>
  );
}
