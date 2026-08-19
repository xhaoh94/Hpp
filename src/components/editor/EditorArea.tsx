import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import { FileCode, FileSearch, FolderOpen, Pin, PinOff, Search, X } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useEditorStore, type EditorTab } from "@/stores/editor-store";
import { useProjectStore } from "@/stores/project-store";
import { showAppConfirm } from "@/lib/app-dialog";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import { uiText } from "@/i18n/text";
import { getProjectFileIndex } from "@/lib/project-file-index";
import { applyPreserveCase, findTextMatches, isRegexValid } from "@/lib/file-preview-code";
import { searchFilesInWorker } from "./search-worker-client";
import { sharedSearchConfig, requestGotoMatch, requestReplaceMatch, type AllFileMatch } from "./searchConfig";
import { DEFAULT_FILE_FILTERS, type FileFilterConfig } from "@shared/file-filters";
import { EditorPane } from "./EditorPane";
import {
  ExpandSearchList,
  type ExpandSearchGroup,
  type ExpandSearchResult,
} from "./ExpandSearchList";
import type { TmStatus } from "./tm-highlight";
import "./EditorArea.css";

// 项目级“扩大搜索”使用的过滤：在默认排除项基础上，额外跳过构建产物与二进制文件，
// 避免读取体积过大或无关内容。
const PROJECT_SEARCH_FILTERS: FileFilterConfig = {
  excludeFolders: [
    ...DEFAULT_FILE_FILTERS.excludeFolders,
    "build",
    "out",
    "release",
    ".vite",
    "coverage",
    "target",
    "bin",
    "obj",
    ".cache",
    "vendor",
    ".idea",
    ".vs",
  ],
  excludeExtensions: [
    ...DEFAULT_FILE_FILTERS.excludeExtensions,
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".svg",
    ".webp",
    ".wav",
    ".mp3",
    ".mp4",
    ".webm",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".zip",
    ".gz",
    ".tar",
    ".rar",
    ".7z",
    ".pdf",
    ".lock",
    ".map",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
  ],
  excludeFiles: [],
};

const MAX_RESULTS = 5000;
const MAX_FILE_READ_BYTES = 2_000_000;

function dirFromPath(filePath: string): string {
  if (!filePath) return "";
  const normalized = filePath.replace(/[\\/]+$/, "");
  const idx = normalized.lastIndexOf("\\");
  const idx2 = normalized.lastIndexOf("/");
  const cut = Math.max(idx, idx2);
  return cut <= 0 ? "" : normalized.slice(0, cut);
}

function getRelativePath(projectPath: string, filePath: string): string {
  const normalizedProject = projectPath.replace(/[\\/]+$/, "");
  if (filePath.toLowerCase().startsWith(normalizedProject.toLowerCase())) {
    return filePath.slice(normalizedProject.length).replace(/^[\\/]+/, "") || filePath;
  }
  return filePath;
}

