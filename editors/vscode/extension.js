const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const DISCOVERY_FILENAME = "editor-bridge.json";
const SEND_PATH = "/api/v1/editor/send";
const STATUS_PATH = "/api/v1/editor/status";
const TOKEN_HEADER = "x-hpp-bridge-token";
const MAX_TEXT_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

function discoveryCandidates() {
  const candidates = [];
  const override = vscode.workspace.getConfiguration("hpp").get("discoveryPath");
  if (override) candidates.push(override);
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    candidates.push(path.join(appData, "hpp", "hpp-data", DISCOVERY_FILENAME));
  } else if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Application Support", "hpp", "hpp-data", DISCOVERY_FILENAME));
  } else {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    candidates.push(path.join(config, "hpp", "hpp-data", DISCOVERY_FILENAME));
  }
  return candidates;
}

function readDiscovery() {
  for (const candidate of discoveryCandidates()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (parsed && parsed.port && parsed.token) return parsed;
    } catch {
      // 文件不存在或还没写完，试下一个候选路径。
    }
  }
  return null;
}

function bridgeRequest(discovery, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request({
      host: discovery.host || "127.0.0.1",
      port: discovery.port,
      path: requestPath,
      method,
      timeout: REQUEST_TIMEOUT_MS,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": payload.length, [TOKEN_HEADER]: discovery.token }
        : { [TOKEN_HEADER]: discovery.token },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          reject(new Error(`Hpp 返回了无法解析的响应：${text.slice(0, 200)}`));
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed && parsed.ok) resolve(parsed);
        else reject(new Error((parsed && parsed.error) || `Hpp 返回 ${res.statusCode}`));
      });
    });
    req.on("timeout", () => req.destroy(new Error("连接 Hpp 超时")));
    req.on("error", (error) => reject(error.code === "ECONNREFUSED"
      ? new Error("Hpp 没有在监听（可能已经退出），重新打开 Hpp 后再试。")
      : error));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 未保存的缓冲区、非本地文件（SSH/WSL/虚拟文档）都读不到磁盘正确内容，
 * 必须把字面文本带上；能读盘的情况只发路径+行号，避免草稿里塞进整段代码。
 */
function needsLiteralText(document) {
  return document.isDirty || document.uri.scheme !== "file" || document.isUntitled;
}

