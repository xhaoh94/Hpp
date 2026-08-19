import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import paneSource from "./EditorPane.tsx?raw";
import areaSource from "./EditorArea.tsx?raw";
import expandSearchListSource from "./ExpandSearchList.tsx?raw";
import editorCssSource from "./EditorArea.css?raw";
import layoutCssSource from "../layout/Layout.css?raw";
import filePreviewSource from "../../lib/file-preview-code.ts?raw";
import textSearchSource from "../../lib/text-search.ts?raw";
import minimapSource from "../../lib/codemirror-minimap/index.js?raw";

const editorCss = readFileSync(resolve(process.cwd(), "src/components/editor/EditorArea.css"), "utf8");
const layoutCss = readFileSync(resolve(process.cwd(), "src/components/layout/Layout.css"), "utf8");

describe("editor pane (CodeMirror wrapper)", () => {
  it("is an uncontrolled CodeMirror 6 editor (no value prop, never re-mounts text through React)", () => {
    expect(paneSource).toContain("new EditorView({");
    expect(paneSource).toContain("EditorState.create({");
    expect(paneSource).not.toContain('value: "');
    expect(paneSource).toContain("EditorView.domEventHandlers");
  });

  it("reports dirty based on comparison with original content, clearing the flag on undo", () => {
    expect(paneSource).toContain("dirtyRef.current");
    expect(paneSource).toContain("update.docChanged");
    expect(paneSource).toContain("originalContentRef.current");
    expect(paneSource).toContain("const isDirty = currentContent !== originalContentRef.current");
    expect(paneSource).toContain("onDirtyChangeRef.current(isDirty)");
  });

  it("updates the original content baseline after a successful save", () => {
    expect(paneSource).toContain("originalContentRef.current = content");
  });

  it("keeps initial file loading out of undo history and dirty tracking", () => {
    expect(paneSource).toContain("initializingRef.current");
    expect(paneSource).toContain("!initializingRef.current");
    expect(paneSource).toContain("annotations: Transaction.addToHistory.of(false)");
  });

  it("saves with Ctrl/Cmd+S through the writeFile IPC bridge", () => {
    expect(paneSource).toContain("key === \"s\"");
    expect(paneSource).toContain("event.key.toLowerCase()");
    expect(paneSource).toContain("(event.ctrlKey || event.metaKey)");
    expect(paneSource).toContain("window.electronAPI.writeFile");
    expect(paneSource).toContain("event.stopPropagation()");
    expect(paneSource).toContain("onSavedRef.current(path)");
  });

  it("keeps undo and redo inside CodeMirror without bubbling to application shortcuts", () => {
    expect(paneSource).toContain('key: "Mod-z"');
    expect(paneSource).toContain('key: "Shift-Mod-z"');
    expect(paneSource).toContain('key: "Mod-y"');
    expect(paneSource).toContain("run: undo");
    expect(paneSource).toContain("run: redo");
    expect(paneSource).toContain("stopPropagation: true");
    expect(paneSource).toContain("if (tr.docChanged) return { matches: [], activeIndex: -1 }");
  });

  it("discards stale minimap work after undo, redo, or editor teardown", () => {
    expect(minimapSource).toContain("const generation = ++this._updateGeneration");
    expect(minimapSource).toContain("generation !== this._updateGeneration");
    expect(minimapSource).toContain("this.view.state !== state");
    expect(minimapSource).toContain("this.text.destroy()");
  });

  it("switches to read-only via a Compartment for binary/error files", () => {
    expect(paneSource).toContain("new Compartment()");
    expect(paneSource).toContain("readOnlyCompartment.of(EditorState.readOnly.of(false))");
    expect(paneSource).toContain("readonlyRef.current = true");
  });

  it("keeps the hidden editor measured when it becomes visible again", () => {
    expect(paneSource).toContain('className={`editor-pane${visible ? "" : " editor-pane-hidden"}`}');
    expect(paneSource).toContain("viewRef.current?.requestMeasure()");
  });

  it("exposes an imperative save function for save-and-close flows", () => {
    expect(paneSource).toContain("registerSave");
    expect(paneSource).toContain("registerSaveRef");
  });

  it("fills the search box with the current selection when opening find via Ctrl+F", () => {
    expect(paneSource).toContain("openSearch");
    expect(paneSource).toContain("selection.main");
    expect(paneSource).toContain("sliceDoc");
    expect(paneSource).toContain('setSearchQuery(selectedText)');
    expect(paneSource).toContain('sel.from !== sel.to');
  });

  it("maps known extensions to CodeMirror language support", () => {
    expect(paneSource).toContain("javascript()");
    expect(paneSource).toContain("json()");
    expect(paneSource).toContain("css()");
    expect(paneSource).toContain("markdown()");
  });

  it("loads the initial file from the readFile bridge (not from React state)", () => {
    expect(paneSource).toContain("window.electronAPI.readFile(path)");
    expect(paneSource).toContain("changes: { from: 0, to: view.state.doc.length");
  });

  it("themes the editor with hardcoded VSCode color palettes for both themes", () => {
    expect(paneSource).toContain("DARK_COLORS");
    expect(paneSource).toContain("LIGHT_COLORS");
    expect(paneSource).toContain("buildHighlightStyle");
    expect(paneSource).toContain("buildEditorTheme");
    expect(paneSource).toContain("keyword: \"#569cd6\"");
    expect(paneSource).toContain("keyword: \"#0000ff\"");
    expect(paneSource).toContain("string: \"#a31515\"");
    expect(paneSource).toContain("string: \"#ce9178\"");
    expect(paneSource).toContain("data-theme");
  });
});

