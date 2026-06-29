"use strict";
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const promises = require("fs/promises");
const os = require("os");
const child_process = require("child_process");
const string_decoder = require("string_decoder");
const http = require("http");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const http__namespace = /* @__PURE__ */ _interopNamespaceDefault(http);
function registerFileHandlers() {
  electron.ipcMain.handle("fs:readDirectory", async (_event, dirPath) => {
    try {
      const entries = await promises.readdir(dirPath, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(dirPath, entry.name);
        const entryData = {
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? "folder" : "file"
        };
        if (entry.isDirectory()) {
          entryData.children = [];
        }
        result.push(entryData);
      }
      result.sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return result;
    } catch (err) {
      return [];
    }
  });
  electron.ipcMain.handle("fs:readFile", async (_event, filePath) => {
    try {
      const content = await promises.readFile(filePath, "utf-8");
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle("fs:fileExists", async (_event, filePath) => {
    try {
      await promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  });
  electron.ipcMain.handle(
    "fs:searchFiles",
    async (_event, dirPath, query) => {
      const results = [];
      const maxDepth = 5;
      async function walk(dir, depth) {
        if (depth > maxDepth) return;
        try {
          const entries = await promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            if (["node_modules", ".git", "dist", "build", "__pycache__"].includes(
              entry.name
            ))
              continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.name.toLowerCase().includes(query.toLowerCase())) {
              results.push({
                name: entry.name,
                path: fullPath,
                type: entry.isDirectory() ? "folder" : "file"
              });
            }
            if (entry.isDirectory()) {
              await walk(fullPath, depth + 1);
            }
          }
        } catch {
        }
      }
      await walk(dirPath, 0);
      return results.slice(0, 50);
    }
  );
  electron.ipcMain.handle("fs:openDirectory", async (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    const result = await electron.dialog.showOpenDialog(win, {
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: "" };
    }
    return { canceled: false, path: result.filePaths[0] };
  });
  electron.ipcMain.handle("fs:getHomeDir", () => {
    return os.homedir();
  });
  electron.ipcMain.handle("fs:isCommandAvailable", (_event, command) => {
    try {
      const cmd = process.platform === "win32" ? `where ${command}` : `which -a ${command}`;
      const result = child_process.execSync(cmd, { encoding: "utf-8" }).trim();
      const lines = result.split("\n").map((l) => l.trim()).filter(Boolean);
      return lines.some((p) => !p.includes("node_modules"));
    } catch {
      return false;
    }
  });
}
const dataDir = path.join(electron.app.getPath("userData"), "hpp-data");
async function ensureDataDir() {
  try {
    await promises.mkdir(dataDir, { recursive: true });
  } catch {
  }
}
function registerStoreHandlers() {
  electron.ipcMain.handle("store:load", async (_event, key) => {
    try {
      await ensureDataDir();
      const filePath = path.join(dataDir, `${key}.json`);
      const content = await promises.readFile(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle(
    "store:save",
    async (_event, key, data) => {
      try {
        await ensureDataDir();
        const filePath = path.join(dataDir, `${key}.json`);
        await promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  );
}
const TOOL_KIND_ALIASES = {
  read_file: ["read", "readfile", "read_file", "view", "view_file", "open_file"],
  list_dir: [
    "list",
    "list_dir",
    "list_directory",
    "ls",
    "readdir",
    "read_dir",
    "read_directory",
    "readfolder",
    "read_folder",
    "tree",
    "directory_tree"
  ],
  write_file: ["write", "writefile", "write_file", "create", "create_file"],
  edit_file: [
    "edit",
    "edit_file",
    "multiedit",
    "multi_edit",
    "apply_patch",
    "patch",
    "str_replace_editor",
    "str_replace_based_edit_tool",
    "replace_in_file"
  ],
  run_command: ["bash", "shell", "sh", "powershell", "pwsh", "cmd", "run_command", "execute_command", "terminal"],
  search_files: ["glob", "find", "fd", "file_search", "search_files"],
  search_text: ["grep", "rg", "search", "search_text", "content_search"],
  web_fetch: ["webfetch", "web_fetch", "fetch", "fetch_url"],
  web_search: ["websearch", "web_search", "search_web"],
  question: ["ask_user", "ask_user_question", "user_ask_question", "droid.ask_user"]
};
const normalizeName = (value) => String(value || "").trim().toLowerCase();
const getNestedValue = (value, path2) => {
  let current = value;
  for (const key of path2) {
    if (current === void 0 || current === null) return void 0;
    current = current[key];
  }
  return current;
};
const findFirstString = (value, paths) => {
  for (const path2 of paths) {
    const found = getNestedValue(value, path2);
    if (typeof found === "string" && found.trim()) return found;
  }
  return "";
};
const tryParseJson = (value) => {
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("{") && !trimmed.startsWith("[")) return void 0;
  try {
    return JSON.parse(trimmed);
  } catch {
    return void 0;
  }
};
const unwrapToolText = (value, depth = 0) => {
  if (value === void 0 || value === null) return void 0;
  if (typeof value === "string") {
    const parsed = depth < 2 ? tryParseJson(value) : void 0;
    if (parsed !== void 0) {
      const parsedText = unwrapToolText(parsed, depth + 1);
      if (parsedText !== void 0) return parsedText;
    }
    return value;
  }
  if (typeof value !== "object") return void 0;
  const anyValue = value;
  if (Array.isArray(anyValue.content)) {
    const text = anyValue.content.map((item) => {
      if (typeof item === "string") return item;
      if (item?.type === "text" && typeof item.text === "string") return item.text;
      if (typeof item?.text === "string") return item.text;
      return "";
    }).filter(Boolean).join("\n");
    if (text.trim()) return text;
  }
  if (typeof anyValue.text === "string" && (!anyValue.type || anyValue.type === "text")) {
    return anyValue.text;
  }
  const stdout = typeof anyValue.stdout === "string" ? anyValue.stdout : "";
  const stderr = typeof anyValue.stderr === "string" ? anyValue.stderr : "";
  if (stdout || stderr) return [stdout, stderr].filter(Boolean).join("\n");
  for (const key of ["output", "result", "message"]) {
    if (typeof anyValue[key] === "string") return anyValue[key];
  }
  return void 0;
};
const stringifyProcessValue = (value) => {
  if (value === void 0 || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
const truncateDetail = (value) => {
  const maxLength = 1200;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
};
const getFileName = (filePath) => {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
};
const extractFilePathFromPatch = (patch) => {
  const lines = patch.split("\n");
  for (const line of lines) {
    const match = line.match(/^\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)$/) || line.match(/^diff --git\s+a\/.+\s+b\/(.+)$/) || line.match(/^\+\+\+\s+(?:b\/)?(.+)$/) || line.match(/^---\s+(?:a\/)?(.+)$/);
    if (!match) continue;
    const filePath = match[1].trim();
    if (filePath && filePath !== "/dev/null") return filePath;
  }
  return "";
};
const countPatchChanges = (patch) => ({
  additions: (patch.match(/^\+[^+]/gm) || []).length,
  deletions: (patch.match(/^-[^-]/gm) || []).length
});
const getToolKind = (toolName, command, patch) => {
  const normalized = normalizeName(toolName);
  for (const [kind, aliases] of Object.entries(TOOL_KIND_ALIASES)) {
    if (aliases.includes(normalized)) return kind;
  }
  if (patch) return "edit_file";
  if (command && !normalized) return "run_command";
  return "unknown";
};
const getToolPath = (toolKind, data, args, result, patchFilePath) => {
  if (patchFilePath) return patchFilePath;
  if (!["read_file", "list_dir", "write_file", "edit_file"].includes(toolKind)) return "";
  return findFirstString(
    { args, result, data },
    [
      ["args", "filePath"],
      ["args", "file_path"],
      ["args", "path"],
      ["args", "file"],
      ["args", "filename"],
      ["args", "fileName"],
      ["args", "target_file"],
      ["args", "targetFile"],
      ["args", "directory"],
      ["args", "dir"],
      ["data", "filePath"],
      ["data", "file_path"],
      ["data", "path"],
      ["data", "file"],
      ["data", "filename"],
      ["data", "fileName"],
      ["result", "filePath"],
      ["result", "file_path"],
      ["result", "path"],
      ["result", "file"],
      ["result", "filename"],
      ["result", "fileName"]
    ]
  );
};
const getPatch = (data, args, result) => {
  return findFirstString(
    { data, args, result },
    [
      ["result", "details", "patch"],
      ["result", "details", "diff"],
      ["result", "patch"],
      ["result", "diff"],
      ["args", "patch"],
      ["args", "diff"],
      ["data", "patch"],
      ["data", "diff"]
    ]
  );
};
const getCommand = (args, data) => findFirstString(
  { args, data },
  [
    ["args", "command"],
    ["args", "cmd"],
    ["args", "script"],
    ["data", "command"],
    ["data", "cmd"],
    ["data", "script"]
  ]
);
const getPattern = (args, data) => findFirstString(
  { args, data },
  [
    ["args", "pattern"],
    ["args", "query"],
    ["args", "glob"],
    ["data", "pattern"],
    ["data", "query"],
    ["data", "glob"]
  ]
);
const buildFiles = (toolKind, filePath, patch, additions, deletions) => {
  if (!filePath) return [];
  const action = toolKind === "read_file" ? "read" : toolKind === "list_dir" ? "listed" : toolKind === "write_file" ? "written" : toolKind === "edit_file" ? "edited" : void 0;
  if (!action) return [];
  return [{
    file: filePath,
    label: getFileName(filePath),
    action,
    additions,
    deletions,
    status: patch ? "modified" : void 0
  }];
};
const getErrorText = (data) => {
  const direct = unwrapToolText(data.error);
  if (direct) return direct;
  if (typeof data.message === "string") return data.message;
  if (data.error) return stringifyProcessValue(data.error);
  return "";
};
const buildDetail = (payload) => {
  const lines = [];
  const detailAllowedKinds = [
    "run_command",
    "search_files",
    "search_text",
    "web_fetch",
    "web_search",
    "unknown"
  ];
  if (payload.toolKind === "run_command" && payload.command) {
    lines.push(`$ ${payload.command}`);
  }
  if (payload.isError && payload.errorText) {
    lines.push(payload.errorText);
  } else if (payload.outputText && detailAllowedKinds.includes(payload.toolKind)) {
    lines.push(payload.outputText);
  } else if (detailAllowedKinds.includes(payload.toolKind) && typeof payload.rawDetail === "string" && payload.rawDetail.trim()) {
    lines.push(payload.rawDetail);
  }
  const detail = lines.filter(Boolean).join("\n");
  return detail ? truncateDetail(detail) : void 0;
};
const normalizeToolEvent = (phase, data) => {
  const args = data.args || data.input || data.parameters || data.toolInput || data.tool_input || data.arguments;
  const result = data.result !== void 0 ? data.result : data.output;
  const toolName = String(data.toolName || data.name || data.tool || "tool");
  const toolCallId = data.toolCallId || data.callId || data.callID || data.id;
  const patch = getPatch(data, args || {}, result || {});
  const command = getCommand(args || {}, data);
  const pattern = getPattern(args || {}, data);
  const toolKind = getToolKind(toolName, command, patch);
  const patchFilePath = patch ? extractFilePathFromPatch(patch) : "";
  const filePath = getToolPath(toolKind, data, args || {}, result || {}, patchFilePath);
  const changes = patch ? countPatchChanges(patch) : { additions: void 0, deletions: void 0 };
  const outputText = unwrapToolText(result);
  const errorText = data.isError ? getErrorText(data) : void 0;
  const files = buildFiles(toolKind, filePath, patch, changes.additions, changes.deletions);
  const detail = buildDetail({
    toolKind,
    command,
    outputText,
    errorText,
    rawDetail: data.detail,
    isError: data.isError
  });
  return {
    type: phase,
    toolName,
    toolCallId: toolCallId ? String(toolCallId) : void 0,
    toolKind,
    args,
    result,
    isError: !!data.isError,
    detail,
    outputText,
    errorText,
    files: files.length > 0 ? files : void 0,
    filePath: filePath || void 0,
    patch: patch || void 0,
    additions: changes.additions,
    deletions: changes.deletions,
    command: command || void 0,
    pattern: pattern || void 0
  };
};
const buildDiffsFromToolEvent = (payload) => {
  if (!payload.patch || !payload.filePath) return [];
  return [{
    file: payload.filePath,
    patch: payload.patch,
    additions: payload.additions || 0,
    deletions: payload.deletions || 0,
    status: "modified"
  }];
};
const normalizeQuestionProcessEvent = (data) => {
  const detail = data.question || data.prompt || data.message || unwrapToolText(data.args) || unwrapToolText(data.input) || (typeof data.detail === "string" ? data.detail : stringifyProcessValue(data.detail || data));
  return {
    type: "process_event",
    entryType: "question",
    kind: "question",
    title: "询问用户",
    detail,
    state: "completed"
  };
};
function formatProcessDetail(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
function summarizeToolPart(props) {
  const part = props.part || props;
  const toolName = part.tool || part.toolName || part.name || part.type || props.tool || props.toolName || "tool";
  const toolCallId = part.id || part.callID || part.callId || props.partID || props.partId || props.id || toolName;
  const args = part.input || part.args || props.input || props.args;
  const output = part.output || part.result || props.output || props.result;
  const error = part.error || props.error;
  return {
    toolName,
    toolCallId: String(toolCallId),
    args,
    result: output,
    detail: formatProcessDetail(error ? { args, error } : output !== void 0 ? { args, output } : args),
    isError: !!error
  };
}
function normalizeEventName(value) {
  return String(value || "").trim().toLowerCase();
}
function isAskUserName(value) {
  return ["ask_user", "ask_user_question", "user_ask_question", "droid.ask_user"].includes(normalizeEventName(value));
}
function isToolLikePart(props) {
  const part = props.part || props;
  const partType = part.type || props.type;
  const toolName = part.tool || part.toolName || part.name || props.tool || props.toolName || partType;
  return partType && String(partType).startsWith("tool") || isAskUserName(partType) || isAskUserName(toolName);
}
function isToolPartComplete(props) {
  const part = props.part || props;
  const state = part.state?.status || part.state || part.status || props.status;
  const normalizedState = typeof state === "string" ? state.toLowerCase() : "";
  return part.output !== void 0 || part.result !== void 0 || part.error !== void 0 || props.output !== void 0 || props.result !== void 0 || props.error !== void 0 || ["done", "completed", "complete", "success", "error", "failed"].includes(normalizedState);
}
class OpenCodeAgent {
  process = null;
  window = null;
  port = 0;
  host = "127.0.0.1";
  projectPath = "";
  sessionId = null;
  models = [];
  currentModelId = null;
  currentProviderId = null;
  eventSource = null;
  eventBuffer = "";
  streamedContent = false;
  idleTimer = null;
  runningToolParts = /* @__PURE__ */ new Set();
  completedToolParts = /* @__PURE__ */ new Set();
  setWindow(win) {
    this.window = win;
  }
  /** Start opencode serve and wait for it to be ready */
  async init(projectPath, existingSessionId) {
    if (this.process && this.projectPath === projectPath) {
      if (existingSessionId) this.sessionId = existingSessionId;
      return;
    }
    this.projectPath = projectPath;
    this.killProcess();
    this.port = 1e4 + Math.floor(Math.random() * 55e3);
    this.sessionId = null;
    this.emitEvent({ type: "agent_init", agentId: "opencode" });
    this.process = child_process.spawn("opencode", ["serve", "--port", String(this.port), "--hostname", this.host], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "true" }
    });
    this.process.stderr?.on("data", (chunk) => {
      console.log("[opencode]", chunk.toString().trim());
    });
    this.process.on("exit", () => {
      this.process = null;
      this.emitEvent({ type: "agent_disconnected" });
    });
    await this.waitForReady();
    if (existingSessionId) {
      const valid = await this.verifySession(existingSessionId);
      if (valid) {
        this.sessionId = existingSessionId;
        console.log("[opencode] Resumed session:", existingSessionId);
      } else {
        console.log("[opencode] Session", existingSessionId, "not found on server, will create new");
      }
    }
    if (!this.sessionId) {
      const createdSessionId = await this.createSession();
      if (createdSessionId) {
        console.log("[opencode] Created session:", createdSessionId);
      }
    }
  }
  /** Verify a session exists on the server */
  async verifySession(sessionId) {
    try {
      const result = await this.httpGet(`/session/${sessionId}`);
      return !!(result && result.id);
    } catch {
      return false;
    }
  }
  async waitForReady() {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await this.httpGet("/global/health");
        if (result && result.healthy) {
          this.emitEvent({ type: "agent_ready", agentId: "opencode", mock: false });
          return;
        }
      } catch {
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.emitEvent({ type: "agent_ready", agentId: "opencode", mock: true });
  }
  /** Create a new opencode session, or reuse existing if session ID is already set */
  async createSession() {
    if (this.sessionId) return this.sessionId;
    try {
      const result = await this.httpPost("/session", {});
      if (result && result.id) {
        this.sessionId = result.id;
        return this.sessionId;
      }
    } catch (e) {
      console.error("[opencode] createSession failed:", e);
    }
    return null;
  }
  /** Send a message to the opencode session */
  async sendMessage(message) {
    if (!this.sessionId) {
      await this.createSession();
    }
    if (!this.sessionId) {
      this.emitEvent({ type: "stream_start", role: "assistant" });
      this.emitEvent({ type: "stream_delta", delta: "无法创建会话，请检查 opencode 是否已安装。" });
      this.emitEvent({ type: "stream_end" });
      this.emitEvent({ type: "agent_end" });
      return;
    }
    this.emitEvent({ type: "stream_start", role: "assistant" });
    this.startSSEListener();
    try {
      const body = { parts: [{ type: "text", text: message }] };
      if (this.currentModelId && this.currentProviderId) {
        body.model = { providerID: this.currentProviderId, modelID: this.currentModelId };
      }
      await this.httpPost(`/session/${this.sessionId}/prompt_async`, body);
    } catch (e) {
      console.error("[opencode] sendMessage failed:", e);
      this.emitEvent({ type: "stream_delta", delta: `

发送失败: ${e}` });
      this.emitEvent({ type: "stream_end" });
      this.emitEvent({ type: "agent_end" });
      this.stopSSEListener();
    }
  }
  /** Listen to SSE events for streaming responses */
  startSSEListener() {
    this.stopSSEListener();
    this.eventBuffer = "";
    this.streamedContent = false;
    this.runningToolParts.clear();
    this.completedToolParts.clear();
    const req = http__namespace.get(
      `http://${this.host}:${this.port}/event`,
      (res) => {
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          this.eventBuffer += chunk;
          this.processSSEBuffer();
        });
        res.on("end", () => this.stopSSEListener());
        res.on("error", () => this.stopSSEListener());
      }
    );
    req.on("error", () => this.stopSSEListener());
    this.eventSource = req;
  }
  processSSEBuffer() {
    const lines = this.eventBuffer.split("\n");
    this.eventBuffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          continue;
        }
        if (parsed.type) {
          this.handleSSEEvent(parsed.type, parsed);
        }
      }
    }
  }
  handleSSEEvent(eventType, data) {
    const props = data.properties || data;
    switch (eventType) {
      case "message.part.added":
      case "message.part.updated": {
        if (isToolLikePart(props)) {
          const tool = summarizeToolPart(props);
          if (this.completedToolParts.has(tool.toolCallId)) break;
          if (!this.runningToolParts.has(tool.toolCallId)) {
            this.runningToolParts.add(tool.toolCallId);
            this.emitEvent(normalizeToolEvent("tool_start", tool));
          } else if (tool.detail) {
            this.emitEvent(normalizeToolEvent("tool_start", tool));
          }
          if (isToolPartComplete(props)) {
            const toolEvent = normalizeToolEvent("tool_end", tool);
            this.emitEvent(toolEvent);
            const diffs = buildDiffsFromToolEvent(toolEvent);
            if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
            this.runningToolParts.delete(tool.toolCallId);
            this.completedToolParts.add(tool.toolCallId);
          }
        }
        break;
      }
      case "message.part.done":
      case "message.part.removed": {
        const partType = props.part?.type || props.type;
        if (partType === "thinking") {
          this.emitEvent({ type: "thinking_end" });
        } else if (isToolLikePart(props)) {
          const tool = summarizeToolPart(props);
          if (this.completedToolParts.has(tool.toolCallId)) break;
          const toolEvent = normalizeToolEvent("tool_end", tool);
          this.emitEvent(toolEvent);
          const diffs = buildDiffsFromToolEvent(toolEvent);
          if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
          this.runningToolParts.delete(tool.toolCallId);
          this.completedToolParts.add(tool.toolCallId);
        }
        break;
      }
      case "message.part.delta": {
        this.cancelIdleTimer();
        if (props.field === "text" && props.delta) {
          this.streamedContent = true;
          this.emitEvent({ type: "stream_delta", delta: props.delta });
        } else if (props.field === "thinking" && props.delta) {
          this.streamedContent = true;
          this.emitEvent({ type: "thinking_delta", delta: props.delta });
        }
        break;
      }
      case "session.status": {
        const statusType = props.status?.type || props.status;
        if (statusType === "busy") {
          this.emitEvent({
            type: "process_event",
            entryType: "status",
            title: "OpenCode 正在处理",
            state: "running"
          });
          this.cancelIdleTimer();
        } else if (statusType === "idle") {
          this.emitEvent({
            type: "process_event",
            entryType: "status",
            title: "OpenCode 处理完成",
            state: "completed"
          });
          this.scheduleIdleEnd();
        }
        break;
      }
      case "session.error": {
        this.cancelIdleTimer();
        const err = props.error;
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          title: "OpenCode 错误",
          detail: err?.data?.message || err?.message || "OpenCode request failed",
          state: "error"
        });
        const msg = err?.data?.message || err?.message || "未知错误";
        this.emitEvent({ type: "stream_delta", delta: `

错误: ${msg}` });
        this.emitEvent({ type: "stream_end" });
        this.emitEvent({ type: "agent_end" });
        this.stopSSEListener();
        break;
      }
      case "session.diff": {
        const diffs = props.diff;
        if (Array.isArray(diffs) && diffs.length > 0) {
          this.emitEvent({ type: "diff_update", diffs });
        }
        break;
      }
      case "session.idle": {
        this.emitEvent({
          type: "process_event",
          entryType: "status",
          title: "OpenCode 空闲",
          state: "completed"
        });
        this.scheduleIdleEnd();
        break;
      }
    }
  }
  cancelIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
  scheduleIdleEnd() {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.streamedContent) {
        this.emitEvent({ type: "stream_end" });
        this.emitEvent({ type: "agent_end" });
        this.stopSSEListener();
      } else {
        this.fetchAssistantMessage();
      }
    }, 800);
  }
  /** Fetch the latest assistant message content via REST after session.idle */
  async fetchAssistantMessage() {
    if (!this.sessionId) {
      this.emitEvent({ type: "stream_end" });
      this.emitEvent({ type: "agent_end" });
      this.stopSSEListener();
      return;
    }
    try {
      const messages = await this.httpGet(`/session/${this.sessionId}/message`);
      if (Array.isArray(messages)) {
        const assistantMsg = [...messages].reverse().find((m) => m.info?.role === "assistant");
        if (assistantMsg && assistantMsg.parts && assistantMsg.parts.length > 0) {
          for (const part of assistantMsg.parts) {
            if (part.type === "text" && part.text) {
              this.emitEvent({ type: "stream_delta", delta: part.text });
            } else if (part.type === "thinking" && part.text) {
              this.emitEvent({ type: "thinking_delta", delta: part.text });
              this.emitEvent({ type: "thinking_end" });
            }
          }
        } else if (assistantMsg?.info?.error) {
          const errMsg = assistantMsg.info.error.data?.message || assistantMsg.info.error.message || "请求失败";
          this.emitEvent({ type: "stream_delta", delta: `

错误: ${errMsg}` });
        } else {
          this.emitEvent({ type: "stream_delta", delta: "\n\n(无响应内容)" });
        }
      }
    } catch (e) {
      this.emitEvent({ type: "stream_delta", delta: `

获取响应失败: ${e}` });
    }
    this.emitEvent({ type: "stream_end" });
    this.emitEvent({ type: "agent_end" });
    this.stopSSEListener();
  }
  stopSSEListener() {
    this.cancelIdleTimer();
    if (this.eventSource) {
      this.eventSource.destroy();
      this.eventSource = null;
    }
  }
  /** Abort the current response */
  async abort() {
    if (this.sessionId) {
      try {
        await this.httpPost(`/session/${this.sessionId}/abort`, {});
      } catch {
      }
    }
    this.stopSSEListener();
  }
  /** Get available models from providers */
  async getModels() {
    console.log("[opencode] getModels called, cached:", this.models.length, "port:", this.port);
    if (this.models.length > 0) return this.models;
    try {
      const result = await this.httpGet("/config/providers");
      if (result && result.providers) {
        const models = [];
        for (const provider of result.providers) {
          const providerId = provider.id || provider.name;
          if (Array.isArray(provider.models)) {
            for (const m of provider.models) {
              models.push({
                id: m.id || m.name,
                name: m.name || m.id,
                provider: providerId,
                reasoning: m.reasoning ?? false
              });
            }
          } else if (provider.models && typeof provider.models === "object") {
            for (const [modelId, modelInfo] of Object.entries(provider.models)) {
              models.push({
                id: modelId,
                name: modelInfo?.name || modelId,
                provider: providerId,
                reasoning: modelInfo?.reasoning ?? false
              });
            }
          } else if (result.default?.[providerId]) {
            models.push({
              id: result.default[providerId],
              name: result.default[providerId],
              provider: providerId,
              reasoning: false
            });
          }
        }
        if (models.length > 0) {
          this.models = models;
          return this.models;
        }
      }
    } catch (e) {
      console.error("[opencode] getModels failed:", e);
    }
    return this.models;
  }
  /** Set model for the session - stored and applied per-message */
  async setModel(provider, modelId) {
    this.currentModelId = modelId;
    this.currentProviderId = provider;
    this.emitEvent({ type: "model_changed", model: { id: modelId, provider } });
  }
  /** Set thinking level - opencode does not have a direct equivalent */
  async setThinkingLevel(_level) {
    this.emitEvent({ type: "thinking_level_changed", level: _level });
  }
  sendUIResponse(_response) {
  }
  /** For OpenCode, the session ID serves as the session file path equivalent */
  get sessionFilePath() {
    return this.sessionId;
  }
  /** Dispose and clean up */
  dispose() {
    this.cancelIdleTimer();
    this.stopSSEListener();
    this.killProcess();
  }
  killProcess() {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.sessionId = null;
  }
  // ---- HTTP helpers ----
  httpGet(path2) {
    return new Promise((resolve, reject) => {
      const req = http__namespace.get(
        `http://${this.host}:${this.port}${path2}`,
        { timeout: 1e4 },
        (res) => {
          let body = "";
          res.on("data", (chunk) => body += chunk);
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(body);
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
    });
  }
  httpPost(path2, data) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const req = http__namespace.request(
        `http://${this.host}:${this.port}${path2}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 3e4
        },
        (res) => {
          let resBody = "";
          res.on("data", (chunk) => resBody += chunk);
          res.on("end", () => {
            try {
              resolve(JSON.parse(resBody));
            } catch {
              resolve(resBody);
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.write(body);
      req.end();
    });
  }
  httpPatch(path2, data) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const req = http__namespace.request(
        `http://${this.host}:${this.port}${path2}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 1e4
        },
        (res) => {
          let resBody = "";
          res.on("data", (chunk) => resBody += chunk);
          res.on("end", () => {
            try {
              resolve(JSON.parse(resBody));
            } catch {
              resolve(resBody);
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.write(body);
      req.end();
    });
  }
  emitEvent(data) {
    this.window?.webContents.send("agent:event", data);
  }
}
class DroidAgent {
  process = null;
  window = null;
  projectPath = "";
  sessionId = null;
  models = [];
  rpcId = 0;
  pendingResponses = /* @__PURE__ */ new Map();
  isReady = false;
  autonomyLevel = "medium";
  setWindow(win) {
    this.window = win;
  }
  /** Start droid exec in stream-jsonrpc mode */
  async init(projectPath, existingSessionId) {
    if (this.process && this.projectPath === projectPath) return;
    this.projectPath = projectPath;
    this.killProcess();
    this.isReady = false;
    this.emitEvent({ type: "agent_init", agentId: "droid" });
    const args = [
      "exec",
      "--input-format",
      "stream-jsonrpc",
      "--output-format",
      "stream-jsonrpc",
      "--auto",
      this.autonomyLevel,
      "--cwd",
      projectPath
    ];
    if (existingSessionId) {
      args.push("--session-id", existingSessionId);
    }
    this.process = child_process.spawn("droid", args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      env: { ...process.env }
    });
    const decoder = new string_decoder.StringDecoder("utf8");
    let buffer = "";
    let initResolved = false;
    this.process.on("exit", () => {
      if (!initResolved) {
        initResolved = true;
        this.process = null;
        this.emitEvent({ type: "agent_ready", agentId: "droid", mock: true });
      }
    });
    this.process.stdout?.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 0) {
          try {
            const data = JSON.parse(line);
            this.handleMessage(data);
            if (!initResolved && data.type === "response" && data.id === "init-1" && data.result) {
              initResolved = true;
              this.isReady = true;
              if (data.result?.sessionId) {
                this.sessionId = data.result.sessionId;
              }
              this.emitEvent({ type: "agent_ready", agentId: "droid", mock: false });
            }
          } catch {
          }
        }
      }
    });
    this.process.stderr?.on("data", (chunk) => {
      console.log("[droid]", chunk.toString().trim());
    });
    this.sendRpc("droid.initialize_session", {
      machineId: "default",
      cwd: projectPath,
      autonomyLevel: this.autonomyLevel
    });
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (initResolved) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        if (!initResolved) {
          initResolved = true;
          this.isReady = false;
          this.killProcess();
          this.emitEvent({ type: "agent_ready", agentId: "droid", mock: true });
        }
        resolve();
      }, 15e3);
    });
  }
  /** Send a user message */
  async sendMessage(message, images) {
    if (!this.process || !this.isReady) {
      this.mockResponse(message);
      return;
    }
    this.emitEvent({ type: "stream_start", role: "assistant" });
    const msgParams = { text: message };
    if (images && images.length > 0) {
      msgParams.images = images.map((img) => ({
        type: "image",
        mediaType: img.mimeType,
        data: img.data
      }));
    }
    this.sendRpc("droid.add_user_message", msgParams);
  }
  async mockResponse(message) {
    this.emitEvent({ type: "stream_start", role: "assistant" });
    const response = `收到消息: "${message}"

这是离线模拟回复。如需使用 Factory Droid，请安装 droid CLI 并设置 FACTORY_API_KEY 环境变量。

安装: curl -fsSL https://app.factory.ai/cli | sh`;
    for (let i = 0; i < response.length; i += 4) {
      await new Promise((r) => setTimeout(r, 8));
      this.emitEvent({ type: "stream_delta", delta: response.slice(i, i + 4) });
    }
    this.emitEvent({ type: "stream_end" });
    this.emitEvent({ type: "agent_end" });
  }
  /** Abort current response */
  async abort() {
    if (this.process) {
      this.sendRpc("droid.interrupt_session", {});
    }
  }
  /** Get available models - Factory provides a curated set + local custom models */
  async getModels() {
    if (this.models.length > 0) return this.models;
    this.models = [
      { id: "claude-opus-4-7", name: "Claude Opus 4", provider: "factory", reasoning: true },
      { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", provider: "factory", reasoning: true },
      { id: "claude-sonnet-4-6-20250514", name: "Claude Sonnet 4.6", provider: "factory", reasoning: true },
      { id: "gpt-5-codex", name: "GPT-5 Codex", provider: "factory", reasoning: true },
      { id: "gpt-5.1-codex", name: "GPT-5.1 Codex", provider: "factory", reasoning: true },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "factory", reasoning: true },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "factory", reasoning: false }
    ];
    try {
      const configPath = path.join(os.homedir(), ".factory", "settings.json");
      const content = await promises.readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      if (Array.isArray(config.customModels)) {
        for (const m of config.customModels) {
          this.models.push({
            id: m.id || m.model || m.displayName,
            name: m.displayName || m.model || m.id,
            provider: m.provider || "factory-custom",
            reasoning: false
          });
        }
      }
    } catch {
    }
    return this.models;
  }
  /** Set model - sends setting update via RPC */
  async setModel(_provider, modelId) {
    if (this.process && this.isReady) {
      this.sendRpc("droid.update_settings", { modelId });
      this.emitEvent({ type: "model_changed", model: { id: modelId, provider: _provider } });
    }
  }
  /** Set reasoning effort */
  async setThinkingLevel(level) {
    const effortMap = {
      off: "off",
      none: "none",
      low: "low",
      medium: "medium",
      high: "high"
    };
    if (this.process && this.isReady) {
      this.sendRpc("droid.update_settings", { reasoningEffort: effortMap[level] || level });
    }
    this.emitEvent({ type: "thinking_level_changed", level });
  }
  sendUIResponse(response) {
    if (!this.process || !this.isReady) return;
    this.process.stdin?.write(JSON.stringify(response) + "\n");
  }
  get sessionFilePath() {
    return this.sessionId;
  }
  /** Dispose and clean up */
  dispose() {
    this.killProcess();
  }
  killProcess() {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.isReady = false;
    this.sessionId = null;
    this.pendingResponses.clear();
  }
  // ---- JSON-RPC (Factory protocol) ----
  sendRpc(method, params, onResponse) {
    const id = `rpc-${++this.rpcId}`;
    const msg = {
      jsonrpc: "2.0",
      factoryApiVersion: "1.0.0",
      factoryProtocolVersion: "1.87.0",
      type: "request",
      id,
      method,
      params
    };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(JSON.stringify(msg) + "\n");
    return id;
  }
  sendRpcResponse(requestId, result) {
    const msg = {
      jsonrpc: "2.0",
      factoryApiVersion: "1.0.0",
      factoryProtocolVersion: "1.87.0",
      type: "response",
      id: requestId,
      result
    };
    this.process?.stdin?.write(JSON.stringify(msg) + "\n");
  }
  handleMessage(data) {
    const msgType = data.type;
    if (msgType === "response") {
      if (data.id && this.pendingResponses.has(data.id)) {
        const handler = this.pendingResponses.get(data.id);
        handler(data);
        this.pendingResponses.delete(data.id);
      }
    } else if (msgType === "notification") {
      const method = data.method || data.params?.notification?.type;
      this.handleNotification(method, data.params || data);
    } else if (msgType === "request") {
      this.handleServerRequest(data.method, data.id, data.params);
    }
  }
  handleServerRequest(method, requestId, params) {
    switch (method) {
      case "droid.request_permission":
        this.sendRpcResponse(requestId, { selectedOption: "proceed_once" });
        break;
      case "droid.ask_user":
        this.emitEvent(normalizeQuestionProcessEvent({ type: method, detail: params }));
        this.sendRpcResponse(requestId, { cancelled: true, answers: [] });
        break;
    }
  }
  handleNotification(method, params) {
    const notification = params?.notification || params;
    const notifType = notification?.type || method;
    const notifData = notification?.data || notification;
    switch (notifType) {
      case "assistant_text_delta":
        this.emitEvent({ type: "stream_delta", delta: notifData?.delta || notifData?.text || "" });
        break;
      case "assistant_text_complete":
        this.emitEvent({ type: "stream_end" });
        this.emitEvent({ type: "agent_end" });
        break;
      case "thinking_text_delta":
        this.emitEvent({ type: "thinking_delta", delta: notifData?.delta || notifData?.text || "" });
        break;
      case "thinking_text_complete":
        this.emitEvent({ type: "thinking_end" });
        break;
      case "droid.ask_user":
      case "ask_user":
      case "ask_user_question":
      case "user_ask_question":
        this.emitEvent(normalizeQuestionProcessEvent({ type: notifType, detail: notifData }));
        break;
      case "tool_progress_update":
        {
          const normalizedInput = {
            toolName: notifData?.toolName || notifData?.name || "tool",
            toolCallId: notifData?.toolCallId || notifData?.id || notifData?.name,
            args: notifData?.args || notifData?.input,
            result: notifData?.result,
            detail: notifData?.message || notifData?.status,
            patch: notifData?.patch || notifData?.diff,
            isError: notifData?.isError || notifData?.status === "error"
          };
          const phase = notifData?.result || notifData?.patch || notifData?.diff || notifData?.status === "completed" || notifData?.status === "error" ? "tool_end" : "tool_start";
          const toolEvent = normalizeToolEvent(phase, normalizedInput);
          this.emitEvent(toolEvent);
          if (phase === "tool_end") {
            const diffs = buildDiffsFromToolEvent(toolEvent);
            if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
          }
        }
        break;
      case "droid_working_state_changed":
        break;
      case "error":
        this.emitEvent({ type: "stream_delta", delta: `

错误: ${notifData?.message || "未知错误"}` });
        this.emitEvent({ type: "stream_end" });
        this.emitEvent({ type: "agent_end" });
        break;
    }
  }
  emitEvent(data) {
    this.window?.webContents.send("agent:event", data);
  }
}
class PiAgent {
  process = null;
  window = null;
  models = [];
  pendingResponses = /* @__PURE__ */ new Map();
  rpcId = 0;
  isMock = true;
  projectPath = "";
  _sessionFilePath = null;
  eventQueue = [];
  eventTimer = null;
  turnFallbackTimer = null;
  streamedText = false;
  pendingAssistantText = "";
  setWindow(win) {
    this.window = win;
  }
  /** Start a new pi process for this session */
  async init(projectPath, existingSessionFilePath) {
    if (this.process && this.projectPath === projectPath) return;
    this.projectPath = projectPath;
    this.killProcess();
    this.isMock = true;
    this._sessionFilePath = null;
    this.emitEvent({ type: "agent_init", agentId: "pi" });
    const args = ["--mode", "rpc"];
    if (existingSessionFilePath) {
      args.push("--session", existingSessionFilePath);
    }
    this.process = child_process.spawn("pi", args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true
    });
    const decoder = new string_decoder.StringDecoder("utf8");
    let buffer = "";
    let initResolved = false;
    this.process.on("exit", () => {
      if (!initResolved) {
        initResolved = true;
        this.isMock = true;
        this.process = null;
        this.emitEvent({ type: "agent_ready", agentId: "pi", mock: true });
      }
    });
    this.process.stdout?.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 0) {
          try {
            const data = JSON.parse(line);
            this.handleMessage(data);
            if (!initResolved && data.type === "response" && data.command === "get_state") {
              initResolved = true;
              this.isMock = false;
              if (data.data?.sessionFile) {
                this._sessionFilePath = data.data.sessionFile;
              }
              this.emitEvent({ type: "agent_ready", agentId: "pi", mock: false });
            }
          } catch {
          }
        }
      }
    });
    this.process.stderr?.on("data", (chunk) => {
      console.log("[pi]", chunk.toString().trim());
    });
    await new Promise((resolve) => {
      this.sendCommand({ type: "get_state" });
      const check = setInterval(() => {
        if (initResolved) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        if (!initResolved) {
          initResolved = true;
          this.isMock = true;
          this.killProcess();
          this.emitEvent({ type: "agent_ready", agentId: "pi", mock: true });
        }
        resolve();
      }, 8e3);
    });
  }
  /** Switch to an existing session file (for resuming after restart) */
  async switchToSession(sessionFilePath) {
    if (this.isMock || !this.process) return false;
    return new Promise((resolve) => {
      this.sendCommand({ type: "switch_session", sessionPath: sessionFilePath }, (data) => {
        if (data.success && !data.data?.cancelled) {
          this._sessionFilePath = sessionFilePath;
          resolve(true);
        } else {
          resolve(false);
        }
      });
      setTimeout(() => resolve(false), 5e3);
    });
  }
  get sessionFilePath() {
    return this._sessionFilePath;
  }
  sendUIResponse(response) {
    if (this.isMock || !this.process) return;
    const line = JSON.stringify(response) + "\n";
    this.process.stdin?.write(line);
  }
  killProcess() {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.pendingResponses.clear();
    this.eventQueue = [];
    if (this.eventTimer) {
      clearTimeout(this.eventTimer);
      this.eventTimer = null;
    }
    this.clearTurnFallback();
  }
  async sendMessage(message, images) {
    if (this.isMock || !this.process) {
      this.mockResponse(message);
      return;
    }
    this.emitEvent({ type: "message_start", role: "user", content: message });
    const cmd = { type: "prompt", message };
    if (images && images.length > 0) {
      cmd.images = images;
    }
    this.sendCommand(cmd);
  }
  async mockResponse(message) {
    this.emitEvent({ type: "message_start", role: "user", content: message });
    this.emitEvent({ type: "stream_start", role: "assistant" });
    const response = `收到消息: "${message}"

这是离线模拟回复。如需使用真实 Agent，请安装 \`pi\` CLI 并配置 API key。`;
    for (let i = 0; i < response.length; i += 4) {
      await new Promise((r) => setTimeout(r, 8));
      this.emitEvent({ type: "stream_delta", delta: response.slice(i, i + 4) });
    }
    this.emitEvent({ type: "stream_end" });
    this.emitEvent({ type: "agent_end" });
  }
  async abort() {
    this.sendCommand({ type: "abort" });
  }
  async getModels() {
    if (this.models.length > 0) return this.models;
    try {
      const rpcModels = await new Promise((resolve) => {
        this.sendCommand({ type: "get_available_models" }, (data) => {
          const models = [];
          if (data.success && data.data?.models) {
            models.push(...data.data.models.map((m) => ({
              id: m.id,
              name: m.name || m.id,
              provider: m.provider,
              reasoning: m.reasoning ?? false
            })));
          }
          resolve(models);
        });
        setTimeout(() => resolve([]), 3e3);
      });
      if (rpcModels.length > 0) {
        this.models = rpcModels;
        return this.models;
      }
    } catch {
    }
    return this.models;
  }
  async setModel(provider, modelId) {
    this.sendCommand({ type: "set_model", provider, modelId }, (data) => {
      if (data.success) this.emitEvent({ type: "model_changed", model: { id: modelId, provider } });
    });
  }
  async setThinkingLevel(level) {
    this.sendCommand({ type: "set_thinking_level", level }, (data) => {
      if (data.success) this.emitEvent({ type: "thinking_level_changed", level });
    });
  }
  dispose() {
    this.killProcess();
  }
  handleMessage(data) {
    if (data.type === "response" && data.id) {
      const handler = this.pendingResponses.get(data.id);
      if (handler) {
        handler(data);
        this.pendingResponses.delete(data.id);
      }
    }
    switch (data.type) {
      case "agent_start":
        this.clearTurnFallback();
        this.streamedText = false;
        this.pendingAssistantText = "";
        this.emitEvent({ type: "stream_start", role: "assistant" });
        break;
      case "message_update": {
        this.clearTurnFallback();
        const aev = data.assistantMessageEvent;
        if (aev) {
          if (aev.type === "text_delta") {
            if (aev.delta) this.streamedText = true;
            this.emitEventThrottled({ type: "stream_delta", delta: aev.delta });
          } else if (aev.type === "thinking_delta") this.emitEventThrottled({ type: "thinking_delta", delta: aev.delta });
        }
        break;
      }
      case "message_end":
        if (data.message?.role === "assistant") {
          const content = data.message.content || [];
          const textParts = content.filter((c) => c.type === "text").map((c) => c.text).join("");
          const thinkingParts = content.filter((c) => c.type === "thinking").map((c) => c.text || c.thinking || "").join("");
          if (thinkingParts) {
            this.emitEvent({ type: "thinking_end" });
          }
          if (textParts) {
            this.pendingAssistantText = textParts;
            this.scheduleTurnFallback(4e3);
          }
        }
        break;
      case "user_ask_question":
      case "ask_user_question":
      case "ask_user":
        this.emitEvent(normalizeQuestionProcessEvent(data));
        break;
      case "agent_end":
        this.completeTurn();
        break;
      case "tool_execution_start":
        this.clearTurnFallback();
        this.emitEvent(normalizeToolEvent("tool_start", { ...data, args: this.getToolArgs(data) }));
        break;
      case "tool_execution_end":
        {
          const toolEvent = normalizeToolEvent("tool_end", { ...data, args: this.getToolArgs(data) });
          this.emitEvent(toolEvent);
          const diffs = buildDiffsFromToolEvent(toolEvent);
          if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
        }
        break;
    }
  }
  getToolArgs(data) {
    return data.args || data.input || data.parameters || data.toolInput || data.tool_input || data.arguments;
  }
  clearTurnFallback() {
    if (this.turnFallbackTimer) {
      clearTimeout(this.turnFallbackTimer);
      this.turnFallbackTimer = null;
    }
  }
  scheduleTurnFallback(delayMs) {
    this.clearTurnFallback();
    this.turnFallbackTimer = setTimeout(() => {
      this.turnFallbackTimer = null;
      if (this.pendingAssistantText || this.streamedText) {
        this.completeTurn();
      }
    }, delayMs);
  }
  flushQueuedEvents() {
    while (this.eventQueue.length > 0) {
      const item = this.eventQueue.shift();
      this.window?.webContents.send("agent:event", item);
    }
    if (this.eventTimer) {
      clearTimeout(this.eventTimer);
      this.eventTimer = null;
    }
  }
  completeTurn() {
    this.clearTurnFallback();
    this.flushQueuedEvents();
    if (!this.streamedText && this.pendingAssistantText) {
      this.emitEvent({ type: "stream_delta", delta: this.pendingAssistantText });
      this.streamedText = true;
    }
    this.emitEvent({ type: "stream_end", content: this.pendingAssistantText });
    this.emitEvent({ type: "agent_end" });
    this.pendingAssistantText = "";
    this.streamedText = false;
  }
  sendCommand(cmd, onResponse) {
    const id = `rpc-${++this.rpcId}`;
    const fullCmd = { ...cmd, id };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(JSON.stringify(fullCmd) + "\n");
    return id;
  }
  emitEvent(data) {
    this.window?.webContents.send("agent:event", data);
  }
  /** Emit event with throttle for streaming events to prevent React batching */
  emitEventThrottled(data) {
    const streamingTypes = /* @__PURE__ */ new Set(["stream_delta"]);
    if (streamingTypes.has(data.type)) {
      this.eventQueue.push(data);
      this.flushEventQueue();
    } else {
      this.window?.webContents.send("agent:event", data);
    }
  }
  flushEventQueue() {
    if (this.eventTimer) return;
    if (this.eventQueue.length === 0) return;
    const item = this.eventQueue.shift();
    this.window?.webContents.send("agent:event", item);
    if (this.eventQueue.length > 0) {
      this.eventTimer = setTimeout(() => {
        this.eventTimer = null;
        this.flushEventQueue();
      }, 5);
    }
  }
}
class AgentManager {
  sessionAgents = /* @__PURE__ */ new Map();
  sessionAgentTypes = /* @__PURE__ */ new Map();
  // sessionId -> agentId ("pi" | "opencode")
  sessionFilePaths = /* @__PURE__ */ new Map();
  activeSessionId = null;
  window = null;
  setWindow(win) {
    this.window = win;
  }
  createAgentBackend(agentId) {
    if (agentId === "opencode") return new OpenCodeAgent();
    if (agentId === "droid") return new DroidAgent();
    return new PiAgent();
  }
  /** Create or resume a session */
  async createSession(sessionId, agentId, projectPath, existingSessionFilePath) {
    console.log("[agent-manager] createSession:", sessionId, "agent:", agentId, "existingSessionFilePath:", existingSessionFilePath);
    let agent = this.sessionAgents.get(sessionId);
    if (!agent) {
      agent = this.createAgentBackend(agentId);
      this.sessionAgents.set(sessionId, agent);
      this.sessionAgentTypes.set(sessionId, agentId);
      console.log("[agent-manager] Created new agent:", agent.constructor.name);
    } else {
      console.log("[agent-manager] Reusing existing agent:", agent.constructor.name);
    }
    if (this.window) agent.setWindow(this.window);
    await agent.init(projectPath, existingSessionFilePath);
    const fp = agent.sessionFilePath;
    console.log("[agent-manager] After init, sessionFilePath:", fp);
    if (fp) this.sessionFilePaths.set(sessionId, fp);
    this.activeSessionId = sessionId;
  }
  getSessionFilePath(sessionId) {
    return this.sessionFilePaths.get(sessionId);
  }
  switchSession(sessionId) {
    if (this.sessionAgents.has(sessionId)) {
      this.activeSessionId = sessionId;
    }
  }
  getActiveAgent() {
    if (!this.activeSessionId) return null;
    return this.sessionAgents.get(this.activeSessionId) || null;
  }
  getAgentBySessionId(sessionId) {
    return this.sessionAgents.get(sessionId) || null;
  }
  async getModelsBySessionId(sessionId) {
    const agent = this.sessionAgents.get(sessionId);
    if (!agent) return [];
    return agent.getModels();
  }
  sendUIResponse(response) {
    const agent = this.getActiveAgent();
    if (!agent) return;
    agent.sendUIResponse(response);
  }
  removeSession(sessionId) {
    const agent = this.sessionAgents.get(sessionId);
    if (agent) {
      agent.dispose();
      this.sessionAgents.delete(sessionId);
    }
    this.sessionAgentTypes.delete(sessionId);
    this.sessionFilePaths.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
  }
}
const agentManager = new AgentManager();
function registerAgentHandlers(getWindow) {
  electron.ipcMain.handle("agent:createSession", async (_event, agentId, projectPath, sessionId, sessionFilePath) => {
    const sid = sessionId || "default";
    try {
      const win = getWindow();
      if (win) agentManager.setWindow(win);
      await agentManager.createSession(sid, agentId, projectPath, sessionFilePath);
      const models = await agentManager.getModelsBySessionId(sid);
      return { success: true, sessionFilePath: agentManager.getSessionFilePath(sid), models };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle("agent:switchSession", async (_event, sessionId) => {
    agentManager.switchSession(sessionId);
    return { success: true };
  });
  electron.ipcMain.handle("agent:removeSession", async (_event, sessionId) => {
    agentManager.removeSession(sessionId);
    return { success: true };
  });
  electron.ipcMain.handle("agent:sendMessage", async (_event, message, images) => {
    const agent = agentManager.getActiveAgent();
    if (!agent) return { success: false, error: "No active agent" };
    try {
      await agent.sendMessage(message, images);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle("agent:abort", async () => {
    const agent = agentManager.getActiveAgent();
    if (!agent) return { success: false };
    await agent.abort();
    return { success: true };
  });
  electron.ipcMain.handle("agent:getModels", async (_event, sessionId) => {
    const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
    console.log("[agent-manager] getModels sessionId:", sessionId, "agent:", agent ? agent.constructor.name : "null");
    if (!agent) return [];
    return agent.getModels();
  });
  electron.ipcMain.handle("agent:setModel", async (_event, provider, modelId) => {
    const agent = agentManager.getActiveAgent();
    if (!agent) return { success: false };
    await agent.setModel(provider, modelId);
    return { success: true };
  });
  electron.ipcMain.handle("agent:setThinkingLevel", async (_event, level) => {
    const agent = agentManager.getActiveAgent();
    if (!agent) return { success: false };
    await agent.setThinkingLevel(level);
    return { success: true };
  });
  electron.ipcMain.handle("agent:sendUIResponse", async (_event, response) => {
    agentManager.sendUIResponse(response);
    return { success: true };
  });
}
if (process.platform === "linux") {
  electron.app.commandLine.appendSwitch("enable-wayland-ime");
  electron.app.commandLine.appendSwitch("wayland-text-input-version", "3");
}
electron.app.setName("hpp");
let mainWindow = null;
function createWindow() {
  electron.Menu.setApplicationMenu(null);
  const iconPath = path.join(__dirname, "../renderer/icon.png");
  mainWindow = new electron.BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#1e1e1e",
    title: "Hpp",
    icon: iconPath,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (utils.is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
electron.app.whenReady().then(() => {
  createWindow();
  registerFileHandlers();
  registerStoreHandlers();
  registerAgentHandlers(() => mainWindow);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
electron.ipcMain.on("window:minimize", () => mainWindow?.minimize());
electron.ipcMain.on("window:maximize", () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
electron.ipcMain.on("window:close", () => mainWindow?.close());