async function deliverAll(payloads) {
  const discovery = readDiscovery();
  if (!discovery) {
    void vscode.window.showErrorMessage("Hpp：找不到桥接配置 editor-bridge.json，请确认 Hpp 正在运行。");
    return false;
  }
  for (let index = 0; index < payloads.length; index += 1) {
    // 批量发送只在第一项抢一次焦点，后续保留 Hpp 里刚插入的内容。
    const payload = { ...payloads[index], focus: index === 0 };
    try {
      await bridgeRequest(discovery, "POST", SEND_PATH, payload);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Hpp：发送 ${path.basename(payload.path)} 失败（${error instanceof Error ? error.message : String(error)}）。`,
      );
      return false;
    }
  }
  return true;
}

async function deliver(payload, done) {
  const ok = await deliverAll([payload]);
  if (ok) void vscode.window.setStatusBarMessage(done, 2500);
  return ok;
}

async function sendActiveEditor(kind) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Hpp：当前没有活动的编辑器。");
    return;
  }
  const document = editor.document;
  if (document.isUntitled) {
    void vscode.window.showWarningMessage("Hpp：未保存的新文件没有路径，先保存再发送。");
    return;
  }

  const selection = editor.selection;
  const empty = selection.isEmpty;
  if (kind === "selection" && empty) {
    void vscode.window.showWarningMessage("Hpp：先选中一段代码再发送。");
    return;
  }

  let startLine;
  let endLine;
  let text;
  if (kind === "line") {
    // 右键会先把光标移到点击位置，所以 active.line 就是点中的那一行。
    startLine = selection.active.line + 1;
    endLine = startLine;
    text = document.lineAt(selection.active.line).text;
  } else if (kind === "selection") {
    startLine = selection.start.line + 1;
    // 选中到下一行行首时 VSCode 的 end.line 会多算一行，这里按字符位置回退。
    endLine = selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line
      : selection.end.line + 1;
    text = document.getText(selection);
  } else {
    startLine = 1;
    endLine = Math.max(document.lineCount, 1);
    text = document.getText();
  }

  // 协议只有 selection/file/folder：文件带字面内容时必须走 selection，
  // 否则 Hpp 只拿到路径、读盘会读到未保存前的旧版本。
  const literal = needsLiteralText(document);
  const oversized = literal && Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES;
  const payloadKind = kind !== "file" || (literal && !oversized) ? "selection" : "file";
  const payload = {
    version: 1,
    client: "vscode",
    kind: payloadKind,
    path: document.uri.fsPath || document.fileName,
    startLine,
    endLine,
    language: document.languageId,
  };

  if (literal) {
    if (!oversized) payload.text = text;
    else if (kind === "file") void vscode.window.showWarningMessage("Hpp：内容超过 512 KB，已改为只发送路径引用。");
    else void vscode.window.showWarningMessage("Hpp：内容超过 512 KB，已只发送路径和行号；未保存的改动不会包含在内。");
  }

  const done = kind === "file"
    ? `已发送 ${path.basename(payload.path)} 到 Hpp`
    : kind === "line" ? `已发送第 ${startLine} 行到 Hpp` : `已发送 ${endLine - startLine + 1} 行到 Hpp`;
  await deliver(payload, done);
}

/**
 * 资源管理器右键文件：已保存的本地文件只发路径；未保存或非本地文件带字面内容，
 * 走 selection 让 Hpp 按代码块插入。命令面板调用（无 uri）时退回活动编辑器。
 * 资源管理器多选时 VSCode 会传入 selectedUris，逐个发送全部选中项。
 */
async function sendFile(uri, selectedUris) {
  if (!uri) {
    await sendActiveEditor("file");
    return;
  }
  const uris = Array.isArray(selectedUris) && selectedUris.length ? selectedUris : [uri];
  await sendExplorerUris(uris);
}

const findDocument = (uri) => vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());

async function isDirectory(uri) {
  if (findDocument(uri)) return false;
  if (uri.scheme === "file" && uri.fsPath) {
    try {
      return fs.statSync(uri.fsPath).isDirectory();
    } catch {
      return false;
    }
  }
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

async function buildFilePayload(uri) {
  const document = findDocument(uri);
  if (document && document.isUntitled) {
    void vscode.window.showWarningMessage("Hpp：未保存的新文件没有路径，已跳过。");
    return null;
  }
  const filePath = document ? (document.uri.fsPath || document.fileName) : (uri.fsPath || uri.path);
  if (!filePath) {
    void vscode.window.showWarningMessage("Hpp：有文件没有可发送的本地路径，已跳过。");
    return null;
  }
  const language = document ? document.languageId : undefined;
  if (!(document ? needsLiteralText(document) : uri.scheme !== "file")) {
    return { version: 1, client: "vscode", kind: "file", path: filePath, ...(language ? { language } : {}) };
  }

  let text;
  try {
    text = document ? document.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch (error) {
    void vscode.window.showErrorMessage(`Hpp：读取文件失败（${error instanceof Error ? error.message : String(error)}）。`);
    return null;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    void vscode.window.showWarningMessage(`Hpp：${path.basename(filePath)} 超过 512 KB，无法携带未保存或远程内容，已跳过。`);
    return null;
  }
  const lineCount = document ? Math.max(document.lineCount, 1) : text.split(/\r?\n/).length;
  return {
    version: 1,
    client: "vscode",
    kind: "selection",
    path: filePath,
    startLine: 1,
    endLine: lineCount,
    text,
    ...(language ? { language } : {}),
  };
}

/** 资源管理器里选中的每一项都发过去：文件夹发引用，文件按是否本地/已保存决定发路径还是内容。 */
async function sendExplorerUris(uris) {
  const payloads = [];
  let skipped = 0;
  for (const uri of uris) {
    if (await isDirectory(uri)) {
      const folderPath = uri.fsPath || uri.path;
      if (!folderPath) {
        skipped += 1;
        continue;
      }
      payloads.push({ version: 1, client: "vscode", kind: "folder", path: folderPath });
      continue;
    }
    const payload = await buildFilePayload(uri);
    if (payload) payloads.push(payload);
    else skipped += 1;
  }

  if (!payloads.length) return;
  if (payloads.length === 1) {
    await deliver(payloads[0], `已发送 ${path.basename(payloads[0].path)} 到 Hpp`);
    return;
  }
  if (await deliverAll(payloads)) {
    void vscode.window.setStatusBarMessage(
      `已发送 ${payloads.length} 项到 Hpp${skipped ? `，跳过 ${skipped} 项` : ""}`,
      3000,
    );
  }
}

/**
 * 资源管理器右键：把整个文件夹作为引用发给 Hpp（不读内容，只发路径）。
 */
async function sendFolder(uri, selectedUris) {
  const uris = Array.isArray(selectedUris) && selectedUris.length ? selectedUris : (uri ? [uri] : []);
  if (!uris.length) {
    void vscode.window.showWarningMessage("Hpp：请在资源管理器里右键一个文件或文件夹。");
    return;
  }
  await sendExplorerUris(uris);
}

async function showStatus() {
  const discovery = readDiscovery();
  if (!discovery) {
    void vscode.window.showWarningMessage("Hpp：没有找到 editor-bridge.json。");
    return;
  }
  try {
    const status = await bridgeRequest(discovery, "GET", STATUS_PATH);
    void vscode.window.showInformationMessage(
      `Hpp 已连接：${discovery.host || "127.0.0.1"}:${discovery.port}（协议 v${status.protocolVersion}，pid ${status.pid}）`,
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`Hpp：${error instanceof Error ? error.message : String(error)}`);
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("hpp.sendSelection", () => sendActiveEditor("selection")),
    vscode.commands.registerCommand("hpp.sendLine", () => sendActiveEditor("line")),
    vscode.commands.registerCommand("hpp.sendFile", (uri, selectedUris) => sendFile(uri, selectedUris)),
    vscode.commands.registerCommand("hpp.sendFolder", (uri, selectedUris) => sendFolder(uri, selectedUris)),
    vscode.commands.registerCommand("hpp.showStatus", () => showStatus()),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
