"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const promises = require("fs/promises");
const os = require("os");
const child_process = require("child_process");
const string_decoder = require("string_decoder");
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
    try {
      const { join } = await import("path");
      const { homedir } = await import("os");
      const configPath = join(homedir(), ".pi/agent/models.json");
      const content = await promises.readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      const models = [];
      if (config.providers) {
        for (const [provider, pc] of Object.entries(config.providers)) {
          if (Array.isArray(pc.models)) {
            for (const m of pc.models) {
              models.push({ id: m.id || m.name, name: m.name || m.id, provider, reasoning: m.reasoning ?? false });
            }
          }
        }
      }
      if (models.length > 0) {
        this.models = models;
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
        this.emitEvent({ type: "stream_start", role: "assistant" });
        break;
      case "message_update": {
        const aev = data.assistantMessageEvent;
        if (aev) {
          if (aev.type === "text_delta") this.emitEventThrottled({ type: "stream_delta", delta: aev.delta });
          else if (aev.type === "thinking_delta") this.emitEventThrottled({ type: "thinking_delta", delta: aev.delta });
        }
        break;
      }
      case "message_end":
        if (data.message?.role === "assistant") {
          const textParts = (data.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
          while (this.eventQueue.length > 0) {
            const item = this.eventQueue.shift();
            this.window?.webContents.send("agent:event", item);
          }
          if (this.eventTimer) {
            clearTimeout(this.eventTimer);
            this.eventTimer = null;
          }
          this.emitEvent({ type: "stream_end", content: textParts });
        }
        break;
      case "agent_end":
        while (this.eventQueue.length > 0) {
          const item = this.eventQueue.shift();
          this.window?.webContents.send("agent:event", item);
        }
        if (this.eventTimer) {
          clearTimeout(this.eventTimer);
          this.eventTimer = null;
        }
        this.emitEvent({ type: "agent_end" });
        break;
      case "tool_execution_start":
        this.emitEvent({ type: "tool_start", toolName: data.toolName, toolCallId: data.toolCallId });
        break;
      case "tool_execution_end":
        this.emitEvent({ type: "tool_end", toolName: data.toolName, toolCallId: data.toolCallId, isError: data.isError });
        break;
    }
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
  // sessionId -> PiAgent
  sessionFilePaths = /* @__PURE__ */ new Map();
  // sessionId -> sessionFile path
  activeSessionId = null;
  window = null;
  setWindow(win) {
    this.window = win;
  }
  /** Create or resume a session. If existingSessionFilePath is given, switch to it after init. */
  async createSession(sessionId, agentId, projectPath, existingSessionFilePath) {
    let agent = this.sessionAgents.get(sessionId);
    if (!agent) {
      agent = new PiAgent();
      this.sessionAgents.set(sessionId, agent);
    }
    if (this.window) agent.setWindow(this.window);
    await agent.init(projectPath, existingSessionFilePath);
    const fp = agent.sessionFilePath;
    if (fp) this.sessionFilePaths.set(sessionId, fp);
    this.activeSessionId = sessionId;
  }
  /** Get stored session file path for a session */
  getSessionFilePath(sessionId) {
    return this.sessionFilePaths.get(sessionId);
  }
  /** Switch active session */
  switchSession(sessionId) {
    if (this.sessionAgents.has(sessionId)) {
      this.activeSessionId = sessionId;
    }
  }
  /** Get the active agent */
  getActiveAgent() {
    if (!this.activeSessionId) return null;
    return this.sessionAgents.get(this.activeSessionId) || null;
  }
  /** Remove a session's agent */
  removeSession(sessionId) {
    const agent = this.sessionAgents.get(sessionId);
    if (agent) {
      agent.dispose();
      this.sessionAgents.delete(sessionId);
    }
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
      return { success: true, sessionFilePath: agentManager.getSessionFilePath(sid) };
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
  electron.ipcMain.handle("agent:getModels", async () => {
    const agent = agentManager.getActiveAgent();
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
