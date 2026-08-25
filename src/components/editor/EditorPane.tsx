import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, ReplaceAll, Search, WholeWord } from "lucide-react";
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState, EditorSelection, Extension, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, keymap } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { showMinimap } from "../../lib/codemirror-minimap/index.js";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { EDITOR_GOTO_MATCH_EVENT, EDITOR_REPLACE_MATCH_EVENT, pendingGoto, requestGotoMatch, sharedSearchConfig, type AllFileMatch, type GotoMatchDetail, type ReplaceMatchDetail } from "./searchConfig";
import { uiText } from "@/i18n/text";
import { isSameFileTreePath } from "@/lib/file-tree-paths";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import { useChatStore } from "@/stores/chat-store";
import { requestComposerInsert } from "@/lib/composer-insert-event";
import {
  applyPreserveCase,
  findTextMatches,
  getNextSearchMatchIndex,
  isRegexValid,
  parseGoToLine,
  type SearchMatch,
} from "@/lib/file-preview-code";
import {
  estimateTextBytes,
  getTextMateLanguage,
  MAX_TM_BYTES,
  MAX_TM_LINES,
  tmEnableEffect,
  tmHighlightPlugin,
  type TmStatus,
} from "./tm-highlight";

export type EditorPaneStatus = "loading" | "ready" | "readonly" | "error";

interface EditorContextMenuState {
  x: number;
  y: number;
  startLine: number;
  endLine: number;
  fileName: string;
}

interface EditorPaneProps {
  /** Absolute file path. */
  path: string;
  /** When false the pane is hidden but the editor instance stays alive. */
  visible: boolean;
  /** Report that the document now has unsaved changes. */
  onDirtyChange: (dirty: boolean) => void;
  /** Report the latest document text so project-level search can stay in sync with unsaved edits. */
  onDocumentChange: (path: string, content: string) => void;
  /** Called after a successful save. */
  onSaved: (path: string) => void;
  /** Called when a save fails. */
  onSaveError: (path: string, error: string) => void;
  /** Register an imperative save function so the parent can save before closing. */
  registerSave: (path: string, fn: () => Promise<boolean>) => () => void;
  /** TextMate 高亮运行时状态（状态栏指示用）。 */
  onTmStatus?: (status: TmStatus) => void;
  /** “所有文件”搜索范围：触发项目级内容搜索。openPanel 为 true 时结果弹窗在命中后打开。 */
  onRunAllFilesSearch: (openPanel: boolean) => void;
  /** “所有文件”搜索范围下的匹配结果（与查找框计数/导航共享）。 */
  allFileMatches: AllFileMatch[];
  /** “所有文件”搜索是否进行中。 */
  allFileLoading: boolean;
  /** 跳转到其他文件时（来自“扩大搜索”结果或跨文件查找导航），请求父级打开并激活该文件。 */
  onOpenFile: (path: string) => void;
  /** “所有文件”结果面板是否当前打开（父级持有并下发，用于决定“重新打开”按钮显隐）。 */
  allFilesPanelOpen: boolean;
  /** “所有文件”搜索结果数量（>0 才显示“重新打开”按钮）。 */
  allFilesResultsCount: number;
  /** 手动“重新打开”“所有文件”结果面板。 */
  onReopenAllFilesPanel: () => void;
  /** 搜索范围变化回调：父级据此在切回“当前文件”时关闭面板。 */
  onSearchScopeChange: (scope: "current" | "all") => void;
  /** 替换状态（展开替换 / 替换词 / 保留大小写）变化时通知父级，供“所有文件”结果面板显示替换预览与按钮。 */
  onReplaceStateChange: (state: { replaceOpen: boolean; replaceQuery: string; preserveCase: boolean }) => void;
  /** 查找栏（搜索控件）关闭时回调父级，用于一并收起“所有文件”结果面板。 */
  onSearchClose: () => void;
}

const DARK_COLORS = {
  comment: "#6a9955",
  keyword: "#569cd6",
  number: "#b5cea8",
  string: "#ce9178",
  regexp: "#d16969",
  property: "#9cdcfe",
  variable: "#9cdcfe",
  function: "#dcdcaa",
  type: "#4ec9b0",
  operator: "#d4d4d4",
  punctuation: "#d4d4d4",
  meta: "#c586c0",
  link: "#3794ff",
  text: "#d4d4d4",
  diffBg: "#252526",
};

const LIGHT_COLORS = {
  comment: "#008000",
  keyword: "#0000ff",
  number: "#098658",
  string: "#a31515",
  regexp: "#811f3f",
  property: "#795e26",
  variable: "#001080",
  function: "#795e26",
  type: "#267f99",
  operator: "#24272d",
  punctuation: "#24272d",
  meta: "#af00db",
  link: "#0969da",
  text: "#24272d",
  diffBg: "#ffffff",
};

function getColors(): typeof DARK_COLORS {
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") !== "light";
  return isDark ? DARK_COLORS : LIGHT_COLORS;
}

function buildHighlightStyle(colors: typeof DARK_COLORS) {
  return HighlightStyle.define([
    { tag: tags.comment, color: colors.comment, fontStyle: "italic" },
    { tag: tags.keyword, color: colors.keyword },
    { tag: tags.controlKeyword, color: colors.keyword },
    { tag: tags.definitionKeyword, color: colors.keyword },
    { tag: tags.moduleKeyword, color: colors.keyword },
    { tag: tags.operatorKeyword, color: colors.keyword },
    { tag: tags.atom, color: colors.keyword },
    { tag: tags.bool, color: colors.number },
    { tag: tags.null, color: colors.keyword },
    { tag: tags.number, color: colors.number },
    { tag: tags.string, color: colors.string },
    { tag: tags.special(tags.string), color: colors.string },
    { tag: tags.character, color: colors.string },
    { tag: tags.regexp, color: colors.regexp },
    { tag: tags.escape, color: colors.string },
    { tag: tags.propertyName, color: colors.property },
    { tag: tags.variableName, color: colors.variable },
    { tag: tags.function(tags.variableName), color: colors.function },
    { tag: tags.definition(tags.variableName), color: colors.variable },
    { tag: tags.typeName, color: colors.type },
    { tag: tags.definition(tags.typeName), color: colors.type },
    { tag: tags.className, color: colors.type },
    { tag: tags.namespace, color: colors.type },
    { tag: tags.labelName, color: colors.property },
    { tag: tags.operator, color: colors.operator },
    { tag: tags.punctuation, color: colors.punctuation },
    { tag: tags.meta, color: colors.meta },
    { tag: tags.tagName, color: colors.keyword },
    { tag: tags.attributeName, color: colors.property },
    { tag: tags.link, color: colors.link, textDecoration: "underline" },
    { tag: tags.heading, color: colors.function, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "bold" },
  ]);
}

function buildEditorTheme(colors: typeof DARK_COLORS) {
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") !== "light";
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        fontSize: "14px",
        color: colors.text,
        backgroundColor: colors.diffBg,
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily:
          'Consolas, "Cascadia Code", "Courier New", monospace',
        lineHeight: "1.6",
      },
      ".cm-content": {
        caretColor: colors.text,
        padding: "6px 0",
      },
      ".cm-line": { padding: "0 8px" },
      ".cm-cursor": { borderLeftColor: colors.text },
      ".cm-selectionBackground": {
        backgroundColor: isDark ? "rgba(0, 122, 204, 0.35)" : "rgba(9, 105, 218, 0.35)",
      },
      ".cm-gutters": {
        backgroundColor: colors.diffBg,
        color: isDark ? "#808080" : "#66707b",
        borderRight: `1px solid ${isDark ? "#3c3c3c" : "#d2d6dc"}`,
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 6px 0 8px",
        minWidth: "28px",
      },
      ".cm-activeLine": {
        backgroundColor: isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(15, 23, 42, 0.065)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(15, 23, 42, 0.065)",
      },
      ".cm-matchingBracket": {
        backgroundColor: isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(15, 23, 42, 0.12)",
        outline: `1px solid ${isDark ? "#3c3c3c" : "#d2d6dc"}`,
      },
      ".cm-tooltip": {
        backgroundColor: isDark ? "rgba(45, 45, 48, 0.99)" : "rgba(255, 255, 255, 0.98)",
        border: `1px solid ${isDark ? "#3c3c3c" : "#d2d6dc"}`,
        color: isDark ? "#f4f4f4" : "#24272d",
      },
      ".cm-searchMatch": {
        backgroundColor: isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(15, 23, 42, 0.12)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: isDark ? "#007acc" : "#0969da",
        color: "#ffffff",
      },
    },
    { dark: isDark },
  );
}

