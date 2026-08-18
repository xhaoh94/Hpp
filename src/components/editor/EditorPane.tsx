import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState, EditorSelection, Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, keymap } from "@codemirror/view";
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
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { uiText } from "@/i18n/text";
import { useChatStore } from "@/stores/chat-store";
import { requestComposerInsert } from "@/lib/composer-insert-event";
import {
  findTextMatches,
  getNextSearchMatchIndex,
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
  /** Called after a successful save. */
  onSaved: (path: string) => void;
  /** Called when a save fails. */
  onSaveError: (path: string, error: string) => void;
  /** Register an imperative save function so the parent can save before closing. */
  registerSave: (path: string, fn: () => Promise<boolean>) => () => void;
  /** TextMate 高亮运行时状态（状态栏指示用）。 */
  onTmStatus?: (status: TmStatus) => void;
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
        padding: "0 10px 0 14px",
        minWidth: "34px",
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
  onSaved,
  onSaveError,
  registerSave,
  onTmStatus,
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
  const [status, setStatus] = useState<EditorPaneStatus>("loading");
  const [statusMessage, setStatusMessage] = useState("");
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const addPendingFile = useChatStore((state) => state.addPendingFile);

  // ===== Search & Go-to-line state =====
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchCase, setSearchMatchCase] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState("");
  const [goToLineError, setGoToLineError] = useState(false);
  // Bumped on doc edits while search is open, to refresh match positions.
  const [docVersion, setDocVersion] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const goToLineInputRef = useRef<HTMLInputElement>(null);
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  const goToLineOpenRef = useRef(false);
  goToLineOpenRef.current = goToLineOpen;

  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onSaveErrorRef = useRef(onSaveError);
  onSaveErrorRef.current = onSaveError;
  const registerSaveRef = useRef(registerSave);
  registerSaveRef.current = registerSave;
  const onTmStatusRef = useRef(onTmStatus);
  onTmStatusRef.current = onTmStatus;

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
    if (!searchOpen || !searchQuery) return [];
    const view = viewRef.current;
    if (!view) return [];
    const lines = view.state.doc.toString().split("\n");
    return findTextMatches(lines, searchQuery, {
      matchCase: searchMatchCase,
      wholeWord: searchWholeWord,
    });
  }, [searchOpen, searchQuery, searchMatchCase, searchWholeWord, docVersion]);

  // Reset active match index whenever the match set changes.
  useEffect(() => {
    setActiveMatchIndex(searchMatches.length > 0 ? 0 : -1);
  }, [searchMatches]);

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
        activeIndex: activeMatchIndex,
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
  useEffect(() => {
    if (activeMatchIndex < 0) return;
    const match = searchMatches[activeMatchIndex];
    if (!match) return;
    const view = viewRef.current;
    if (!view) return;
    const line = view.state.doc.line(match.lineNumber);
    const from = line.from + match.startColumn;
    view.dispatch({
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }, [activeMatchIndex, searchMatches]);

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

  const openSearch = useCallback(() => {
    setGoToLineOpen(false);
    setGoToLineError(false);
    setSearchOpen(true);
  }, []);

  const openGoToLine = useCallback(() => {
    setSearchOpen(false);
    setGoToLineValue("");
    setGoToLineError(false);
    setGoToLineOpen(true);
  }, []);

  const navigateSearch = useCallback(
    (direction: 1 | -1) => {
      if (searchMatches.length === 0) return;
      const nextIndex = getNextSearchMatchIndex(activeMatchIndex, searchMatches.length, direction);
      setActiveMatchIndex(nextIndex);
    },
    [activeMatchIndex, searchMatches],
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
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
              key: "Mod-f",
              run: () => {
                openSearch();
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
            keydown: (event) => {
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
      });
      initializingRef.current = false;
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
  }, [contextMenu, openGoToLine, openSearch]);

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
          <input
            ref={searchInputRef}
            className={`editor-widget-input ${searchQuery && searchMatches.length === 0 ? "editor-widget-input-error" : ""}`}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              const modifierPressed = (event.ctrlKey || event.metaKey) && !event.altKey;
              const key = event.key.toLowerCase();
              if (modifierPressed && key === "f") {
                event.preventDefault();
                searchInputRef.current?.select();
                return;
              }
              if (modifierPressed && key === "g") {
                event.preventDefault();
                openGoToLine();
                return;
              }
              if (event.altKey && !event.ctrlKey && !event.metaKey && key === "c") {
                event.preventDefault();
                setSearchMatchCase((current) => !current);
                return;
              }
              if (event.altKey && !event.ctrlKey && !event.metaKey && key === "w") {
                event.preventDefault();
                setSearchWholeWord((current) => !current);
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
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
          <button
            type="button"
            className={`editor-search-option-btn ${searchMatchCase ? "active" : ""}`}
            onClick={() => setSearchMatchCase((current) => !current)}
            title="区分大小写 (Alt+C)"
            aria-label="区分大小写"
            aria-pressed={searchMatchCase}
          >
            Aa
          </button>
          <button
            type="button"
            className={`editor-search-option-btn editor-whole-word ${searchWholeWord ? "active" : ""}`}
            onClick={() => setSearchWholeWord((current) => !current)}
            title="全字匹配 (Alt+W)"
            aria-label="全字匹配"
            aria-pressed={searchWholeWord}
          >
            ab
          </button>
          <span className="editor-find-count">
            {searchQuery && searchMatches.length === 0
              ? "无结果"
              : `${searchMatches.length > 0 ? activeMatchIndex + 1 : 0}/${searchMatches.length}`}
          </span>
          <button
            type="button"
            className="editor-widget-btn"
            onClick={() => navigateSearch(-1)}
            disabled={searchMatches.length === 0}
            title="上一个匹配项 (Shift+Enter)"
            aria-label="上一个匹配项"
          >
            ↑
          </button>
          <button
            type="button"
            className="editor-widget-btn"
            onClick={() => navigateSearch(1)}
            disabled={searchMatches.length === 0}
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
      )}
      {goToLineOpen && (
        <div className="editor-find-widget editor-go-to-line-widget">
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
          <button
            type="button"
            className="editor-widget-btn"
            onClick={() => {
              setGoToLineOpen(false);
              setGoToLineError(false);
              viewRef.current?.focus();
            }}
            title="关闭 (Esc)"
            aria-label="关闭跳行"
          >
            ×
          </button>
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
