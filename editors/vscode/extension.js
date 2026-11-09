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

  const payload = {
    version: 1,
    client: "vscode",
    // 协议只有 selection/file 两种；"line" 就是起止行相同的一次选区。
    kind: kind === "file" ? "file" : "selection",
    path: document.uri.fsPath || document.fileName,
    startLine,
    endLine,
    language: document.languageId,
  };

  if (needsLiteralText(document)) {
    if (Buffer.byteLength(text, "utf8") <= MAX_TEXT_BYTES) payload.text = text;
    else void vscode.window.showWarningMessage("Hpp：内容超过 512 KB，已只发送路径和行号，Hpp 将读取磁盘上的版本。");
  }

  const discovery = readDiscovery();
  if (!discovery) {
    void vscode.window.showErrorMessage("Hpp：找不到桥接配置 editor-bridge.json，请确认 Hpp 正在运行。");
    return;
  }

  try {
    await bridgeRequest(discovery, "POST", SEND_PATH, payload);
    const done = kind === "file"
      ? "已发送文件到 Hpp"
      : kind === "line" ? `已发送第 ${startLine} 行到 Hpp` : `已发送 ${endLine - startLine + 1} 行到 Hpp`;
    void vscode.window.setStatusBarMessage(done, 2500);
  } catch (error) {
    void vscode.window.showErrorMessage(`Hpp：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 资源管理器右键：把整个文件夹作为引用发给 Hpp（不读内容，只发路径）。
 */
async function sendFolder(uri) {
  const folderPath = uri && uri.fsPath ? uri.fsPath : "";
  if (!folderPath) {
    void vscode.window.showWarningMessage("Hpp：请在资源管理器里右键一个文件夹。");
    return;
  }
  const discovery = readDiscovery();
  if (!discovery) {
    void vscode.window.showErrorMessage("Hpp：找不到桥接配置 editor-bridge.json，请确认 Hpp 正在运行。");
    return;
  }
  try {
    await bridgeRequest(discovery, "POST", SEND_PATH, {
      version: 1,
      client: "vscode",
      kind: "folder",
      path: folderPath,
    });
    void vscode.window.setStatusBarMessage("已发送文件夹到 Hpp", 2500);
  } catch (error) {
    void vscode.window.showErrorMessage(`Hpp：${error instanceof Error ? error.message : String(error)}`);
  }
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
    vscode.commands.registerCommand("hpp.sendFile", () => sendActiveEditor("file")),
    vscode.commands.registerCommand("hpp.sendFolder", (uri) => sendFolder(uri)),
    vscode.commands.registerCommand("hpp.showStatus", () => showStatus()),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