// ===== Search highlight StateField =====
// Bridges React search state with CodeMirror decorations.
interface EditorSearchHighlight {
  matches: { from: number; to: number }[];
  activeIndex: number;
}

const setSearchHighlightEffect = StateEffect.define<EditorSearchHighlight>();

const searchHighlightField = StateField.define<EditorSearchHighlight>({
  create: () => ({ matches: [], activeIndex: -1 }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSearchHighlightEffect)) return e.value;
    }
    // React 会基于新文档重新计算匹配。transaction 提交期间先清空旧范围，
    // 避免 undo/redo 缩短文档时把越界 decoration 交给 CodeMirror。
    if (tr.docChanged) return { matches: [], activeIndex: -1 };
    return value;
  },
  provide: (field) =>
    EditorView.decorations.compute([field], (state) => {
      const highlight = state.field(field, false);
      if (!highlight || !highlight.matches || highlight.matches.length === 0) {
        return Decoration.none;
      }
      const decorations = highlight.matches.map((m, i) =>
        Decoration.mark({
          class:
            i === highlight.activeIndex
              ? "editor-search-match editor-search-match-current"
              : "editor-search-match",
        }).range(m.from, m.to),
      );
      return Decoration.set(decorations, true);
    }),
});

function getLanguageExtension(filePath: string): Extension[] {
  const fileName = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const ext = fileName.split(".").pop() ?? "";
  const base = fileName.replace(/\.(json|jsonc)$/i, "");
  if (base === "package" || base === "tsconfig" || base === "tsconfig.base" || base === "composer") {
    return [json()];
  }
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "json":
    case "jsonc":
      return [json()];
    case "css":
    case "scss":
    case "less":
      return [css()];
    case "html":
    case "htm":
      return [html()];
    case "md":
    case "mdx":
    case "markdown":
      return [markdown()];
    case "py":
      return [python()];
    case "sql":
      return [sql()];
    case "xml":
    case "svg":
      return [xml()];
    case "yaml":
    case "yml":
      return [yaml()];
    case "lua":
      return [StreamLanguage.define(lua)];
    case "cs":
      return [StreamLanguage.define(csharp)];
    default:
      return [];
  }
}