describe("editor area (tab chrome + keep-alive)", () => {
  it("renders every open tab keep-alive, hiding inactive panes instead of unmounting", () => {
    expect(areaSource).toContain("tabs.map((tab) =>");
    expect(areaSource).toContain("visible={tab.key === activeKey}");
    expect(paneSource).toContain("editor-pane-hidden");
  });

  it("sorts pinned tabs to the front of the tab bar", () => {
    expect(areaSource).toContain("const pinnedTabs = tabs.filter((tab) => tab.pinned)");
    expect(areaSource).toContain("const regularTabs = tabs.filter((tab) => !tab.pinned)");
  });

  it("offers the VSCode-style tab context menu actions", () => {
    expect(areaSource).toContain("togglePin");
    expect(areaSource).toContain("closeOthers");
    expect(areaSource).toContain("closeSaved");
    expect(areaSource).toContain("closeAll");
  });

  it("confirms before closing a dirty tab, with save / discard / cancel", () => {
    expect(areaSource).toContain("setConfirmClose({ key })");
    expect(areaSource).toContain("saveAndClose");
    expect(areaSource).toContain("discardAndClose");
    expect(areaSource).toContain("if (tab.dirty)");
  });

  it("confirms bulk closes when unsaved tabs would be discarded", () => {
    expect(areaSource).toContain("showAppConfirm(message");
    expect(areaSource).toContain("closeOthersConfirm");
    expect(areaSource).toContain("closeAllConfirm");
  });

  it("virtualizes all-files results with synchronous positioning during scrollbar drags", () => {
    expect(areaSource).toContain('from "./ExpandSearchList"');
    expect(expandSearchListSource).toContain("buildExpandSearchRows(groups, collapsed)");
    expect(expandSearchListSource).toContain("getExpandSearchVisibleRows(model");
    expect(expandSearchListSource).toContain("flushSync(() =>");
    expect(expandSearchListSource).toContain("top: row.top");
    expect(expandSearchListSource).toContain("style={{ height: model.totalHeight }}");
    expect(expandSearchListSource).not.toContain("useVirtualizer");
    expect(expandSearchListSource).not.toContain("translateY");
  });
});

describe("editor mode layout wiring", () => {
  it("switches the main grid to a 4-column VSCode layout", () => {
    expect(layoutCss).toContain(".layout-content.editor-mode");
    expect(layoutCss).toContain("48px var(--sidebar-width, 250px) minmax(0, 1fr) var(--editor-chat-width, 380px)");
    expect(layoutCss).toContain(".layout-content.editor-mode > .chat-panel");
    expect(layoutCss).toContain("grid-column: 4");
    expect(layoutCss).toContain(".editor-area {");
    expect(layoutCss).toContain("grid-column: 3;");
  });

  it("hides the editor area entirely in preview mode (never unmounts editors)", () => {
    expect(layoutCss).toContain(".layout-content:not(.editor-mode) .editor-area {");
    expect(layoutCss).toContain("display: none;");
  });
});

describe("search supports regex + VSCode-style replace (Ctrl+H)", () => {
  it("findTextMatches honors a regex option and isRegexValid guards invalid patterns", () => {
    expect(textSearchSource).toContain("options.regex");
    expect(textSearchSource).toContain("export function isRegexValid");
  });

  it("opens the replace row via Ctrl+H (openReplace / Mod-h) and keeps the selection-fill", () => {
    expect(paneSource).toContain("openReplace");
    expect(paneSource).toContain('key: "Mod-h"');
    expect(paneSource).toContain("setReplaceOpen(true)");
  });

  it("implements replace-one / replace-all with preserve-case (Ab) support", () => {
    expect(paneSource).toContain("replaceOne");
    expect(paneSource).toContain("replaceAll");
    expect(paneSource).toContain("applyPreserveCase");
    expect(paneSource).toContain("preserveCase");
  });

  it("renders the VSCode-style two-row widget (left collapse toggle + replace row)", () => {
    expect(paneSource).toContain("editor-find-toggle");
    expect(paneSource).toContain("editor-find-grid");
    expect(paneSource).toContain("editor-find-replace-row");
    expect(paneSource).toContain("editor-find-scope-select");
    expect(paneSource).toContain("CaseSensitive");
    expect(paneSource).toContain("WholeWord");
    expect(paneSource).toContain("Regex");
    expect(paneSource).toContain("ReplaceAll");
  });
});
