const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = `
  import { EditorView, basicSetup } from "codemirror";
  import { EditorState, Transaction } from "@codemirror/state";
  import { keymap } from "@codemirror/view";
  import { redo, undo } from "@codemirror/commands";
  import { showMinimap } from "./src/lib/codemirror-minimap/index.js";

  let bubbledUndoCount = 0;
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      bubbledUndoCount += 1;
    }
  });

  const view = new EditorView({
    parent: document.querySelector("#editor"),
    state: EditorState.create({
      doc: "",
      extensions: [
        keymap.of([
          { key: "Mod-z", run: undo, preventDefault: true, stopPropagation: true },
          { key: "Shift-Mod-z", run: redo, preventDefault: true, stopPropagation: true },
          { key: "Mod-y", run: redo, preventDefault: true, stopPropagation: true },
        ]),
        basicSetup,
        showMinimap.of({
          create: () => ({ dom: document.createElement("div") }),
          displayText: "characters",
          showOverlay: "mouse-over",
          width: 80,
        }),
      ],
    }),
  });
  // Mirror EditorPane's asynchronous file load. This transaction must not
  // become the first undo history entry.
  view.dispatch({
    changes: { from: 0, insert: "const value = 1;\\n" },
    annotations: Transaction.addToHistory.of(false),
  });
  view.focus();
  window.undoTest = {
    prepareEdit() {
      view.dispatch({ selection: { anchor: 14, head: 15 } });
      view.focus();
    },
    state() {
      return {
        text: view.state.doc.toString(),
        bubbledUndoCount,
        bodyWidth: document.body.getBoundingClientRect().width,
        bodyHeight: document.body.getBoundingClientRect().height,
        editorConnected: view.dom.isConnected,
      };
    },
  };
`;

const bundle = buildSync({
  stdin: { contents: source, resolveDir: root, sourcefile: "editor-undo-e2e.ts" },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
}).outputFiles[0].text;

const html = `<!doctype html><html><head><meta charset="UTF-8"><style>
  html, body, #editor { width: 100%; height: 100%; margin: 0; }
  body { background: #fff; color: #111; }
  .cm-editor { height: 100%; }
</style></head><body><div id="editor"></div><script>${bundle}</script></body></html>`;

function sendShortcut(window, keyCode, modifiers) {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
}

app.whenReady().then(async () => {
  const errors = [];
  let rendererGone = false;
  const window = new BrowserWindow({ show: false, width: 1000, height: 700 });
  window.webContents.on("console-message", (event) => {
    if (event.level >= 2) errors.push(event.message);
  });
  window.webContents.on("render-process-gone", () => {
    rendererGone = true;
  });
  await window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);

  // The first undo after opening a file must be a no-op.
  sendShortcut(window, "Z", ["control"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterInitialUndo = await window.webContents.executeJavaScript("window.undoTest.state()");

  await window.webContents.executeJavaScript("window.undoTest.prepareEdit()");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "2" });
  window.webContents.sendInputEvent({ type: "char", keyCode: "2" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "2" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterEdit = await window.webContents.executeJavaScript("window.undoTest.state()");
  sendShortcut(window, "Z", ["control"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterEditUndo = await window.webContents.executeJavaScript("window.undoTest.state()");

  sendShortcut(window, "Y", ["control"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterRedo = await window.webContents.executeJavaScript("window.undoTest.state()");

  const result = {
    ok: !rendererGone
      && errors.length === 0
      && afterInitialUndo.text === "const value = 1;\n"
      && afterEdit.text === "const value = 2;\n"
      && afterEditUndo.text === "const value = 1;\n"
      && afterRedo.text === "const value = 2;\n"
      && afterInitialUndo.bubbledUndoCount === 0
      && afterEditUndo.bubbledUndoCount === 0
      && afterInitialUndo.bodyWidth > 0
      && afterInitialUndo.bodyHeight > 0
      && afterInitialUndo.editorConnected,
    rendererGone,
    errors,
    afterInitialUndo,
    afterEdit,
    afterEditUndo,
    afterRedo,
  };
  console.log(JSON.stringify(result, null, 2));
  window.destroy();
  app.exit(result.ok ? 0 : 1);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