// 遍历项目根目录检索：文件读取走异步 IPC（不阻塞），CPU 密集的正则匹配
// 交给 Web Worker 后台线程执行；Worker 不可用时回退主线程，保证功能可用。
async function runProjectSearch(
  root: string,
  query: string,
  options: { matchCase: boolean; wholeWord: boolean; regex: boolean },
): Promise<ExpandSearchResult[]> {
  const index = await getProjectFileIndex(root, PROJECT_SEARCH_FILTERS);
  const files = index.filter((item) => !item.isDirectory).map((item) => item.path);
  const results: ExpandSearchResult[] = [];
  const concurrency = 32;
  for (let offset = 0; offset < files.length && results.length < MAX_RESULTS; offset += concurrency) {
    const batch = files.slice(offset, offset + concurrency);
    // 批量读取（异步 IPC，不阻塞主线程），只保留有效文本内容。
    const readFiles = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const res = await window.electronAPI.readFile(filePath);
          if (!res.success || res.binary || res.content == null) return null;
          if (res.content.length > MAX_FILE_READ_BYTES) return null;
          const relPath = getRelativePath(root, filePath);
          return {
            path: filePath,
            name: filePath.split(/[\\/]/).pop() || filePath,
            relPath,
            dirPath: dirFromPath(relPath),
            content: res.content,
          };
        } catch {
          return null;
        }
      }),
    );
    const validFiles = readFiles.filter((file): file is NonNullable<typeof file> => file !== null);
    if (validFiles.length === 0) continue;
    // 正则匹配在 Worker 后台线程执行，主线程保持响应。
    try {
      const batchResults = await searchFilesInWorker(validFiles, query, options);
      for (const item of batchResults) {
        results.push(item);
        if (results.length >= MAX_RESULTS) break;
      }
    } catch {
      // Worker 不可用（如构建异常）：回退主线程逐文件匹配，保证功能可用。
      for (const file of validFiles) {
        if (results.length >= MAX_RESULTS) break;
        const lines = file.content.split("\n");
        const matches = findTextMatches(lines, query, options);
        for (const match of matches.slice(0, 200)) {
          results.push({
            path: file.path,
            name: file.name,
            relPath: file.relPath,
            dirPath: file.dirPath,
            lineNumber: match.lineNumber,
            preview: lines[match.lineNumber - 1] ?? "",
            matchStart: match.startColumn,
            matchEnd: match.endColumn,
          });
        }
      }
    }
  }
  return results;
}

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

  const projects = useProjectStore((state) => state.projects);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;

  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
  const [confirmClose, setConfirmClose] = useState<ConfirmCloseState | null>(null);
  const [tmStatusMap, setTmStatusMap] = useState<Record<string, TmStatus>>({});
  const [expandSearch, setExpandSearch] = useState<{
    open: boolean;
    query: string;
    results: ExpandSearchResult[];
    loading: boolean;
    error: string | null;
    /** 手动关闭面板时的搜索词；用于判断“关窗后重新搜索的是否为新内容”，新内容才自动重开面板。 */
    dismissedQuery: string;
  }>({ open: false, query: "", results: [], loading: false, error: null, dismissedQuery: "" });
  // “所有文件”结果面板是否展示替换能力（与查找栏“展开替换”同步）：
  // 来自 EditorPane 的 onReplaceStateChange 回调，用于显示悬停替换按钮与替换预览。
  const [replacePanelOpen, setReplacePanelOpen] = useState(false);
  const [replacePanelQuery, setReplacePanelQuery] = useState("");
  const [replacePanelPreserveCase, setReplacePanelPreserveCase] = useState(false);
  const saveFnsRef = useRef(new Map<string, () => Promise<boolean>>());
  const tabsRef = useRef<HTMLDivElement>(null);
  const expandSearchPanelRef = useRef<HTMLDivElement>(null);
  // 结果面板顶部偏移：跟随搜索栏实际高度（展开替换时栏更高），避免遮挡或留空。
  const [panelTop, setPanelTop] = useState<number | null>(null);

  // 把扩大搜索结果按文件路径分组，保持各匹配的行号顺序；用于 VSCode 风格分组渲染。
  const expandSearchGroups = useMemo(() => {
    const groups: ExpandSearchGroup[] = [];
    const indexByPath = new Map<string, number>();
    for (const result of expandSearch.results) {
      const existing = indexByPath.get(result.path);
      if (existing === undefined) {
        indexByPath.set(result.path, groups.length);
        groups.push({
          path: result.path,
          name: result.name,
          relPath: result.relPath,
          dirPath: result.dirPath,
          matches: [result],
        });
      } else {
        groups[existing].matches.push(result);
      }
    }
    return groups;
  }, [expandSearch.results]);

  // 跨文件匹配结构：供编辑区导航使用。memo 化，避免每个 tab 实例在每次渲染时重复 map 几千条结果。
  const allFileMatches = useMemo<AllFileMatch[]>(
    () =>
      expandSearch.results.map((result) => ({
        path: result.path,
        lineNumber: result.lineNumber,
        startColumn: result.matchStart,
        endColumn: result.matchEnd,
      })),
    [expandSearch.results],
  );

  // “所有文件”搜索范围：以同一关键词遍历整个项目目录检索。
  // openPanel=true 时（下拉框显式选择 / 重新打开按钮）若命中则弹出结果面板；
  // openPanel=false 时（关键词/选项变化重试）按以下规则决定面板可见性：
  //   - 无匹配：始终不显示面板（含“未找到”空态）。
  //   - 有匹配：面板已开则保持；已关但本次为“新内容”（与关窗时搜索词不同）则重新打开；否则保持关闭。
  const runAllFilesSearch = useCallback((openPanel: boolean) => {
    const query = sharedSearchConfig.searchQuery.trim();
    if (!query) {
      // 关键词为空：清空结果，不提示（输入过程中会反复触发）。
      setExpandSearch((state) => ({ ...state, results: [], loading: false, error: null, open: false, dismissedQuery: "" }));
      return;
    }
    if (sharedSearchConfig.searchRegex && !isRegexValid(query, sharedSearchConfig.searchMatchCase)) {
      showFloatingToastMessage("正则表达式无效，无法扩大搜索");
      return;
    }
    const root = activeProject?.path ?? dirFromPath(activeKey ?? "");
    if (!root) {
      showFloatingToastMessage("无法确定项目目录，无法扩大搜索");
      return;
    }
    // 同步更新参数键：使其他 pane 的 debounce effect 能识别"已搜过相同参数"并跳过重复搜索。
    sharedSearchConfig.lastAllFilesSearchKey = JSON.stringify({
      query,
      matchCase: sharedSearchConfig.searchMatchCase,
      wholeWord: sharedSearchConfig.searchWholeWord,
      regex: sharedSearchConfig.searchRegex,
    });
    setExpandSearch((state) => ({ ...state, loading: true, error: null, query }));
    void runProjectSearch(root, query, {
      matchCase: sharedSearchConfig.searchMatchCase,
      wholeWord: sharedSearchConfig.searchWholeWord,
      regex: sharedSearchConfig.searchRegex,
    })
      .then((results) => {
        if (results.length === 0) {
          // 无匹配：始终不显示面板（也不弹“未找到”空态）；显式搜索才提示 toast。
          setExpandSearch((state) => ({
            ...state,
            results: [],
            loading: false,
            error: null,
            open: false,
            dismissedQuery: openPanel ? "" : state.dismissedQuery,
          }));
          if (openPanel) showFloatingToastMessage(`未找到匹配项：${query}`);
        } else {
          setExpandSearch((state) => {
            const shouldOpen = openPanel
              ? true
              : state.open
                ? true
                : query !== state.dismissedQuery;
            return {
              ...state,
              results,
              loading: false,
              error: null,
              open: shouldOpen,
              dismissedQuery: shouldOpen ? "" : state.dismissedQuery,
            };
          });
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setExpandSearch((state) => ({
          ...state,
          results: [],
          loading: false,
          error: message,
          open: openPanel ? false : state.open,
          dismissedQuery: openPanel ? "" : state.dismissedQuery,
        }));
        if (openPanel) showFloatingToastMessage(`搜索失败：${message}`);
      });
  }, [activeProject?.path, activeKey]);

  // 文件未打开时，“所有文件”结果面板的单处替换走磁盘读写回退。
  const replaceMatchOnDisk = useCallback(
    async (
      filePath: string,
      lineNumber: number,
      matchStart: number,
      matchEnd: number,
      replacement: string,
      query: string,
      matchCase: boolean,
      wholeWord: boolean,
      regex: boolean,
    ) => {
      const res = await window.electronAPI.readFile(filePath);
      if (!res.success || res.content == null) {
        showFloatingToastMessage(`无法读取文件：${filePath}`);
        return;
      }
      const lines = res.content.split("\n");
      if (lineNumber < 1 || lineNumber > lines.length) return;
      const lineText = lines[lineNumber - 1];
      const matches = findTextMatches([lineText], query, { matchCase, wholeWord, regex });
      const target =
        matches.find((m) => m.startColumn === matchStart && m.endColumn === matchEnd) ?? matches[0];
      if (!target) {
        showFloatingToastMessage(`未找到可替换的匹配：${filePath}:${lineNumber}`);
        return;
      }
      lines[lineNumber - 1] = lineText.slice(0, target.startColumn) + replacement + lineText.slice(target.endColumn);
      const newContent = lines.join("\n");
      const writeRes = await window.electronAPI.writeFile(filePath, newContent);
      if (!writeRes.success) showFloatingToastMessage(`替换失败：${writeRes.error ?? ""}`);
    },
    [],
  );

  // “所有文件”结果面板中点击某匹配的悬停“替换”按钮：替换该处出现。
  // 文件已打开 → 交由对应 EditorPane 在 CodeMirror 内就地替换（保留脏标记/undo）；
  // 文件未打开 → 直接读写磁盘。两者均乐观移除该结果项，保持面板计数同步。
  const handleReplaceMatch = useCallback(
    (match: ExpandSearchResult) => {
      const query = sharedSearchConfig.searchQuery.trim();
      const matchCase = sharedSearchConfig.searchMatchCase;
      const wholeWord = sharedSearchConfig.searchWholeWord;
      const regex = sharedSearchConfig.searchRegex;
      const original = match.preview.slice(match.matchStart, match.matchEnd);
      const replacement = applyPreserveCase(original, sharedSearchConfig.replaceQuery);
      const isOpen = useEditorStore.getState().tabs.some((tab) => tab.path === match.path);
      if (isOpen) {
        requestReplaceMatch({
          path: match.path,
          lineNumber: match.lineNumber,
          matchStart: match.matchStart,
          matchEnd: match.matchEnd,
          replacement,
          query,
          matchCase,
          wholeWord,
          regex,
        });
      } else {
        void replaceMatchOnDisk(
          match.path,
          match.lineNumber,
          match.matchStart,
          match.matchEnd,
          replacement,
          query,
          matchCase,
          wholeWord,
          regex,
        );
      }
      setExpandSearch((state) => ({
        ...state,
        results: state.results.filter(
          (r) =>
            !(
              r.path === match.path &&
              r.lineNumber === match.lineNumber &&
              r.matchStart === match.matchStart &&
              r.matchEnd === match.matchEnd
            ),
        ),
      }));
    },
    [replaceMatchOnDisk],
  );

  // 结果面板定位：紧贴搜索栏下方，随搜索栏展开/收起（高度变化）自动调整。
  // 依赖 activeKey：切标签页时可见 pane 变了，需重新测量并观察新 widget。
  useLayoutEffect(() => {
    if (!expandSearch.open) {
      setPanelTop(null);
      return;
    }
    const area = document.querySelector(".editor-area");
    // 只取可见 pane 的搜索栏；隐藏 pane（display:none）的 rect 全零会导致面板跳到顶部。
    const widget = document.querySelector(".editor-pane:not(.editor-pane-hidden) .editor-find-widget");
    if (!area || !widget) return;
    const update = () => {
      const areaRect = area.getBoundingClientRect();
      const widgetRect = widget.getBoundingClientRect();
      setPanelTop(widgetRect.bottom - areaRect.top + 8);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(widget);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [expandSearch.open, activeKey]);

  // 扩大搜索弹窗打开时，按 Esc 关闭。
  useEffect(() => {
    if (!expandSearch.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandSearch((state) => ({ ...state, open: false, dismissedQuery: state.query }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandSearch.open]);

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
            onRunAllFilesSearch={runAllFilesSearch}
            allFileMatches={allFileMatches}
            allFileLoading={expandSearch.loading}
            onOpenFile={(filePath) => useEditorStore.getState().openFile(filePath)}
            allFilesPanelOpen={expandSearch.open}
            allFilesResultsCount={expandSearch.results.length}
            onReopenAllFilesPanel={() => setExpandSearch((state) => ({ ...state, open: true, dismissedQuery: "" }))}
            onSearchScopeChange={(scope) => {
              // 切回“当前文件”选项：关闭“所有文件”结果窗口（重开按钮也随之消失）。
              if (scope !== "all") {
                setExpandSearch((state) => ({ ...state, open: false, dismissedQuery: "" }));
              }
            }}
            onReplaceStateChange={({ replaceOpen, replaceQuery, preserveCase }) => {
              setReplacePanelOpen(replaceOpen);
              setReplacePanelQuery(replaceQuery);
              setReplacePanelPreserveCase(preserveCase);
            }}
            onSearchClose={() => setExpandSearch((state) => ({ ...state, open: false, dismissedQuery: "" }))}
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

      {expandSearch.open && (
        <div
          ref={expandSearchPanelRef}
          className="editor-expand-search"
          style={panelTop !== null ? { top: panelTop } : undefined}
          role="dialog"
          aria-label="扩大搜索结果"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setExpandSearch((state) => ({ ...state, open: false, dismissedQuery: state.query }));
            }
          }}
        >
          <div className="editor-expand-search-header">
            <FileSearch size={14} strokeWidth={2} />
            <span className="editor-expand-search-title">
              {expandSearch.loading
                ? "搜索中…"
                : expandSearch.error
                  ? `搜索失败：${expandSearch.error}`
                  : `${expandSearchGroups.length} 个文件中有 ${expandSearch.results.length} 个结果`}
            </span>
            <button
              type="button"
              className="editor-expand-search-close"
              onClick={() => setExpandSearch((state) => ({ ...state, open: false, dismissedQuery: state.query }))}
              aria-label="关闭"
              title="关闭 (Esc)"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
          {expandSearch.results.length === 0 && !expandSearch.loading && !expandSearch.error ? (
            <div className="editor-expand-search-empty">未找到匹配项</div>
          ) : (
            <ExpandSearchList
              key={expandSearch.query}
              groups={expandSearchGroups}
              replaceOpen={replacePanelOpen}
              replaceQuery={replacePanelQuery}
              preserveCase={replacePanelPreserveCase}
              onGoto={requestGotoMatch}
              onReplace={handleReplaceMatch}
            />
          )}
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