export function EditorPane({
  path,
  visible,
  onDirtyChange,
  onDocumentChange,
  onSaved,
  onSaveError,
  registerSave,
  onTmStatus,
  onRunAllFilesSearch,
  allFileMatches,
  allFileLoading,
  onOpenFile,
  allFilesPanelOpen,
  allFilesResultsCount,
  onReopenAllFilesPanel,
  onSearchScopeChange,
  onReplaceStateChange,
  onSearchClose,
}: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartmentRef = useRef<Compartment | null>(null);
  const themeCompartmentRef = useRef<Compartment | null>(null);
  const highlightCompartmentRef = useRef<Compartment | null>(null);
  const langCompartmentRef = useRef<Compartment | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const readonlyRef = useRef(false);
  const initializingRef = useRef(false);
  const originalContentRef = useRef<string>("");
  const externalConflictContentRef = useRef<string | null>(null);
  const [status, setStatus] = useState<EditorPaneStatus>("loading");
  const [statusMessage, setStatusMessage] = useState("");
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const addPendingFile = useChatStore((state) => state.addPendingFile);

  // ===== Search & Go-to-line state =====
  // 初始化自 sharedSearchConfig：切换标签页时沿用同一份搜索状态（searchOpen/query/选项等），
  // 实现“打开 Ctrl+F 后切换文件仍保持搜索同一关键词”。各 pane 仍按自身文档计算匹配。
  const [searchOpen, setSearchOpen] = useState(sharedSearchConfig.searchOpen);
  const [searchQuery, setSearchQuery] = useState(sharedSearchConfig.searchQuery);
  // 防抖搜索词：输入过程中只更新输入框文本（searchQuery），停止输入 ~500ms 后才
  // 更新 debouncedSearchQuery 并触发搜索计算，避免大文件连续按键每键一次正则匹配导致卡顿。
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(sharedSearchConfig.searchQuery);
  // 持有最新查询，供 openSearch/openReplace 等 useCallback（依赖不含 debouncedSearchQuery）读取，避免闭包捕获到初始空值。
  const debouncedSearchQueryRef = useRef(debouncedSearchQuery);
  debouncedSearchQueryRef.current = debouncedSearchQuery;
  useEffect(() => {
    // 清空立即生效（清空结果无需防抖）。
    if (!searchQuery) {
      setDebouncedSearchQuery((current) => (current === "" ? current : ""));
      return;
    }
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery), 500);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);
  const [searchMatchCase, setSearchMatchCase] = useState(sharedSearchConfig.searchMatchCase);
  const [searchWholeWord, setSearchWholeWord] = useState(sharedSearchConfig.searchWholeWord);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState("");
  const [goToLineError, setGoToLineError] = useState(false);
  // Bumped on doc edits while search is open, to refresh match positions.
  const [docVersion, setDocVersion] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const goToLineInputRef = useRef<HTMLInputElement>(null);
  const goToLineWidgetRef = useRef<HTMLDivElement>(null);
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  const goToLineOpenRef = useRef(false);
  goToLineOpenRef.current = goToLineOpen;
  // ===== Replace state (Ctrl+H) =====
  const [searchRegex, setSearchRegex] = useState(sharedSearchConfig.searchRegex);
  const [replaceOpen, setReplaceOpen] = useState(sharedSearchConfig.replaceOpen);
  const [replaceQuery, setReplaceQuery] = useState(sharedSearchConfig.replaceQuery);
  const [preserveCase, setPreserveCase] = useState(sharedSearchConfig.preserveCase);
  const [searchScope, setSearchScope] = useState<"current" | "all">(sharedSearchConfig.searchScope);
  const searchScopeRef = useRef<"current" | "all">(sharedSearchConfig.searchScope);
  searchScopeRef.current = searchScope;
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const searchRegexRef = useRef(false);
  searchRegexRef.current = searchRegex;
  const replaceOpenRef = useRef(false);
  replaceOpenRef.current = replaceOpen;
  const replaceQueryRef = useRef("");
  replaceQueryRef.current = replaceQuery;
  const preserveCaseRef = useRef(false);
  preserveCaseRef.current = preserveCase;
  // 显式导航计数：仅在上一项/下一项/打开搜索等用户动作时自增，
  // 用于隔离“文档被编辑导致匹配变化”与“用户主动跳转”——编辑时不滚动。
  const [navTick, setNavTick] = useState(0);
  // 通过选区填充搜索文本（Ctrl+F 前已选中文本）后，用于触发“定位到选区所属匹配项”的 effect。
  const [selectionLocateTick, setSelectionLocateTick] = useState(0);
  // 选区起点在文档中的绝对偏移；非空时表示本次打开搜索源自选区填充，
  // 需在匹配就绪后把“当前匹配项”定位到选区所属那一项，而非默认跳到第 1 项。
  const pendingSelectionAnchorRef = useRef<number | null>(null);
  const activeMatchIndexRef = useRef(-1);
  activeMatchIndexRef.current = activeMatchIndex;
  // 显式滚动目标：在用户主动跳转/打开搜索/切文件时由处理函数写入，
  // 滚动 effect 仅消费它（避免依赖 activeMatchIndex 的异步重置导致滚动到错误位置）。
  const pendingScrollRef = useRef(-1);
  // 已打开搜索框时再次按 Ctrl+F / Ctrl+H：标记本次不要自动滚动/重置到第 1 项，
  // 仅聚焦输入框、保持当前匹配项与视图位置。
  const suppressAutoScrollRef = useRef(false);
  // 记录上一次防抖查询，用于区分“搜索框文字变动”与“切换匹配选项”等其它触发：
  // 文字变动 / 匹配选项（大小写、全字、正则）变化时，优先定位到当前滚动位置附近的匹配项，而不是无脑回第 1 项。
  const prevDebouncedQueryRef = useRef(debouncedSearchQuery);
  const prevMatchCaseRef = useRef(searchMatchCase);
  const prevWholeWordRef = useRef(searchWholeWord);
  const prevRegexRef = useRef(searchRegex);
  // 仅当用户显式按 ↑/↓ 导航时，才允许“所有文件”范围跨文件跳转打开其它文件；
  // 打开搜索、输入文本等隐式动作不自动打开其它文件（避免抢走输入框焦点、意外跳页）。
  const crossFileNavAllowedRef = useRef(false);
  // 供全局事件监听闭包读取最新值（避免闭包捕获过期状态）。
  const statusRef = useRef(status);
  statusRef.current = status;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onRunAllFilesSearchRef = useRef(onRunAllFilesSearch);
  onRunAllFilesSearchRef.current = onRunAllFilesSearch;

  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onDocumentChangeRef = useRef(onDocumentChange);
  onDocumentChangeRef.current = onDocumentChange;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onSaveErrorRef = useRef(onSaveError);
  onSaveErrorRef.current = onSaveError;
  const registerSaveRef = useRef(registerSave);
  registerSaveRef.current = registerSave;
  const onTmStatusRef = useRef(onTmStatus);
  onTmStatusRef.current = onTmStatus;
  const onReplaceStateChangeRef = useRef(onReplaceStateChange);
  onReplaceStateChangeRef.current = onReplaceStateChange;
  // 用 ref 持有最新 onSearchScopeChange，避免 openSearch/openReplace 因该（父级内联、易变）回调
  // 身份变化而被重新创建，进而触发 EditorView 创建 effect 反复重建编辑器。
  const onSearchScopeChangeRef = useRef(onSearchScopeChange);
  onSearchScopeChangeRef.current = onSearchScopeChange;

  const setReadOnly = useCallback((readOnly: boolean) => {
    readonlyRef.current = readOnly;
    const view = viewRef.current;
    const compartment = readOnlyCompartmentRef.current;
    if (view && compartment) {
      view.dispatch({
        effects: compartment.reconfigure(EditorState.readOnly.of(readOnly)),
      });
    }
  }, []);

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (!view || savingRef.current || readonlyRef.current) return false;
    savingRef.current = true;
    try {
      const content = view.state.doc.toString();
      const result = await window.electronAPI.writeFile(path, content);
      if (result.success) {
        externalConflictContentRef.current = null;
        // 保存成功后，将原始内容基准更新为已保存的内容，
        // 这样后续 undo 回到保存点时能正确清除脏标记。
        originalContentRef.current = content;
        dirtyRef.current = false;
        onDirtyChangeRef.current(false);
        onSavedRef.current(path);
      } else {
        onSaveErrorRef.current(path, result.error || "保存失败");
      }
      return result.success;
    } finally {
      savingRef.current = false;
    }
  }, [path]);

  const handleSendToChat = useCallback(() => {
    if (!contextMenu) return;
    const pendingFile = {
      id: crypto.randomUUID(),
      fileName: contextMenu.fileName,
      filePath: path,
      startLine: contextMenu.startLine,
      endLine: contextMenu.endLine,
    };
    const inserted = requestComposerInsert({ node: { ...pendingFile, type: "snippet" } });
    if (!inserted) addPendingFile(pendingFile);
    setContextMenu(null);
  }, [contextMenu, path, addPendingFile]);

  // ===== Search & Go-to-line logic =====
  const searchMatches = useMemo<SearchMatch[]>(() => {
    if (!searchOpen || !debouncedSearchQuery) return [];
    const view = viewRef.current;
    if (!view) return [];
    const lines = view.state.doc.toString().split("\n");
    return findTextMatches(lines, debouncedSearchQuery, {
      matchCase: searchMatchCase,
      wholeWord: searchWholeWord,
      regex: searchRegex,
    });
  }, [searchOpen, debouncedSearchQuery, searchMatchCase, searchWholeWord, searchRegex, docVersion]);

  // 查找框实际使用的匹配集合：
  // - 当前文件：直接用本文件 searchMatches；
  // - 所有文件：复用父级下发的项目级搜索结果（allFileMatches），用于计数与跨文件导航。
  // 带 path 字段以便导航时判断是否跨文件。
  const displayMatches = useMemo<Array<SearchMatch & { path?: string }>>(() => {
    if (searchScope === "all") {
      return allFileMatches.map((match) => ({
        lineNumber: match.lineNumber,
        startColumn: match.startColumn,
        endColumn: match.endColumn,
        path: match.path,
      }));
    }
    return searchMatches;
  }, [searchScope, searchMatches, allFileMatches]);

  // 正则模式下，源非法则无结果并显示错误态。
  const searchRegexError = useMemo<boolean>(() => {
    if (!searchOpen || !searchRegex || !searchQuery) return false;
    return !isRegexValid(searchQuery, searchMatchCase);
  }, [searchOpen, searchRegex, searchQuery, searchMatchCase]);

  const prevSearchKeyRef = useRef<string | null>(null);
  // 防抖查询 / 选项 / 范围变化后：回到第一个匹配。当前文件范围同时滚动到首个匹配
  // （debounce 落地后才滚动，避免连续按键时滚动到旧匹配）。
  // 注意：仅当“查询内容 / 选项”真正变化时才重置到第 1 项；单纯 searchOpen（开 / 关）变化
  // （如查找框已有内容时再次按 Ctrl+F）不应重置，否则会丢失当前匹配位置。
  useEffect(() => {
    // 源自选区填充：交由下方定位 effect 把“当前项”设为选区所属匹配，且不滚动。
    if (pendingSelectionAnchorRef.current != null) return;
    const searchKey = `${debouncedSearchQuery} ${searchMatchCase} ${searchWholeWord} ${searchRegex} ${searchScope}`;
    const queryChanged = prevDebouncedQueryRef.current !== debouncedSearchQuery;
    prevDebouncedQueryRef.current = debouncedSearchQuery;
    // 匹配选项（大小写 / 全字 / 正则）切换时同样按“优先当前滚动位置”处理。
    const optionChanged =
      prevMatchCaseRef.current !== searchMatchCase ||
      prevWholeWordRef.current !== searchWholeWord ||
      prevRegexRef.current !== searchRegex;
    prevMatchCaseRef.current = searchMatchCase;
    prevWholeWordRef.current = searchWholeWord;
    prevRegexRef.current = searchRegex;
    if (prevSearchKeyRef.current === searchKey) return;
    prevSearchKeyRef.current = searchKey;

    // 查询文字变动 / 匹配选项切换时：优先定位到当前滚动位置（视口中心）附近的匹配项，
    // 而不是无脑回第 1 项；“所有文件”范围下仍回第 1 项（跨文件结果不在此定位）。
    const preferViewport = (queryChanged || optionChanged) && searchScope === "current";
    let targetIdx = 0;
    const view = viewRef.current;
    if (preferViewport && view && displayMatches.length > 0) {
      const centerPos = view.posAtCoords({ x: 0, y: view.scrollDOM.clientHeight / 2 });
      if (centerPos != null) {
        let below = -1;
        let above = -1;
        for (let i = 0; i < displayMatches.length; i++) {
          const m = displayMatches[i];
          const from = view.state.doc.line(m.lineNumber).from + m.startColumn;
          if (from >= centerPos) {
            below = i;
            break;
          }
          above = i;
        }
        targetIdx = below >= 0 ? below : above;
      }
    }

    setActiveMatchIndex(displayMatches.length > 0 ? targetIdx : -1);
    if (searchScope === "current" && searchOpen && debouncedSearchQuery) {
      // 已打开时重复按 Ctrl+F/H：抑制自动滚动，保持当前视图位置。
      if (suppressAutoScrollRef.current) {
        suppressAutoScrollRef.current = false;
      } else if (preferViewport && view && displayMatches.length > 0) {
        // 目标匹配已在视口内则只更新高亮，不滚动；否则滚动到该匹配。
        const m = displayMatches[targetIdx];
        const pos = view.state.doc.line(m.lineNumber).from + m.startColumn;
        const inView = pos >= view.viewport.from && pos <= view.viewport.to;
        if (!inView) {
          pendingScrollRef.current = targetIdx;
          setNavTick((tick) => tick + 1);
        }
      } else {
        pendingScrollRef.current = 0;
        setNavTick((tick) => tick + 1);
      }
    }
  }, [debouncedSearchQuery, searchMatchCase, searchWholeWord, searchRegex, searchScope, searchOpen]);

  useEffect(() => {
    const anchor = pendingSelectionAnchorRef.current;
    if (anchor != null) {
      // 源自选区填充：仅当防抖查询已反映当前搜索词（即匹配集对应选区文本）时才定位，
      // 否则（防抖尚未落地，displayMatches 仍是旧搜索词的匹配）保留锚点等待，
      // 避免用旧匹配集错误定位并清空锚点，导致随后被 530 effect 归零滚动到第 1 项。
      if (displayMatches.length > 0 && debouncedSearchQuery === searchQuery) {
        // 把“当前项”定位到选区起点所属的那一项匹配，并保持当前视图位置（不滚动到该匹配）。
        const view = viewRef.current;
        let idx = -1;
        for (let i = 0; i < displayMatches.length; i++) {
          const m = displayMatches[i];
          const line = view ? view.state.doc.line(m.lineNumber) : null;
          const from = line ? line.from + m.startColumn : -1;
          const to = line ? line.from + m.endColumn : -1;
          if (anchor >= from && anchor <= to) {
            idx = i;
            break;
          }
        }
        if (idx < 0) {
          // 选区未精确落在某匹配内（如跨边界）：取起点不超过锚点的最后一个匹配。
          for (let i = 0; i < displayMatches.length; i++) {
            const m = displayMatches[i];
            const line = view ? view.state.doc.line(m.lineNumber) : null;
            const from = line ? line.from + m.startColumn : -1;
            if (from <= anchor) idx = i;
            else break;
          }
        }
        pendingSelectionAnchorRef.current = null;
        setActiveMatchIndex(idx);
      }
      // 尚未就绪：保留锚点，不做任何重置。
      return;
    }
    setActiveMatchIndex((current) => {
      if (displayMatches.length === 0) return -1;
      if (current < 0 || current >= displayMatches.length) return 0;
      return current;
    });
  }, [displayMatches, selectionLocateTick, debouncedSearchQuery, searchQuery]);

  // Push highlight decorations into the CodeMirror editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const absoluteMatches = searchMatches.map((m) => {
      const line = view.state.doc.line(m.lineNumber);
      return { from: line.from + m.startColumn, to: line.from + m.endColumn };
    });
    view.dispatch({
      effects: setSearchHighlightEffect.of({
        matches: absoluteMatches,
        // 所有文件范围下，activeMatchIndex 指向跨文件结果，不应错误高亮本文件某项，故置 -1。
        activeIndex: searchScope === "all" ? -1 : activeMatchIndex,
      }),
    });
  }, [searchMatches, activeMatchIndex]);

  // Clear highlights when search is closed.
  useEffect(() => {
    if (searchOpen) return;
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: setSearchHighlightEffect.of({ matches: [], activeIndex: -1 }),
    });
  }, [searchOpen]);

  // Scroll the active match into view.
  // 依赖 navTick（而非 activeMatchIndex/displayMatches）：编辑文档导致匹配变化时 navTick 不变，
  // 因此不会自动跳走；仅当用户显式导航/打开搜索/切换文件（处理函数自增 navTick）才滚动。
  useEffect(() => {
    const idx = pendingScrollRef.current;
    if (idx < 0) return;
    pendingScrollRef.current = -1;
    const match = displayMatches[idx];
    if (!match) return;
    // 所有文件范围且目标不在当前文件：仅当用户显式 ↑/↓ 导航时才跨文件跳转打开目标文件；
    // 打开搜索 / 输入文本等隐式动作不应自动打开其它文件（避免抢焦点、意外跳页）。
    const matchPath = (match as SearchMatch & { path?: string }).path;
    if (searchScope === "all" && matchPath && matchPath !== path) {
      if (crossFileNavAllowedRef.current) {
        crossFileNavAllowedRef.current = false;
        requestGotoMatch(matchPath, match.lineNumber);
      }
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    const line = view.state.doc.line(match.lineNumber);
    const from = line.from + match.startColumn;
    view.dispatch({
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }, [navTick]);

  // Focus the search / goto-line input shortly after it opens.
  useEffect(() => {
    if (!searchOpen) return;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    if (!goToLineOpen) return;
    const frame = requestAnimationFrame(() => goToLineInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [goToLineOpen]);

  // 查找栏关闭（任意路径：× 按钮 / Esc / Ctrl+Alt+W / 点击文档外）时通知父级一并收起“所有文件”结果面板。
  // 用 ref 持有回调使 effect 仅在 searchOpen 跳变时运行，避免父级重渲染导致重复触发。
  const onSearchCloseRef = useRef(onSearchClose);
  onSearchCloseRef.current = onSearchClose;
  const prevSearchOpenRef = useRef(searchOpen);
  useEffect(() => {
    if (prevSearchOpenRef.current && !searchOpen) {
      onSearchCloseRef.current();
    }
    prevSearchOpenRef.current = searchOpen;
  }, [searchOpen]);

  // 本地搜索状态 → 共享单例：任意变更都回写到 sharedSearchConfig，
  // 使切换标签页时其他 pane 能沿用同一份搜索状态（同一关键词/选项）。
  useEffect(() => {
    sharedSearchConfig.searchOpen = searchOpen;
    sharedSearchConfig.searchQuery = searchQuery;
    sharedSearchConfig.searchMatchCase = searchMatchCase;
    sharedSearchConfig.searchWholeWord = searchWholeWord;
    sharedSearchConfig.searchRegex = searchRegex;
    sharedSearchConfig.replaceOpen = replaceOpen;
    sharedSearchConfig.replaceQuery = replaceQuery;
    sharedSearchConfig.preserveCase = preserveCase;
    sharedSearchConfig.searchScope = searchScope;
    // 通知父级（EditorArea）：替换状态变化，使其“所有文件”结果面板能实时反映替换预览与按钮。
    onReplaceStateChangeRef.current?.({ replaceOpen, replaceQuery, preserveCase });
  }, [searchOpen, searchQuery, searchMatchCase, searchWholeWord, searchRegex, replaceOpen, replaceQuery, preserveCase, searchScope]);

  // 成为可见标签页时，从共享单例同步回本地状态：保留同一关键词并跳到首个匹配。
  useEffect(() => {
    if (!visible) return;
    setSearchOpen(sharedSearchConfig.searchOpen);
    setSearchQuery(sharedSearchConfig.searchQuery);
    setDebouncedSearchQuery(sharedSearchConfig.searchQuery);
    setSearchMatchCase(sharedSearchConfig.searchMatchCase);
    setSearchWholeWord(sharedSearchConfig.searchWholeWord);
    setSearchRegex(sharedSearchConfig.searchRegex);
    setReplaceOpen(sharedSearchConfig.replaceOpen);
    setReplaceQuery(sharedSearchConfig.replaceQuery);
    setPreserveCase(sharedSearchConfig.preserveCase);
    setSearchScope(sharedSearchConfig.searchScope);
    // 切到该标签页时滚到首个匹配；但若本次正是"扩大搜索"跳转目标（pendingGoto 指向本文件），
    // 则交给 pendingGoto effect 滚动到精确行，避免被"滚到首个匹配"覆盖。
    // "所有文件"范围下不自动滚动：displayMatches[0] 可能是其他文件的匹配，
    // requestGotoMatch 会打开该文件，导致切 tab 时老是跳到第一个匹配文件。
    if (sharedSearchConfig.searchOpen && sharedSearchConfig.searchQuery && sharedSearchConfig.searchScope !== "all" && pendingGoto.path !== path) {
      pendingScrollRef.current = 0;
      setActiveMatchIndex(0);
      setNavTick((tick) => tick + 1);
    }
  }, [visible]);

  // 监听“扩大搜索”结果跳转：目标为本 pane 则滚动；否则（且本 pane 当前可见）请求打开目标文件，
  // 由目标 pane 在文档 ready 后完成滚动。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<GotoMatchDetail>).detail;
      if (!detail) return;
      if (detail.path === path) {
        if (visibleRef.current && statusRef.current === "ready") {
          scrollToLine(detail.line);
          pendingGoto.path = null;
        } else {
          pendingGoto.path = path;
          pendingGoto.line = detail.line;
        }
        return;
      }
      if (visibleRef.current) {
        onOpenFileRef.current(detail.path);
      }
    };
    window.addEventListener(EDITOR_GOTO_MATCH_EVENT, handler);
    return () => window.removeEventListener(EDITOR_GOTO_MATCH_EVENT, handler);
  }, [path]);

  // 文档加载完成且本 pane 可见时，若有待办跳转（来自“扩大搜索”结果），执行滚动并清除。
  useEffect(() => {
    if (status !== "ready" || !visible) return;
    if (pendingGoto.path === path) {
      scrollToLine(pendingGoto.line);
      pendingGoto.path = null;
    }
  }, [status, visible, path]);

  // 监听“所有文件”结果面板发起的单处替换：本 pane 负责该 path 时，
  // 在 CodeMirror 实时文档内重新定位该次出现并就地替换（保持脏标记与 undo），
  // 文件未打开的场景由父级走磁盘读写回退。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ReplaceMatchDetail>).detail;
      if (!detail || detail.path !== path) return;
      const view = viewRef.current;
      if (!view || statusRef.current !== "ready") return;
      const total = view.state.doc.lines;
      if (detail.lineNumber < 1 || detail.lineNumber > total) return;
      const line = view.state.doc.line(detail.lineNumber);
      const matches = findTextMatches([line.text], detail.query, {
        matchCase: detail.matchCase,
        wholeWord: detail.wholeWord,
        regex: detail.regex,
      });
      // 优先按原始列范围定位；实时行内容漂移时回退到该行的第一个出现。
      const target =
        matches.find((m) => m.startColumn === detail.matchStart && m.endColumn === detail.matchEnd) ?? matches[0];
      if (!target) return;
      const from = line.from + target.startColumn;
      const to = line.from + target.endColumn;
      view.dispatch({
        changes: { from, to, insert: detail.replacement },
        selection: EditorSelection.cursor(from + detail.replacement.length),
        effects: EditorView.scrollIntoView(from + detail.replacement.length, { y: "center" }),
      });
    };
    window.addEventListener(EDITOR_REPLACE_MATCH_EVENT, handler);
    return () => window.removeEventListener(EDITOR_REPLACE_MATCH_EVENT, handler);
  }, [path]);

  // 所有文件范围下，关键词/选项变化时防抖重新检索（不强制弹窗，仅刷新计数与导航结果）。
  // 通过 sharedSearchConfig.lastAllFilesSearchKey 去重：切 tab 或新 pane 挂载时若参数未变则跳过，避免重复搜索。
  const allFilesSearchTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (searchScope !== "all" || !searchOpen || !searchQuery.trim()) return;
    // 构建当前搜索参数键，与上次实际搜索的参数键比对。
    const paramsKey = JSON.stringify({
      query: searchQuery.trim(),
      matchCase: searchMatchCase,
      wholeWord: searchWholeWord,
      regex: searchRegex,
    });
    if (paramsKey === sharedSearchConfig.lastAllFilesSearchKey) return;
    if (allFilesSearchTimerRef.current) window.clearTimeout(allFilesSearchTimerRef.current);
    allFilesSearchTimerRef.current = window.setTimeout(() => {
      onRunAllFilesSearchRef.current(false);
    }, 250);
    return () => {
      if (allFilesSearchTimerRef.current) window.clearTimeout(allFilesSearchTimerRef.current);
    };
  }, [searchQuery, searchMatchCase, searchWholeWord, searchRegex, searchScope, searchOpen]);

  // 选中文本后按 Ctrl+F / Ctrl+H：把当前编辑器选区文本直接填入搜索框。
  // 仅在确实存在选区时才覆盖旧查询，避免清空用户已输入的内容。
  const fillSearchFromSelection = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.from !== sel.to) {
      const selectedText = view.state.sliceDoc(sel.from, sel.to).replace(/\r?\n+$/, "");
      if (selectedText) {
        // 记录选区起点，便于打开搜索后定位到选区所属匹配项（而非跳到第 1 项）。
        pendingSelectionAnchorRef.current = sel.from;
        setSelectionLocateTick((tick) => tick + 1);
        setSearchQuery(selectedText);
        return;
      }
    }
    // 无有效选区：清除锚点，沿用默认“回到第 1 项并滚动”的行为。
    pendingSelectionAnchorRef.current = null;
  }, []);

  // 滚动到指定行号（用于“扩大搜索”结果跳转与全局 goto 事件）。
  const scrollToLine = useCallback((lineNumber: number) => {
    const view = viewRef.current;
    if (!view) return;
    const total = view.state.doc.lines;
    const clamped = Math.max(1, Math.min(lineNumber, total));
    const line = view.state.doc.line(clamped);
    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
  }, []);

  // 选项（区分大小写/全字匹配/正则）切换：仅切换状态，定位交由上方“防抖落地”effect
  // 统一按“优先当前滚动位置”规则处理（与查询文字变动一致），避免切选项跳回第 1 项。
  const toggleMatchCase = useCallback(() => {
    setSearchMatchCase((current) => !current);
  }, []);

  const toggleWholeWord = useCallback(() => {
    setSearchWholeWord((current) => !current);
  }, []);

  const toggleRegex = useCallback(() => {
    setSearchRegex((current) => !current);
  }, []);

  const openSearch = useCallback(() => {
    setGoToLineOpen(false);
    setGoToLineError(false);
    const wasOpen = searchOpenRef.current;
    fillSearchFromSelection();
    // 重新打开搜索框：把范围下拉重置回“当前文件”，并收起“所有文件”结果面板
    // （面板与该下拉选项绑定，切回“当前文件”即关闭）。
    const scopeWasNotCurrent = searchScopeRef.current !== "current";
    if (scopeWasNotCurrent) {
      setSearchScope("current");
      onSearchScopeChangeRef.current?.("current");
    } else {
      onSearchScopeChangeRef.current?.("current");
    }
    setSearchOpen(true);
    // 仅在“首次打开、无现成查询且非选区填充”时才回到第 1 项并滚动；
    // 若查找框已有内容（复用既有查询，例如再次按 Ctrl+F 时），保持当前匹配项与视图位置，
    // 仅把焦点拉回输入框（由下方 rAF 处理），避免重复按 Ctrl+F 跳到第 1 项。
    if (!wasOpen && pendingSelectionAnchorRef.current == null && !debouncedSearchQueryRef.current) {
      pendingScrollRef.current = 0;
      setActiveMatchIndex(0);
      setNavTick((tick) => tick + 1);
    } else if (wasOpen && scopeWasNotCurrent) {
      // 已打开且 scope 刚切回 current 会触发下方自动滚动，此处抑制以保持当前视图位置。
      suppressAutoScrollRef.current = true;
    }
    // 搜索框已打开时再次按 Ctrl+F：searchOpen 状态不变，上面的 effect 不会重新触发，
    // 这里显式重新聚焦输入框，确保焦点回到搜索框（例如焦点已回到编辑器内容时）。
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [fillSearchFromSelection]);

  const openReplace = useCallback(() => {
    setGoToLineOpen(false);
    setGoToLineError(false);
    const wasOpen = searchOpenRef.current || replaceOpenRef.current;
    fillSearchFromSelection();
    // 与 Ctrl+F 一致：打开查找/替换时把范围重置回“当前文件”并收起“所有文件”面板。
    const scopeWasNotCurrent = searchScopeRef.current !== "current";
    if (scopeWasNotCurrent) {
      setSearchScope("current");
      onSearchScopeChangeRef.current?.("current");
    } else {
      onSearchScopeChangeRef.current?.("current");
    }
    setSearchOpen(true);
    setReplaceOpen(true);
    // 与 openSearch 一致：已打开、来自选区或已有查询内容时不重置到首项、不滚动。
    if (!wasOpen && pendingSelectionAnchorRef.current == null && !debouncedSearchQueryRef.current) {
      pendingScrollRef.current = 0;
      setActiveMatchIndex(0);
      setNavTick((tick) => tick + 1);
    } else if (wasOpen && scopeWasNotCurrent) {
      suppressAutoScrollRef.current = true;
    }
    // 查找替换已打开时再次按 Ctrl+H：状态不变，effect 不会重新触发，这里显式重新聚焦。
    requestAnimationFrame(() => replaceInputRef.current?.focus());
  }, [fillSearchFromSelection]);

  // 左侧折叠手柄：在查找 / 查找替换之间切换；展开时把焦点移到替换输入框。
  const toggleReplace = useCallback(() => {
    const next = !replaceOpenRef.current;
    setReplaceOpen(next);
    if (next) requestAnimationFrame(() => replaceInputRef.current?.focus());
  }, []);

  const openGoToLine = useCallback(() => {
    setSearchOpen(false);
    setReplaceOpen(false);
    setGoToLineValue("");
    setGoToLineError(false);
    setGoToLineOpen(true);
  }, []);

  const navigateSearch = useCallback(
    (direction: 1 | -1) => {
      if (displayMatches.length === 0) return;
      const nextIndex = getNextSearchMatchIndex(activeMatchIndex, displayMatches.length, direction);
      pendingScrollRef.current = nextIndex;
      setActiveMatchIndex(nextIndex);
      // 标记这是用户显式 ↑/↓ 导航，允许“所有文件”范围跨文件跳转。
      crossFileNavAllowedRef.current = true;
      setNavTick((tick) => tick + 1);
    },
    [activeMatchIndex, displayMatches],
  );

  const submitGoToLine = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const total = view.state.doc.lines;
    const lineNumber = parseGoToLine(goToLineValue, total);
    if (lineNumber === null) {
      setGoToLineError(true);
      return;
    }
    const line = view.state.doc.line(lineNumber);
    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
    setGoToLineError(false);
    setGoToLineOpen(false);
  }, [goToLineValue]);

  // ===== Replace logic (Ctrl+H) =====
  // 保留大小写改写复用 file-preview-code 的 applyPreserveCase（与“所有文件”结果预览/替换同源）。

  const replaceOne = useCallback(() => {
    const view = viewRef.current;
    if (!view || searchMatches.length === 0) return;
    const idx = activeMatchIndex >= 0 ? activeMatchIndex : 0;
    const match = searchMatches[idx];
    if (!match) return;
    const line = view.state.doc.line(match.lineNumber);
    const from = line.from + match.startColumn;
    const to = line.from + match.endColumn;
    const originalText = view.state.sliceDoc(from, to);
    const replacement = preserveCaseRef.current
      ? applyPreserveCase(originalText, replaceQueryRef.current)
      : replaceQueryRef.current;
    view.dispatch({
      changes: { from, to, insert: replacement },
      selection: EditorSelection.cursor(from + replacement.length),
      effects: EditorView.scrollIntoView(from + replacement.length, { y: "center" }),
    });
    // docVersion 自增后 searchMatches 重算，activeMatchIndex 保持停靠在下一项。
  }, [searchMatches, activeMatchIndex, applyPreserveCase]);

  const replaceAll = useCallback(() => {
    const view = viewRef.current;
    if (!view || searchMatches.length === 0) return;
    const changes = searchMatches.map((m) => {
      const line = view.state.doc.line(m.lineNumber);
      const from = line.from + m.startColumn;
      const to = line.from + m.endColumn;
      const originalText = view.state.sliceDoc(from, to);
      const insert = preserveCaseRef.current
        ? applyPreserveCase(originalText, replaceQueryRef.current)
        : replaceQueryRef.current;
      return { from, to, insert };
    });
    // 按位置从大到小应用，避免前面的改动影响后面区间的偏移。
    changes.sort((a, b) => b.from - a.from);
    const first = changes[changes.length - 1];
    const firstReplacedLength = first.insert.length;
    const newCursor = first.from + firstReplacedLength;
    view.dispatch({
      changes,
      selection: EditorSelection.cursor(newCursor),
      effects: EditorView.scrollIntoView(newCursor, { y: "center" }),
    });
  }, [searchMatches, applyPreserveCase]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    externalConflictContentRef.current = null;
    readonlyRef.current = false;
    dirtyRef.current = false;
    savingRef.current = false;
    setStatus("loading");
    setStatusMessage("");

    const readOnlyCompartment = new Compartment();
    readOnlyCompartmentRef.current = readOnlyCompartment;
    const themeCompartment = new Compartment();
    themeCompartmentRef.current = themeCompartment;
    const highlightCompartment = new Compartment();
    highlightCompartmentRef.current = highlightCompartment;
    const langCompartment = new Compartment();
    langCompartmentRef.current = langCompartment;

    const colors = getColors();
    const langExtensions = getLanguageExtension(path);
    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: "",
        extensions: [
          // 放在 basicSetup 前面的高优先级 keymap，
          // 抢先拦截 Ctrl/Cmd+F / Ctrl/Cmd+G，阻止 basicSetup.searchKeymap 弹出原生 find widget。
          keymap.of([
            {
              key: "Mod-z",
              run: undo,
              preventDefault: true,
              stopPropagation: true,
            },
            {
              key: "Shift-Mod-z",
              run: redo,
              preventDefault: true,
              stopPropagation: true,
            },
            {
              key: "Mod-y",
              run: redo,
              preventDefault: true,
              stopPropagation: true,
            },
            {
              key: "Mod-f",
              run: () => {
                openSearch();
                return true;
              },
              preventDefault: true,
            },
            {
              key: "Mod-h",
              run: () => {
                openReplace();
                return true;
              },
              preventDefault: true,
            },
            {
              key: "Mod-g",
              run: () => {
                openGoToLine();
                return true;
              },
              preventDefault: true,
            },
            {
              key: "Shift-Mod-f",
              run: () => true,
              preventDefault: true,
            },
            {
              key: "Shift-Mod-h",
              run: () => true,
              preventDefault: true,
            },
            {
              key: "Mod-F3",
              run: () => true,
              preventDefault: true,
            },
            {
              key: "Shift-Mod-F3",
              run: () => true,
              preventDefault: true,
            },
          ]),
          basicSetup,
          // 代码缩略图（minimap）：右侧以彩色微缩文本渲染整个文档，
          // viewport 覆盖层负责纵向定位；超长单行仍使用底部原生横向滚动条。
          showMinimap.of({
            create: () => ({ dom: document.createElement("div") }),
            displayText: "characters",
            showOverlay: "mouse-over",
            width: 80,
          }),
          themeCompartment.of(buildEditorTheme(colors)),
          highlightCompartment.of(syntaxHighlighting(buildHighlightStyle(colors))),
          searchHighlightField,
          langCompartment.of(langExtensions),
          tmHighlightPlugin({
            language: getTextMateLanguage(path),
            langCompartment,
            fallbackLanguage: langExtensions,
            onStatus: (status) => onTmStatusRef.current?.(status),
          }),
          readOnlyCompartment.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !initializingRef.current) {
              const currentContent = update.state.doc.toString();
              onDocumentChangeRef.current(path, currentContent);
              const isDirty = currentContent !== originalContentRef.current;
              if (isDirty !== dirtyRef.current) {
                dirtyRef.current = isDirty;
                onDirtyChangeRef.current(isDirty);
              }
            }
            // 搜索面板打开期间文档变化时刷新匹配位置。
            if (update.docChanged && searchOpenRef.current) {
              setDocVersion((v) => v + 1);
            }
          }),
          EditorView.domEventHandlers({
            keydown: (event, currentView) => {
              const modifierPressed = (event.ctrlKey || event.metaKey) && !event.altKey;
              const key = event.key.toLowerCase();
              if (modifierPressed && key === "s") {
                event.preventDefault();
                event.stopPropagation();
                void save();
                return true;
              }
              // Ctrl+F — open custom search (intercept basicSetup's built-in search).
              if (modifierPressed && key === "f") {
                event.preventDefault();
                event.stopPropagation();
                openSearch();
                return true;
              }
              // Ctrl+H — open search + replace.
              if (modifierPressed && key === "h") {
                event.preventDefault();
                event.stopPropagation();
                openReplace();
                return true;
              }
              // Ctrl+G — open go-to-line.
              if (modifierPressed && key === "g") {
                event.preventDefault();
                event.stopPropagation();
                openGoToLine();
                return true;
              }
              // Escape — close search / goto-line when editor is focused.
              if (event.key === "Escape") {
                if (searchOpenRef.current) {
                  event.preventDefault();
                  setSearchOpen(false);
                  return true;
                }
                if (goToLineOpenRef.current) {
                  event.preventDefault();
                  setGoToLineOpen(false);
                  setGoToLineError(false);
                  return true;
                }
              }
              return false;
            },
            contextmenu: (event, view) => {
              event.preventDefault();
              const sel = view.state.selection.main;
              let startLine: number;
              let endLine: number;
              if (sel.from === sel.to) {
                const line = view.state.doc.lineAt(sel.from);
                startLine = line.number;
                endLine = line.number;
              } else {
                startLine = view.state.doc.lineAt(sel.from).number;
                endLine = view.state.doc.lineAt(sel.to).number;
                if (endLine < startLine) {
                  const tmp = startLine;
                  startLine = endLine;
                  endLine = tmp;
                }
              }
              const fileName = path.split(/[\\/]/).pop() || path;
              setContextMenu({ x: event.clientX, y: event.clientY, startLine, endLine, fileName });
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;

    let fileChangeUnsubscribe: (() => void) | null = null;
    let externalSyncTimer: number | null = null;
    let externalSyncInFlight = false;
    let externalSyncQueued = false;
    let fileWatcherStarted = false;

    const scheduleExternalSync = (retryCount = 0) => {
      if (externalSyncTimer !== null) window.clearTimeout(externalSyncTimer);
      externalSyncTimer = window.setTimeout(() => {
        externalSyncTimer = null;
        void syncExternalFile(retryCount);
      }, 120);
    };

    const syncExternalFile = async (retryCount = 0): Promise<void> => {
      if (disposed) return;
      if (savingRef.current) {
        scheduleExternalSync(retryCount);
        return;
      }
      if (externalSyncInFlight) {
        externalSyncQueued = true;
        return;
      }
      externalSyncInFlight = true;
      try {
        const result = await window.electronAPI.readFile(path);
        if (disposed) return;
        if (!result.success || result.binary || result.content == null) {
          if (retryCount < 2) scheduleExternalSync(retryCount + 1);
          return;
        }

        const nextContent = result.content;
        const currentContent = view.state.doc.toString();
        if (nextContent === currentContent) {
          originalContentRef.current = nextContent;
          externalConflictContentRef.current = null;
          if (dirtyRef.current) {
            dirtyRef.current = false;
            onDirtyChangeRef.current(false);
          }
          return;
        }

        // 不覆盖本地未保存编辑；等用户保存或关闭后再重新读取外部内容。
        if (dirtyRef.current) {
          if (externalConflictContentRef.current !== nextContent) {
            externalConflictContentRef.current = nextContent;
            const fileName = path.split(/[\\/]/).pop() || path;
            showFloatingToastMessage(`文件已被外部修改，未覆盖未保存内容：${fileName}`);
          }
          return;
        }

        const scrollTop = view.scrollDOM.scrollTop;
        const scrollLeft = view.scrollDOM.scrollLeft;
        originalContentRef.current = nextContent;
        externalConflictContentRef.current = null;
        initializingRef.current = true;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: nextContent },
          annotations: Transaction.addToHistory.of(false),
        });
        initializingRef.current = false;
        dirtyRef.current = false;
        onDocumentChangeRef.current(path, nextContent);
        requestAnimationFrame(() => {
          if (disposed) return;
          view.scrollDOM.scrollTop = scrollTop;
          view.scrollDOM.scrollLeft = scrollLeft;
        });
      } finally {
        externalSyncInFlight = false;
        if (externalSyncQueued && !disposed) {
          externalSyncQueued = false;
          scheduleExternalSync();
        }
      }
    };

    const startFileWatcher = () => {
      if (disposed || fileWatcherStarted) return;
      fileWatcherStarted = true;
      fileChangeUnsubscribe = window.electronAPI.onFileSystemChange((change) => {
        if (isSameFileTreePath(change.path, path)) scheduleExternalSync();
      });
      void window.electronAPI.watchPath(path, false).catch(() => undefined);
    };

    void window.electronAPI.readFile(path).then((result) => {
      if (disposed) return;
      if (!result.success) {
        readonlyRef.current = true;
        setReadOnly(true);
        setStatus("error");
        setStatusMessage(result.error || uiText.editor.readOnlyError);
        return;
      }
      if (result.binary) {
        readonlyRef.current = true;
        setReadOnly(true);
        setStatus("readonly");
        return;
      }
      const content = result.content ?? "";
      originalContentRef.current = content;
      initializingRef.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        // 文件载入是初始化，不是用户编辑。否则首次 Ctrl/Cmd+Z 会撤销
        // 从空文档到文件内容的这次 transaction，表现为整个文件被清空。
        annotations: Transaction.addToHistory.of(false),
      });
      initializingRef.current = false;
      onDocumentChangeRef.current(path, content);
      startFileWatcher();
      setStatus("ready");
      // TextMate 高亮：lua/cs 且文件在阈值内时启用（大文件自动回退 StreamLanguage）。
      const tmLanguage = getTextMateLanguage(path);
      if (tmLanguage) {
        const bytes = estimateTextBytes(content);
        const lineCount = content.split("\n").length;
        const enabled = bytes <= MAX_TM_BYTES && lineCount <= MAX_TM_LINES;
        view.dispatch({ effects: tmEnableEffect.of({ language: tmLanguage, enabled }) });
      }
      requestAnimationFrame(() => view.requestMeasure());
    });

    registerSaveRef.current(path, save);

    return () => {
      disposed = true;
      if (externalSyncTimer !== null) window.clearTimeout(externalSyncTimer);
      fileChangeUnsubscribe?.();
      void window.electronAPI.unwatchPath(path, false);
      registerSaveRef.current(path, save)();
      view.destroy();
      viewRef.current = null;
      readOnlyCompartmentRef.current = null;
      themeCompartmentRef.current = null;
      highlightCompartmentRef.current = null;
      langCompartmentRef.current = null;
    };
  }, [path, setReadOnly, save, openSearch, openGoToLine]);

  // 监听全局 data-theme 切换，动态更新编辑器主题与高亮配色。
  useEffect(() => {
    const root = document.documentElement;
    const handleThemeChange = () => {
      const view = viewRef.current;
      const themeC = themeCompartmentRef.current;
      const highlightC = highlightCompartmentRef.current;
      if (!view || !themeC || !highlightC) return;
      const colors = getColors();
      view.dispatch({
        effects: [
          themeC.reconfigure(buildEditorTheme(colors)),
          highlightC.reconfigure(syntaxHighlighting(buildHighlightStyle(colors))),
        ],
      });
    };
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "data-theme") {
          handleThemeChange();
          break;
        }
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // Keep the hidden editor's geometry correct when it becomes visible again.
  useEffect(() => {
    if (visible) viewRef.current?.requestMeasure();
  }, [visible]);

  // Close the context menu on outside pointer / resize.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  // Close go-to-line on clicking a blank area (anywhere outside the widget).
  useEffect(() => {
    if (!goToLineOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && goToLineWidgetRef.current?.contains(target)) return;
      setGoToLineOpen(false);
      setGoToLineError(false);
      viewRef.current?.focus();
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [goToLineOpen]);

  // ===== Global document-level keyboard shortcuts (like FilePreview) =====
  // Reliably intercepts Ctrl+F / Ctrl+G / Esc regardless of where focus is
  // (editor content, search input, goto input).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const paneEl = containerRef.current?.parentElement;
      // Only act when the pane is visible (not a hidden inactive keep-alive pane).
      if (!paneEl || paneEl.classList.contains("editor-pane-hidden")) return;
      // Only act when focus is inside this pane, or the search/goto widget is already open.
      const widgetOpen = searchOpenRef.current || goToLineOpenRef.current;
      const paneContainsFocus = paneEl.contains(document.activeElement);
      if (!widgetOpen && !paneContainsFocus) return;

      const modifierPressed = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLowerCase();

      // Alt+C — toggle case sensitivity (only when search is open)
      if (searchOpenRef.current && event.altKey && !event.ctrlKey && !event.metaKey && key === "c") {
        event.preventDefault();
        setSearchMatchCase((current) => !current);
        return;
      }
      // Alt+W — toggle whole word (only when search is open)
      if (searchOpenRef.current && event.altKey && !event.ctrlKey && !event.metaKey && key === "w") {
        event.preventDefault();
        setSearchWholeWord((current) => !current);
        return;
      }
      // Ctrl+F — open search
      if (modifierPressed && key === "f") {
        event.preventDefault();
        openSearch();
        return;
      }
      // Ctrl+H — open search + replace
      if (modifierPressed && key === "h") {
        event.preventDefault();
        openReplace();
        return;
      }
      // Ctrl+G — open go-to-line
      if (modifierPressed && key === "g") {
        event.preventDefault();
        openGoToLine();
        return;
      }
      // Escape — close widgets or context menu
      if (event.key === "Escape") {
        if (searchOpenRef.current) {
          event.preventDefault();
          setSearchOpen(false);
          viewRef.current?.focus();
          return;
        }
        if (goToLineOpenRef.current) {
          event.preventDefault();
          setGoToLineOpen(false);
          setGoToLineError(false);
          viewRef.current?.focus();
          return;
        }
        if (contextMenu) {
          event.preventDefault();
          setContextMenu(null);
          return;
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [contextMenu, openGoToLine, openSearch, openReplace]);

  return (
    <div className={`editor-pane${visible ? "" : " editor-pane-hidden"}`}>
      {status !== "ready" && (
        <div className="editor-pane-status">
          {status === "loading" && <span>{uiText.editor.loading}</span>}
          {status === "readonly" && <span>{uiText.editor.readOnlyBinary}</span>}
          {status === "error" && <span className="editor-pane-status-error">{statusMessage || uiText.editor.readOnlyError}</span>}
        </div>
      )}
      <div ref={containerRef} className="editor-pane-codemirror" />
      {searchOpen && (
        <div className="editor-find-widget" role="search">
          <div className="editor-find-grid">
            {/* 左侧折叠手柄：居中、无蓝底 */}
            <button
              type="button"
              className="editor-find-toggle"
              onClick={toggleReplace}
              title={replaceOpen ? "折叠替换 (Ctrl+H)" : "展开替换 (Ctrl+H)"}
              aria-label="切换替换"
              aria-expanded={replaceOpen}
            >
              {replaceOpen ? <ChevronDown size={16} strokeWidth={2} /> : <ChevronRight size={16} strokeWidth={2} />}
            </button>

            {/* 查找输入框：Aa / ab / .* 选项在框内右侧 */}
            <div
              className={`editor-find-input ${
                searchRegexError || (debouncedSearchQuery && !allFileLoading && displayMatches.length === 0)
                  ? "editor-find-input-error"
                  : ""
              }`}
            >
              <input
                ref={searchInputRef}
                className="editor-find-input-field"
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  // 搜索与滚动由 debouncedSearchQuery 驱动（停止输入 ~500ms 后执行），
                  // 这里只更新输入框文本，避免连续按键时每键一次正则匹配导致卡顿。
                }}
                onKeyDown={(event) => {
                  const modifierPressed = (event.ctrlKey || event.metaKey) && !event.altKey;
                  const key = event.key.toLowerCase();
                  if (modifierPressed && key === "f") {
                    event.preventDefault();
                    searchInputRef.current?.select();
                    return;
                  }
                  if (modifierPressed && key === "h") {
                    event.preventDefault();
                    openReplace();
                    return;
                  }
                  if (modifierPressed && key === "g") {
                    event.preventDefault();
                    openGoToLine();
                    return;
                  }
                  if (event.altKey && !event.ctrlKey && !event.metaKey && key === "c") {
                    event.preventDefault();
                    toggleMatchCase();
                    return;
                  }
                  if (event.altKey && !event.ctrlKey && !event.metaKey && key === "w") {
                    event.preventDefault();
                    toggleWholeWord();
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    // 立即应用防抖中的查询，回车导航基于最新关键词。
                    if (searchQuery !== debouncedSearchQuery) {
                      setDebouncedSearchQuery(searchQuery);
                    }
                    navigateSearch(event.shiftKey ? -1 : 1);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSearchOpen(false);
                    viewRef.current?.focus();
                  }
                }}
                placeholder="搜索"
                aria-label="搜索文件内容"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {/* 查找行右侧操作：计数 + 上下 + 更多 + 关闭 */}
            <div className="editor-find-actions">
              <span className="editor-find-count">
                {searchRegexError
                  ? "正则无效"
                  : searchScope === "all" && allFileLoading
                    ? "搜索中…"
                    : debouncedSearchQuery && !allFileLoading && displayMatches.length === 0
                      ? "无结果"
                      : activeMatchIndex >= 0
                        ? `第 ${activeMatchIndex + 1} 项，共 ${displayMatches.length} 项`
                        : `共 ${displayMatches.length} 项`}
              </span>
              <button
                type="button"
                className="editor-widget-btn"
                onClick={() => navigateSearch(-1)}
                disabled={displayMatches.length === 0}
                title="上一个匹配项 (Shift+Enter)"
                aria-label="上一个匹配项"
              >
                ↑
              </button>
              <button
                type="button"
                className="editor-widget-btn"
                onClick={() => navigateSearch(1)}
                disabled={displayMatches.length === 0}
                title="下一个匹配项 (Enter)"
                aria-label="下一个匹配项"
              >
                ↓
              </button>
              <button
                type="button"
                className="editor-widget-btn"
                onClick={() => {
                  setSearchOpen(false);
                  viewRef.current?.focus();
                }}
                title="关闭 (Esc)"
                aria-label="关闭搜索"
              >
                ×
              </button>
            </div>

            {/* 选项行：区分大小写 / 全字匹配 / 正则匹配 / 更多操作
                （未展开替换时为第二行，展开替换时为第三行） */}
            <div className="editor-find-options-row">
              <button
                type="button"
                className={`editor-find-option ${searchMatchCase ? "active" : ""}`}
                onClick={toggleMatchCase}
                aria-pressed={searchMatchCase}
                title="区分大小写 (Alt+C)"
              >
                <CaseSensitive size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className={`editor-find-option ${searchWholeWord ? "active" : ""}`}
                onClick={toggleWholeWord}
                aria-pressed={searchWholeWord}
                title="全字匹配 (Alt+W)"
              >
                <WholeWord size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className={`editor-find-option ${searchRegex ? "active" : ""}`}
                onClick={toggleRegex}
                aria-pressed={searchRegex}
                title="使用正则表达式"
              >
                <Regex size={14} strokeWidth={2} />
              </button>
              <select
                className="editor-find-scope-select"
                value={searchScope}
                onChange={(event) => {
                  const scope = event.target.value as "current" | "all";
                  setSearchScope(scope);
                  onSearchScopeChange(scope);
                  if (scope === "all") {
                    // 选“所有文件”：立即检索并在命中后弹出结果面板。
                    onRunAllFilesSearch(true);
                  }
                }}
                title="搜索范围"
                aria-label="搜索范围"
              >
                <option value="current">当前文件</option>
                <option value="all">所有文件</option>
              </select>
              {/* “所有文件”范围下手动关闭结果窗口后，在下拉框右侧显示“重新打开”按钮；
                  切回“当前文件”时该按钮随面板一并消失（窗口与下拉选项绑定）。 */}
              {searchScope === "all" && !allFilesPanelOpen && allFilesResultsCount > 0 && (
                <button
                  type="button"
                  className="editor-find-reopen"
                  onClick={onReopenAllFilesPanel}
                  title="重新打开搜索结果"
                  aria-label="重新打开搜索结果"
                >
                  <Search size={14} strokeWidth={2} />
                </button>
              )}
            </div>

            {/* 替换行（展开替换时显示） */}
            {replaceOpen && (
              <>
                <span className="editor-find-row-spacer editor-find-replace-order" aria-hidden="true" />
                <div className="editor-find-input editor-find-replace-row">
                  <input
                    ref={replaceInputRef}
                    className="editor-find-input-field"
                    value={replaceQuery}
                    onChange={(event) => setReplaceQuery(event.target.value)}
                    onKeyDown={(event) => {
                      const modifierPressed = (event.ctrlKey || event.metaKey) && !event.altKey;
                      const key = event.key.toLowerCase();
                      if (modifierPressed && key === "f") {
                        event.preventDefault();
                        openSearch();
                        return;
                      }
                      if (modifierPressed && key === "h") {
                        event.preventDefault();
                        openSearch();
                        return;
                      }
                      if (modifierPressed && key === "g") {
                        event.preventDefault();
                        openGoToLine();
                        return;
                      }
                      if (event.altKey && !event.ctrlKey && !event.metaKey && key === "p") {
                        event.preventDefault();
                        setPreserveCase((current) => !current);
                        return;
                      }
                      if (event.key === "Enter") {
                        event.preventDefault();
                        replaceOne();
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setSearchOpen(false);
                        viewRef.current?.focus();
                      }
                    }}
                    placeholder="替换"
                    aria-label="替换内容"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="editor-find-actions editor-find-replace-actions">
                  <button
                    type="button"
                    className="editor-widget-btn"
                    onClick={replaceOne}
                    disabled={searchMatches.length === 0}
                    title="替换 (Enter)"
                    aria-label="替换当前匹配项"
                  >
                    <Replace size={15} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="editor-widget-btn"
                    onClick={replaceAll}
                    disabled={searchMatches.length === 0}
                    title="全部替换"
                    aria-label="全部替换"
                  >
                    <ReplaceAll size={15} strokeWidth={2} />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {goToLineOpen && (
        <div
          ref={goToLineWidgetRef}
          className="editor-find-widget editor-go-to-line-widget"
        >
          <input
            ref={goToLineInputRef}
            className={`editor-widget-input ${goToLineError ? "editor-widget-input-error" : ""}`}
            value={goToLineValue}
            onChange={(event) => {
              setGoToLineValue(event.target.value);
              setGoToLineError(false);
            }}
            onKeyDown={(event) => {
              const modifierPressed = (event.ctrlKey || event.metaKey) && !event.altKey;
              const key = event.key.toLowerCase();
              if (modifierPressed && key === "f") {
                event.preventDefault();
                openSearch();
                return;
              }
              if (modifierPressed && key === "g") {
                event.preventDefault();
                goToLineInputRef.current?.select();
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                submitGoToLine();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setGoToLineOpen(false);
                setGoToLineError(false);
                viewRef.current?.focus();
              }
            }}
            placeholder="跳转到行"
            aria-label="跳转到行"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
          />
          {goToLineError && <span className="editor-go-to-line-error">行号无效</span>}
        </div>
      )}
      {contextMenu && (
        <div
          className="editor-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" className="editor-context-menu-btn" onClick={handleSendToChat}>
            <span className="editor-context-menu-title">发送到聊天</span>
            <span className="editor-context-menu-target">
              {contextMenu.fileName}:{contextMenu.startLine === contextMenu.endLine
                ? contextMenu.startLine
                : `${contextMenu.startLine}-${contextMenu.endLine}`}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
