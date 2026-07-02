"use strict";
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const promises = require("fs/promises");
const os = require("os");
const child_process = require("child_process");
const fs = require("fs");
const http = require("http");
const string_decoder = require("string_decoder");
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
    if (typeof dirPath !== "string" || !dirPath.trim()) return [];
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
    if (typeof filePath !== "string" || !filePath.trim()) {
      return { success: false, error: "Invalid file path" };
    }
    try {
      const content = await promises.readFile(filePath, "utf-8");
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  electron.ipcMain.handle("fs:fileExists", async (_event, filePath) => {
    if (typeof filePath !== "string" || !filePath.trim()) return false;
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
      if (typeof dirPath !== "string" || !dirPath.trim()) return results;
      const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
      if (!normalizedQuery) return results;
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
            if (entry.name.toLowerCase().includes(normalizedQuery)) {
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
    if (typeof command !== "string" || !/^[\w@./:-]+$/.test(command)) return false;
    try {
      const executable = process.platform === "win32" ? "where" : "which";
      const args = process.platform === "win32" ? [command] : ["-a", command];
      const result = child_process.spawnSync(executable, args, { encoding: "utf-8", shell: false });
      if (result.status !== 0 || result.error) return false;
      const output = result.stdout.trim();
      if (!output) return false;
      const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
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
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";
const MIN_NODE_VERSION = "22.19.0";
function runCommand$1(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    child_process.execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeout ?? 15e3,
        maxBuffer: 1024 * 1024 * 4
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandError = error;
          commandError.stdout = stdout;
          commandError.stderr = stderr;
          reject(commandError);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}
function nodeCommand() {
  if (process.env.PI_NODE_PATH) return process.env.PI_NODE_PATH;
  return process.platform === "win32" ? "node.exe" : "node";
}
function runNpmCommand$1(args, options = {}) {
  if (process.platform === "win32") {
    return runCommand$1("cmd.exe", ["/d", "/s", "/c", "npm", ...args], options);
  }
  return runCommand$1("npm", args, options);
}
function parseVersion$1(version) {
  return version.replace(/^v/, "").split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
}
function compareVersions$1(a, b) {
  const left = parseVersion$1(a);
  const right = parseVersion$1(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
function formatError$1(error) {
  const err = error;
  const detail = (err.stderr || err.stdout || err.message || String(error)).trim();
  return detail.split(/\r?\n/).filter(Boolean).slice(-3).join("\n");
}
async function readJsonFile$1(filePath) {
  try {
    return JSON.parse(await promises.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}
async function findPackageRoot() {
  const candidates = Array.from(/* @__PURE__ */ new Set([
    process.cwd(),
    electron.app.getAppPath()
  ]));
  for (const candidate of candidates) {
    const packageJsonPath = path.join(candidate, "package.json");
    if (!fs.existsSync(packageJsonPath)) continue;
    const packageJson = await readJsonFile$1(packageJsonPath);
    if (packageJson?.name === "hpp" || packageJson?.dependencies?.[PI_SDK_PACKAGE] || packageJson?.devDependencies?.[PI_SDK_PACKAGE]) {
      return candidate;
    }
  }
  return void 0;
}
async function getInstalledVersion(packageRoot) {
  const packageJson = await readJsonFile$1(
    path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")
  );
  return packageJson?.version;
}
async function getLatestVersion(packageRoot) {
  const { stdout } = await runNpmCommand$1(
    ["view", PI_SDK_PACKAGE, "version", "--json"],
    { cwd: packageRoot, timeout: 15e3 }
  );
  const raw = stdout.trim();
  if (!raw) return void 0;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : void 0;
  } catch {
    return raw.replace(/^"|"$/g, "");
  }
}
async function getNodeStatus() {
  try {
    const { stdout } = await runCommand$1(nodeCommand(), ["-v"], { timeout: 5e3 });
    const nodeVersion = stdout.trim().replace(/^v/, "");
    return {
      nodeVersion,
      nodeOk: compareVersions$1(nodeVersion, MIN_NODE_VERSION) >= 0
    };
  } catch {
    return { nodeOk: false };
  }
}
async function getPiSDKStatus() {
  const packageRoot = await findPackageRoot();
  const currentVersion = packageRoot ? await getInstalledVersion(packageRoot) : void 0;
  const nodeStatus = await getNodeStatus();
  let latestVersion;
  let error;
  try {
    latestVersion = await getLatestVersion(packageRoot);
  } catch (err) {
    error = `无法检查最新版本：${formatError$1(err)}`;
  }
  const updateAvailable = !!(currentVersion && latestVersion && compareVersions$1(currentVersion, latestVersion) < 0);
  return {
    installed: !!currentVersion,
    currentVersion,
    latestVersion,
    updateAvailable,
    canUpdate: !!packageRoot && !electron.app.isPackaged,
    packageRoot,
    ...nodeStatus,
    error
  };
}
let updateInProgress$1 = false;
function registerPiSDKHandlers() {
  electron.ipcMain.handle("pi-sdk:getStatus", async () => getPiSDKStatus());
  electron.ipcMain.handle("pi-sdk:update", async () => {
    if (updateInProgress$1) {
      return { success: false, error: "Pi SDK 正在更新中" };
    }
    const packageRoot = await findPackageRoot();
    if (!packageRoot) {
      return { success: false, error: "未找到 Hpp 的 package.json" };
    }
    if (electron.app.isPackaged) {
      return { success: false, error: "打包版暂不支持自动更新 Pi SDK" };
    }
    updateInProgress$1 = true;
    try {
      await runNpmCommand$1(
        ["install", `${PI_SDK_PACKAGE}@latest`],
        { cwd: packageRoot, timeout: 18e4 }
      );
      return { success: true, status: await getPiSDKStatus() };
    } catch (err) {
      return { success: false, error: formatError$1(err), status: await getPiSDKStatus() };
    } finally {
      updateInProgress$1 = false;
    }
  });
}
const CLI_AGENTS = {
  opencode: {
    command: "opencode",
    packageName: "opencode-ai",
    displayName: "OpenCode"
  },
  droid: {
    command: "droid",
    packageName: "droid",
    displayName: "Factory Droid"
  }
};
const PACKAGE_AGENTS = {
  codex: {
    packageName: "@openai/codex",
    displayName: "Codex CLI",
    packagePath: ["@openai", "codex"]
  }
};
const updateInProgress = /* @__PURE__ */ new Set();
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    child_process.execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeout ?? 15e3,
        maxBuffer: 1024 * 1024 * 4
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandError = error;
          commandError.stdout = stdout;
          commandError.stderr = stderr;
          reject(commandError);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}
function runShellCommand(command, args, options = {}) {
  const parts = [command, ...args].map((a) => {
    if (/[\s"]/.test(a)) {
      return JSON.stringify(a);
    }
    return a;
  });
  const fullCommand = parts.join(" ");
  return new Promise((resolve, reject) => {
    child_process.exec(
      fullCommand,
      {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeout ?? 15e3,
        maxBuffer: 1024 * 1024 * 4
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandError = error;
          commandError.stdout = stdout;
          commandError.stderr = stderr;
          reject(commandError);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}
function runNpmCommand(args, options = {}) {
  return runShellCommand("npm", args, options);
}
function parseVersion(version) {
  return version.replace(/^v/, "").split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
}
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
function formatError(error) {
  const err = error;
  const detail = (err.stderr || err.stdout || err.message || String(error)).trim();
  return detail.split(/\r?\n/).filter(Boolean).slice(-3).join("\n");
}
function extractVersion(output) {
  return output.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1];
}
function splitCommandPaths(output) {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
async function readJsonFile(filePath) {
  try {
    return JSON.parse(await promises.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}
async function findProjectPackageRoot(packageName) {
  const candidates = Array.from(/* @__PURE__ */ new Set([
    process.cwd(),
    electron.app.getAppPath()
  ]));
  for (const candidate of candidates) {
    const packageJsonPath = path.join(candidate, "package.json");
    if (!fs.existsSync(packageJsonPath)) continue;
    const packageJson = await readJsonFile(packageJsonPath);
    if (packageJson?.dependencies?.[packageName] || packageJson?.devDependencies?.[packageName]) {
      return candidate;
    }
  }
  return void 0;
}
async function commandExists(command) {
  try {
    const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
    const lookupArgs = process.platform === "win32" ? [command] : ["-a", command];
    const { stdout } = await runCommand(lookupCommand, lookupArgs, { timeout: 5e3 });
    return splitCommandPaths(stdout).some((path2) => !path2.includes("node_modules"));
  } catch {
    return false;
  }
}
async function getCommandVersion(command) {
  try {
    const { stdout, stderr } = await runShellCommand(command, ["--version"], { timeout: 5e3 });
    return extractVersion(`${stdout}
${stderr}`);
  } catch {
    return void 0;
  }
}
async function getLatestPackageVersion(packageName) {
  const { stdout } = await runNpmCommand(["view", packageName, "version", "--json"], {
    timeout: 15e3
  });
  const raw = stdout.trim();
  if (!raw) return void 0;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : void 0;
  } catch {
    return raw.replace(/^"|"$/g, "");
  }
}
async function getCliAgentStatus(config) {
  const installed = await commandExists(config.command);
  if (!installed) {
    return {
      installed: false,
      updateAvailable: false,
      canUpdate: false
    };
  }
  const currentVersion = await getCommandVersion(config.command);
  let latestVersion;
  let error;
  try {
    latestVersion = await getLatestPackageVersion(config.packageName);
  } catch (err) {
    error = `无法检查 ${config.displayName} 最新版本：${formatError(err)}`;
  }
  const canUpdate = await commandExists("npm");
  const updateAvailable = !!(currentVersion && latestVersion && compareVersions(currentVersion, latestVersion) < 0);
  return {
    installed: true,
    currentVersion,
    latestVersion,
    updateAvailable,
    canUpdate,
    error
  };
}
async function getPackageAgentStatus(config) {
  const packageRoot = await findProjectPackageRoot(config.packageName);
  const packageJsonPath = packageRoot ? path.join(packageRoot, "node_modules", ...config.packagePath, "package.json") : void 0;
  const packageJson = packageJsonPath ? await readJsonFile(packageJsonPath) : null;
  const currentVersion = packageJson?.version;
  let latestVersion;
  let error;
  try {
    latestVersion = await getLatestPackageVersion(config.packageName);
  } catch (err) {
    error = `无法检查 ${config.displayName} 最新版本：${formatError(err)}`;
  }
  const updateAvailable = !!(currentVersion && latestVersion && compareVersions(currentVersion, latestVersion) < 0);
  return {
    installed: !!currentVersion,
    currentVersion,
    latestVersion,
    updateAvailable,
    canUpdate: !!packageRoot && !electron.app.isPackaged,
    error
  };
}
async function getAgentStatus(agentId) {
  const packageConfig = PACKAGE_AGENTS[agentId];
  if (packageConfig) return getPackageAgentStatus(packageConfig);
  const config = CLI_AGENTS[agentId];
  if (!config) {
    return {
      installed: false,
      updateAvailable: false,
      canUpdate: false,
      error: `不支持的 agent: ${agentId}`
    };
  }
  return getCliAgentStatus(config);
}
async function updateAgent(agentId) {
  const packageConfig = PACKAGE_AGENTS[agentId];
  if (packageConfig) {
    if (updateInProgress.has(agentId)) {
      return { success: false, error: `${packageConfig.displayName} 正在更新中` };
    }
    const packageRoot = await findProjectPackageRoot(packageConfig.packageName);
    if (!packageRoot) {
      return { success: false, error: `未找到包含 ${packageConfig.packageName} 的 package.json` };
    }
    if (electron.app.isPackaged) {
      return { success: false, error: `打包版暂不支持自动更新 ${packageConfig.displayName}` };
    }
    updateInProgress.add(agentId);
    try {
      await runNpmCommand(["install", `${packageConfig.packageName}@latest`], {
        cwd: packageRoot,
        timeout: 18e4
      });
      return { success: true, status: await getAgentStatus(agentId) };
    } catch (err) {
      return { success: false, error: formatError(err), status: await getAgentStatus(agentId) };
    } finally {
      updateInProgress.delete(agentId);
    }
  }
  const config = CLI_AGENTS[agentId];
  if (!config) {
    return { success: false, error: `不支持的 agent: ${agentId}` };
  }
  if (updateInProgress.has(agentId)) {
    return { success: false, error: `${config.displayName} 正在更新中` };
  }
  if (!await commandExists("npm")) {
    return {
      success: false,
      error: "未找到 npm，无法自动更新 CLI agent",
      status: await getAgentStatus(agentId)
    };
  }
  updateInProgress.add(agentId);
  try {
    await runNpmCommand(["install", "-g", `${config.packageName}@latest`], {
      timeout: 18e4
    });
    return { success: true, status: await getAgentStatus(agentId) };
  } catch (err) {
    return { success: false, error: formatError(err), status: await getAgentStatus(agentId) };
  } finally {
    updateInProgress.delete(agentId);
  }
}
function registerAgentStatusHandlers() {
  electron.ipcMain.handle("agent:getStatus", async (_event, agentId) => {
    return getAgentStatus(agentId);
  });
  electron.ipcMain.handle("agent:update", async (_event, agentId) => {
    return updateAgent(agentId);
  });
}
const STREAM_FLUSH_INTERVAL_MS = 50;
const MAX_BUFFERED_CHARS = 4e3;
class AgentEventBuffer {
  window = null;
  hppSessionId;
  queue = [];
  bufferedChars = 0;
  flushTimer = null;
  constructor(hppSessionId) {
    this.hppSessionId = hppSessionId;
  }
  setWindow(win) {
    this.window = win;
  }
  send(data) {
    if (this.isStreamDelta(data)) {
      this.enqueueDelta(data.type, String(data.delta || ""));
      return;
    }
    this.flush();
    this.sendNow(data);
  }
  flush() {
    this.clearTimer();
    while (this.queue.length > 0) {
      const event = this.queue.shift();
      this.sendNow(event);
    }
    this.bufferedChars = 0;
  }
  clear() {
    this.clearTimer();
    this.queue = [];
    this.bufferedChars = 0;
  }
  enqueueDelta(type, delta) {
    if (!delta) return;
    const last = this.queue[this.queue.length - 1];
    if (last?.type === type) {
      last.delta += delta;
    } else {
      this.queue.push({ type, delta });
    }
    this.bufferedChars += delta.length;
    if (this.bufferedChars >= MAX_BUFFERED_CHARS) {
      this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), STREAM_FLUSH_INTERVAL_MS);
    }
  }
  sendNow(data) {
    const payload = data && typeof data === "object" ? { ...data, sessionId: this.hppSessionId } : data;
    this.window?.webContents.send("agent:event", payload);
  }
  isStreamDelta(data) {
    if (!data || typeof data !== "object") return false;
    const type = data.type;
    return type === "stream_delta" || type === "thinking_delta";
  }
  clearTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
const normalizeEventToken = (value) => String(value || "").trim().toLowerCase().replace(/[\s._:-]+/g, "");
const isContextCompactionLike = (...values) => {
  const normalized = values.map(normalizeEventToken).filter(Boolean);
  return normalized.some(
    (value) => value.includes("contextcompaction") || value.includes("compactedcontext") || value.includes("compactcontext") || value.includes("contextcompact") || value.includes("contextsummary") || value.includes("summarizecontext") || value.includes("contextsummarized") || value.includes("conversationcompaction") || value.includes("conversationcompacted") || value.includes("conversationcompact") || value.includes("memorycompaction") || value.includes("压缩上下文") || value.includes("上下文压缩") || value.includes("上下文已自动压缩")
  );
};
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
  question: [
    "question",
    "questionnaire",
    "ask",
    "ask_question",
    "ask-followup-question",
    "ask_followup_question",
    "ask-user-question",
    "ask_user",
    "ask_user_question",
    "user_ask_question",
    "request_user",
    "request_user_input",
    "request_user_selection",
    "droid.ask_user"
  ]
};
const normalizeName = (value) => String(value || "").trim().toLowerCase();
const matchesToolAlias = (normalized, alias) => normalized === alias || normalized.endsWith(`.${alias}`) || normalized.endsWith(`/${alias}`) || normalized.endsWith(`:${alias}`) || normalized.endsWith(`__${alias}`);
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
    if (aliases.some((alias) => matchesToolAlias(normalized, alias))) return kind;
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
  const detailObject = data.detail && typeof data.detail === "object" ? data.detail : {};
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
    requestId: toolKind === "question" && toolCallId ? String(toolCallId) : void 0,
    method: toolKind === "question" ? toolName : void 0,
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
    pattern: pattern || void 0,
    question: data.question || detailObject.question || args?.question || args?.prompt || void 0,
    prompt: data.prompt || detailObject.prompt || args?.prompt || void 0,
    message: data.message || detailObject.message || args?.message || void 0,
    questions: data.questions || detailObject.questions || args?.questions || void 0,
    options: data.options || detailObject.options || args?.options || args?.choices || void 0
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
  const detailObject = data.detail && typeof data.detail === "object" ? data.detail : {};
  const argsObject = data.args && typeof data.args === "object" ? data.args : {};
  const inputObject = data.input && typeof data.input === "object" ? data.input : {};
  const prompt = data.title || data.question || data.prompt || data.message || data.placeholder || findFirstString(data, [
    ["detail", "title"],
    ["detail", "message"],
    ["detail", "question"],
    ["detail", "prompt"],
    ["args", "title"],
    ["args", "message"],
    ["args", "question"],
    ["args", "prompt"],
    ["input", "title"],
    ["input", "message"],
    ["input", "question"],
    ["input", "prompt"]
  ]);
  const questions = data.questions || detailObject.questions || detailObject.params?.questions || data.args?.questions || data.input?.questions;
  const options = data.options || detailObject.options || detailObject.choices || detailObject.params?.options || detailObject.params?.choices || data.args?.options || data.args?.choices || data.input?.options || data.input?.choices;
  const detail = prompt || unwrapToolText(data.args) || unwrapToolText(data.input) || (typeof data.detail === "string" ? data.detail : stringifyProcessValue(data.detail || data));
  return {
    type: "process_event",
    entryType: "question",
    kind: "question",
    requestId: data.requestId || data.id || data.toolCallId || data.callId || detailObject.id,
    method: data.method || data.toolName || data.name || data.type,
    title: prompt ? `正在询问用户: ${String(prompt)}` : "正在询问用户",
    detail,
    prompt: prompt || void 0,
    question: data.question || detailObject.question || argsObject.question || inputObject.question || void 0,
    questions,
    options,
    state: data.state || "running"
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
  hppSessionId;
  port = 0;
  host = "127.0.0.1";
  projectPath = "";
  sessionId = null;
  models = [];
  currentModelId = null;
  currentProviderId = null;
  eventSource = null;
  sseBuffer = "";
  streamedContent = false;
  idleTimer = null;
  runningToolParts = /* @__PURE__ */ new Set();
  completedToolParts = /* @__PURE__ */ new Set();
  pendingQuestionToolParts = /* @__PURE__ */ new Set();
  eventBuffer;
  constructor(hppSessionId = "default") {
    this.hppSessionId = hppSessionId;
    this.eventBuffer = new AgentEventBuffer(hppSessionId);
  }
  setWindow(win) {
    this.window = win;
    this.eventBuffer.setWindow(win);
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
  async sendMessage(message, _images, options) {
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
      if (options?.planModeEnabled) {
        body.agent = "plan";
      }
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
    this.sseBuffer = "";
    this.streamedContent = false;
    this.runningToolParts.clear();
    this.completedToolParts.clear();
    this.pendingQuestionToolParts.clear();
    const req = http__namespace.get(
      `http://${this.host}:${this.port}/event`,
      (res) => {
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          this.sseBuffer += chunk;
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
    const lines = this.sseBuffer.split("\n");
    this.sseBuffer = lines.pop() || "";
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
    const part = props.part || props;
    if (isContextCompactionLike(
      eventType,
      props.type,
      props.name,
      props.title,
      props.message,
      props.status,
      part.type,
      part.name,
      part.title,
      part.message
    )) {
      this.emitEvent({ type: "context_compaction", id: part.id || props.partID || props.partId || props.id || data.id });
      return;
    }
    switch (eventType) {
      case "message.part.added":
      case "message.part.updated": {
        if (isToolLikePart(props)) {
          const tool = summarizeToolPart(props);
          if (this.completedToolParts.has(tool.toolCallId)) break;
          if (isAskUserName(tool.toolName)) {
            if (!this.pendingQuestionToolParts.has(tool.toolCallId)) {
              this.pendingQuestionToolParts.add(tool.toolCallId);
              this.runningToolParts.add(tool.toolCallId);
              this.emitEvent(normalizeQuestionProcessEvent({
                ...tool,
                id: tool.toolCallId,
                requestId: tool.toolCallId,
                method: tool.toolName,
                args: tool.args,
                detail: tool.args || tool.detail
              }));
            }
            break;
          }
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
          if (isAskUserName(tool.toolName)) {
            this.runningToolParts.delete(tool.toolCallId);
            this.pendingQuestionToolParts.delete(tool.toolCallId);
            this.completedToolParts.add(tool.toolCallId);
            break;
          }
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
    this.eventBuffer.flush();
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
    this.eventBuffer.send(data);
  }
}
class DroidAgent {
  process = null;
  window = null;
  hppSessionId;
  projectPath = "";
  sessionId = null;
  models = [];
  rpcId = 0;
  pendingResponses = /* @__PURE__ */ new Map();
  pendingAskUserRequestId = null;
  isReady = false;
  autonomyLevel = "medium";
  interactionMode = "auto";
  eventBuffer;
  constructor(hppSessionId = "default") {
    this.hppSessionId = hppSessionId;
    this.eventBuffer = new AgentEventBuffer(hppSessionId);
  }
  setWindow(win) {
    this.window = win;
    this.eventBuffer.setWindow(win);
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
      autonomyLevel: this.autonomyLevel,
      interactionMode: this.interactionMode
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
  async sendMessage(message, images, options) {
    if (!this.process || !this.isReady) {
      this.mockResponse(message);
      return;
    }
    this.emitEvent({ type: "stream_start", role: "assistant" });
    await this.setInteractionMode(options?.planModeEnabled ? "spec" : "auto");
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
    if (this.pendingAskUserRequestId) {
      this.sendRpcResponse(this.pendingAskUserRequestId, { cancelled: true, answers: [] });
      this.pendingAskUserRequestId = null;
    }
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
      this.sendRpc("droid.update_session_settings", { modelId });
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
      this.sendRpc("droid.update_session_settings", { reasoningEffort: effortMap[level] || level });
    }
    this.emitEvent({ type: "thinking_level_changed", level });
  }
  async setInteractionMode(mode) {
    if (this.interactionMode === mode) return;
    this.interactionMode = mode;
    if (this.process && this.isReady) {
      await this.sendRpcAsync("droid.update_session_settings", { interactionMode: mode });
    }
    this.emitEvent({ type: "process_event", entryType: "status", title: mode === "spec" ? "Droid 已进入 Spec 模式" : "Droid 已切回 Auto 模式", state: "completed" });
  }
  sendUIResponse(response) {
    if (!this.process || !this.isReady) return;
    if (this.pendingAskUserRequestId) {
      const text = typeof response?.text === "string" ? response.text : typeof response?.value === "string" ? response.value : "";
      this.sendRpcResponse(this.pendingAskUserRequestId, {
        cancelled: false,
        answers: Array.isArray(response?.answers) && response.answers.length > 0 ? response.answers : [{ value: text }]
      });
      this.pendingAskUserRequestId = null;
      return;
    }
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
    this.pendingAskUserRequestId = null;
    this.eventBuffer.flush();
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
  sendRpcAsync(method, params) {
    return new Promise((resolve) => {
      this.sendRpc(method, params, resolve);
    });
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
        this.pendingAskUserRequestId = requestId;
        this.emitEvent(normalizeQuestionProcessEvent({ type: method, detail: params }));
        break;
    }
  }
  handleNotification(method, params) {
    const notification = params?.notification || params;
    const notifType = notification?.type || method;
    const notifData = notification?.data || notification;
    if (isContextCompactionLike(
      method,
      notifType,
      notifData?.type,
      notifData?.name,
      notifData?.title,
      notifData?.message,
      notifData?.status
    )) {
      this.emitEvent({ type: "context_compaction", id: notifData?.id || notification?.id || params?.id });
      return;
    }
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
    this.eventBuffer.send(data);
  }
}
const getWorkerPath$1 = () => {
  const candidates = [
    path.join(__dirname, "pi-sdk-worker.mjs"),
    path.join(electron.app.getAppPath(), "electron", "agents", "pi-sdk-worker.mjs"),
    path.join(process.cwd(), "electron", "agents", "pi-sdk-worker.mjs")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[candidates.length - 1];
};
const getNodeExecutable$1 = () => {
  if (process.env.PI_NODE_PATH) return process.env.PI_NODE_PATH;
  return process.platform === "win32" ? "node.exe" : "node";
};
class PiSDKAgent {
  constructor(hppSessionId = "default") {
    this.hppSessionId = hppSessionId;
    this.eventBuffer = new AgentEventBuffer(hppSessionId);
  }
  process = null;
  window = null;
  projectPath = "";
  _sessionFilePath = null;
  eventBuffer;
  pendingResponses = /* @__PURE__ */ new Map();
  requestId = 0;
  models = [];
  pendingAssistantText = "";
  streamedText = false;
  streamedTextBuffer = "";
  emittedAssistantTextSnapshot = "";
  pendingUIRequestIds = /* @__PURE__ */ new Set();
  turnFallbackTimer = null;
  isAborting = false;
  activePromptIds = /* @__PURE__ */ new Set();
  turnActive = false;
  turnToken = 0;
  get sessionFilePath() {
    return this._sessionFilePath;
  }
  setWindow(win) {
    this.window = win;
    this.eventBuffer.setWindow(win);
  }
  async init(projectPath, existingSessionFilePath) {
    if (this.process && this.projectPath === projectPath && this._sessionFilePath === (existingSessionFilePath || this._sessionFilePath)) {
      return;
    }
    this.dispose();
    this.projectPath = projectPath;
    this._sessionFilePath = existingSessionFilePath || null;
    this.emitEvent({ type: "agent_init", agentId: "pi" });
    const child = child_process.spawn(getNodeExecutable$1(), [getWorkerPath$1()], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    this.process = child;
    const decoder = new string_decoder.StringDecoder("utf8");
    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        try {
          this.handleWorkerMessage(JSON.parse(line));
        } catch {
        }
      }
    });
    child.stderr?.on("data", (chunk) => {
      console.log("[pi-sdk-worker]", chunk.toString().trim());
    });
    child.on("error", (error) => {
      this.emitEvent({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "Pi 启动失败",
        detail: `${error.message}
请确认系统 PATH 中的 node 版本 >= 22，或设置 PI_NODE_PATH 指向 Node 22。`,
        state: "error"
      });
      for (const handler of this.pendingResponses.values()) handler({ type: "error", error: error.message });
      this.pendingResponses.clear();
    });
    child.on("exit", () => {
      if (this.process === child) this.process = null;
      if (!this.isAborting) {
        this.emitEvent({ type: "agent_disconnected" });
      }
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(initId);
        reject(new Error("Pi SDK worker init timed out"));
      }, 12e3);
      const initId = this.sendWorkerCommand({
        type: "init",
        projectPath,
        sessionFilePath: existingSessionFilePath
      }, (data) => {
        clearTimeout(timeout);
        if (data.type === "ready") {
          this._sessionFilePath = data.sessionFilePath || existingSessionFilePath || null;
          this.emitEvent({ type: "agent_ready", agentId: "pi", mock: false });
          resolve();
        } else {
          reject(new Error(data.error || "Pi SDK worker init failed"));
        }
      });
    });
  }
  async sendMessage(message, images, options) {
    if (!this.process) throw new Error("Pi SDK worker is not running");
    if (this.isAborting) this.finishAbortState();
    if (this.turnActive) {
      this.completeTurn(true);
    } else {
      this.prepareNewTurn();
    }
    const promptId = this.createCommandId();
    this.activePromptIds.add(promptId);
    this.emitEvent({ type: "message_start", role: "user", content: options?.displayMessage || message });
    this.beginTurn();
    this.sendWorkerCommand({ id: promptId, type: "prompt", message, images });
  }
  async abort() {
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.turnActive = false;
    this.eventBuffer.clear();
    this.clearTurnFallback();
    this.emitEvent({ type: "thinking_end" });
    this.emitEvent({ type: "stream_end", content: "" });
    this.emitEvent({ type: "agent_end" });
    this.isAborting = true;
    if (!this.process) {
      this.finishAbortState();
      return;
    }
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5e3);
      this.sendWorkerCommand({ type: "abort" }, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.finishAbortState();
  }
  async getModels() {
    if (this.models.length > 0) return this.models;
    if (!this.process) return [];
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve([]), 4e3);
      this.sendWorkerCommand({ type: "getModels" }, (data) => {
        clearTimeout(timeout);
        this.models = Array.isArray(data.models) ? data.models : [];
        resolve(this.models);
      });
    });
  }
  async setModel(provider, modelId) {
    this.sendWorkerCommand({ type: "setModel", provider, modelId }, (data) => {
      if (data.type === "model_changed") this.emitEvent({ type: "model_changed", model: data.model });
    });
  }
  async setThinkingLevel(level) {
    this.sendWorkerCommand({ type: "setThinkingLevel", level }, (data) => {
      if (data.type === "thinking_level_changed") this.emitEvent({ type: "thinking_level_changed", level: data.level });
    });
  }
  sendUIResponse(response) {
    const id = response?.id;
    if (id) {
      this.pendingUIRequestIds.delete(String(id));
      if (this.pendingUIRequestIds.size === 0 && (this.pendingAssistantText || this.streamedText)) {
        this.scheduleTurnFallback(4e3);
      }
    }
    this.sendWorkerCommand({
      type: "uiResponse",
      response: {
        id,
        value: response?.value ?? response?.text,
        confirmed: response?.confirmed,
        cancelled: !!response?.cancelled,
        result: response?.result ?? (response?.answers ? { cancelled: false, answers: response.answers } : void 0)
      }
    });
  }
  dispose() {
    this.clearTurnFallback();
    this.pendingResponses.clear();
    this.pendingUIRequestIds.clear();
    this.eventBuffer.flush();
    const child = this.process;
    this.process = null;
    if (child) {
      child.stdin?.write(`${JSON.stringify({ type: "dispose" })}
`);
      setTimeout(() => child.kill(), 500);
    }
  }
  handleWorkerMessage(data) {
    if (data.id) {
      const handler = this.pendingResponses.get(data.id);
      if (handler) {
        this.pendingResponses.delete(data.id);
        handler(data);
      }
    }
    switch (data.type) {
      case "context_compaction":
        this.emitEvent({ type: "context_compaction", id: data.id });
        break;
      case "ready":
        for (const handler of this.pendingResponses.values()) handler(data);
        this.pendingResponses.clear();
        break;
      case "agent_start":
        this.beginTurn();
        break;
      case "message_update": {
        if (!this.turnActive && this.activePromptIds.size > 0) this.beginTurn();
        if (!this.turnActive) break;
        this.clearTurnFallback();
        const assistantEvent = data.assistantMessageEvent;
        if (assistantEvent?.type === "text_delta") {
          const delta = assistantEvent.delta || "";
          if (delta) {
            this.streamedText = true;
            this.streamedTextBuffer += delta;
          }
          this.emitEventThrottled({ type: "stream_delta", delta });
        } else if (assistantEvent?.type === "thinking_delta") {
          this.emitEventThrottled({ type: "thinking_delta", delta: assistantEvent.delta || "" });
        }
        break;
      }
      case "message_end":
        if (!this.turnActive && this.activePromptIds.size === 0) break;
        if (!this.turnActive) this.beginTurn();
        if (data.message?.role === "assistant") {
          if (data.message.thinking) this.emitEvent({ type: "thinking_end" });
          const stopReason = String(data.message.stopReason || "");
          const errorMessage = String(data.message.errorMessage || "").trim();
          if (stopReason === "error" || errorMessage) {
            this.pendingAssistantText = "";
            this.streamedText = false;
            this.streamedTextBuffer = "";
            this.emittedAssistantTextSnapshot = "";
            this.pendingUIRequestIds.clear();
            this.activePromptIds.clear();
            this.clearTurnFallback();
            this.emitEvent({
              type: "process_event",
              entryType: "error",
              kind: "error",
              title: "模型请求失败",
              detail: errorMessage || `Assistant stopped with reason: ${stopReason || "error"}`,
              state: "error"
            });
            this.completeTurn(true);
            break;
          }
          if (data.message.text) {
            this.pendingAssistantText = data.message.text;
            this.emitPendingAssistantText();
            if (this.pendingUIRequestIds.size === 0) {
              this.scheduleTurnFallback(4e3, true);
            }
          }
        }
        break;
      case "tool_execution_start":
        this.clearTurnFallback();
        this.emitEvent(normalizeToolEvent("tool_start", { ...data, args: data.args, name: data.toolName }));
        break;
      case "tool_execution_update": {
        const detail = unwrapToolText(data.partialResult);
        if (detail) {
          this.emitEvent(normalizeToolEvent("tool_start", {
            ...data,
            args: data.args,
            result: data.partialResult,
            detail,
            name: data.toolName
          }));
        }
        break;
      }
      case "tool_execution_end": {
        const toolEvent = normalizeToolEvent("tool_end", {
          ...data,
          args: data.args,
          result: data.result,
          output: data.result,
          name: data.toolName
        });
        this.emitEvent(toolEvent);
        const diffs = buildDiffsFromToolEvent(toolEvent);
        if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
        break;
      }
      case "extension_ui_request":
        this.handleUIRequest(data.request);
        break;
      case "prompt_done":
        if (data.id && !this.activePromptIds.delete(String(data.id))) break;
        if (!data.id) this.activePromptIds.clear();
        this.pendingUIRequestIds.clear();
        this.completeTurn(true);
        break;
      case "agent_end":
        if (this.activePromptIds.size === 0) this.scheduleTurnFallback(250, true);
        break;
      case "error":
        if (data.id && !this.activePromptIds.delete(String(data.id))) break;
        if (isContextCompactionLike(data.error, data.title, data.message)) {
          this.emitEvent({ type: "context_compaction", id: data.id });
          break;
        }
        this.pendingUIRequestIds.clear();
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          kind: "error",
          title: "Pi 运行失败",
          detail: data.error || "Unknown error",
          state: "error"
        });
        this.completeTurn(true);
        break;
    }
  }
  handleUIRequest(request) {
    if (!request || request.method === "notify") return;
    this.pendingUIRequestIds.add(String(request.id));
    this.clearTurnFallback();
    this.emitPendingAssistantText();
    this.emitEvent(normalizeQuestionProcessEvent({
      type: "extension_ui_request",
      id: request.id,
      requestId: request.id,
      method: request.method === "custom" ? request.kind : request.method,
      title: request.method === "custom" && request.kind === "ask_user_question" ? "请选择答案" : request.title || request.message || "正在询问用户",
      detail: request,
      questions: request.method === "custom" ? request.questions : void 0,
      toolName: request.toolName,
      state: "running"
    }));
  }
  sendWorkerCommand(command, onResponse) {
    const id = command.id || this.createCommandId();
    const fullCommand = { ...command, id };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(`${JSON.stringify(fullCommand)}
`);
    return id;
  }
  createCommandId() {
    return `sdk-${++this.requestId}`;
  }
  clearTurnFallback() {
    if (this.turnFallbackTimer) {
      clearTimeout(this.turnFallbackTimer);
      this.turnFallbackTimer = null;
    }
  }
  scheduleTurnFallback(delayMs, force = false) {
    if (!force && this.pendingUIRequestIds.size > 0) return;
    this.clearTurnFallback();
    const token = this.turnToken;
    this.turnFallbackTimer = setTimeout(() => {
      this.turnFallbackTimer = null;
      if (token !== this.turnToken) return;
      if (force || this.pendingAssistantText || this.streamedText) this.completeTurn(force);
    }, delayMs);
  }
  beginTurn() {
    this.clearTurnFallback();
    if (this.turnActive) return;
    this.turnToken += 1;
    this.turnActive = true;
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.emittedAssistantTextSnapshot = "";
    this.pendingAssistantText = "";
    this.emitEvent({ type: "stream_start", role: "assistant" });
  }
  completeTurn(force = false) {
    if (!this.turnActive) return;
    if (force) {
      this.pendingUIRequestIds.clear();
      this.activePromptIds.clear();
    }
    if (this.pendingUIRequestIds.size > 0) return;
    if (this.activePromptIds.size > 0) return;
    this.clearTurnFallback();
    this.eventBuffer.flush();
    this.emitPendingAssistantText();
    this.emitEvent({ type: "stream_end", content: this.pendingAssistantText, force });
    this.emitEvent({ type: "agent_end" });
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.emittedAssistantTextSnapshot = "";
    this.turnActive = false;
    this.turnToken += 1;
  }
  emitPendingAssistantText() {
    if (!this.pendingAssistantText || this.emittedAssistantTextSnapshot === this.pendingAssistantText) return;
    if (!this.streamedText) {
      this.emitEvent({ type: "stream_delta", delta: this.pendingAssistantText });
      this.streamedTextBuffer = this.pendingAssistantText;
      this.streamedText = true;
    } else if (this.streamedTextBuffer !== this.pendingAssistantText) {
      this.emitEvent({ type: "stream_snapshot", content: this.pendingAssistantText });
      this.streamedTextBuffer = this.pendingAssistantText;
    }
    this.emittedAssistantTextSnapshot = this.pendingAssistantText;
  }
  prepareNewTurn() {
    this.clearTurnFallback();
    this.eventBuffer.flush();
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.emittedAssistantTextSnapshot = "";
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.turnActive = false;
    this.turnToken += 1;
  }
  finishAbortState() {
    this.isAborting = false;
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.emittedAssistantTextSnapshot = "";
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.turnActive = false;
    this.turnToken += 1;
    this.eventBuffer.clear();
    this.clearTurnFallback();
  }
  emitEvent(data) {
    this.eventBuffer.send(data);
  }
  emitEventThrottled(data) {
    this.eventBuffer.send(data);
  }
}
const getWorkerPath = () => {
  const candidates = [
    path.join(__dirname, "codex-worker.mjs"),
    path.join(electron.app.getAppPath(), "electron", "agents", "codex-worker.mjs"),
    path.join(process.cwd(), "electron", "agents", "codex-worker.mjs")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[candidates.length - 1];
};
const getNodeExecutable = () => {
  if (process.env.CODEX_NODE_PATH) return process.env.CODEX_NODE_PATH;
  if (process.env.PI_NODE_PATH) return process.env.PI_NODE_PATH;
  return process.platform === "win32" ? "node.exe" : "node";
};
class CodexAgent {
  constructor(hppSessionId = "default") {
    this.hppSessionId = hppSessionId;
    this.eventBuffer = new AgentEventBuffer(hppSessionId);
  }
  process = null;
  window = null;
  projectPath = "";
  _sessionFilePath = null;
  eventBuffer;
  pendingResponses = /* @__PURE__ */ new Map();
  requestId = 0;
  models = [];
  isAborting = false;
  get sessionFilePath() {
    return this._sessionFilePath;
  }
  setWindow(win) {
    this.window = win;
    this.eventBuffer.setWindow(win);
  }
  async init(projectPath, existingSessionFilePath) {
    if (this.process && this.projectPath === projectPath && this._sessionFilePath === (existingSessionFilePath || this._sessionFilePath)) {
      return;
    }
    this.dispose();
    this.projectPath = projectPath;
    this._sessionFilePath = existingSessionFilePath || null;
    this.emitEvent({ type: "agent_init", agentId: "codex" });
    const child = child_process.spawn(getNodeExecutable(), [getWorkerPath()], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    this.process = child;
    const decoder = new string_decoder.StringDecoder("utf8");
    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        try {
          this.handleWorkerMessage(JSON.parse(line));
        } catch {
        }
      }
    });
    child.stderr?.on("data", (chunk) => {
      console.log("[codex-worker]", chunk.toString().trim());
    });
    child.on("error", (error) => {
      this.emitEvent({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "Codex 启动失败",
        detail: `${error.message}
请确认系统 PATH 中的 node 版本 >= 18，或设置 CODEX_NODE_PATH 指向 Node 18+。`,
        state: "error"
      });
      for (const handler of this.pendingResponses.values()) handler({ type: "error", error: error.message });
      this.pendingResponses.clear();
    });
    child.on("exit", () => {
      if (this.process === child) this.process = null;
      if (!this.isAborting) {
        this.emitEvent({ type: "agent_disconnected" });
      }
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(initId);
        reject(new Error("Codex worker init timed out"));
      }, 12e3);
      const initId = this.sendWorkerCommand({
        type: "init",
        projectPath,
        sessionFilePath: existingSessionFilePath
      }, (data) => {
        clearTimeout(timeout);
        if (data.type === "ready") {
          this._sessionFilePath = data.sessionFilePath || existingSessionFilePath || null;
          this.emitEvent({ type: "agent_ready", agentId: "codex", mock: false });
          resolve();
        } else {
          reject(new Error(data.error || "Codex worker init failed"));
        }
      });
    });
  }
  async sendMessage(message, images, options) {
    if (!this.process) throw new Error("Codex worker is not running");
    this.isAborting = false;
    const promptId = this.createCommandId();
    this.emitEvent({ type: "message_start", role: "user", content: options?.displayMessage || message });
    this.sendWorkerCommand({ id: promptId, type: "prompt", message, images, planModeEnabled: !!options?.planModeEnabled });
  }
  async abort() {
    this.isAborting = true;
    this.eventBuffer.clear();
    if (!this.process) {
      this.isAborting = false;
      return;
    }
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5e3);
      this.sendWorkerCommand({ type: "abort" }, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.isAborting = false;
  }
  async getModels() {
    if (!this.process) return [];
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve([]), 4e3);
      this.sendWorkerCommand({ type: "getModels" }, (data) => {
        clearTimeout(timeout);
        this.models = Array.isArray(data.models) ? data.models : [];
        resolve(this.models);
      });
    });
  }
  async setModel(provider, modelId) {
    this.sendWorkerCommand({ type: "setModel", provider, modelId }, (data) => {
      if (data.type === "model_changed") this.emitEvent({ type: "model_changed", model: data.model });
    });
  }
  async setThinkingLevel(level) {
    this.sendWorkerCommand({ type: "setThinkingLevel", level }, (data) => {
      if (data.type === "thinking_level_changed") this.emitEvent({ type: "thinking_level_changed", level: data.level });
    });
  }
  sendUIResponse(response) {
    this.sendWorkerCommand({
      type: "uiResponse",
      response: {
        id: response?.id,
        value: response?.value ?? response?.text,
        confirmed: response?.confirmed,
        cancelled: !!response?.cancelled,
        result: response?.result ?? (response?.answers ? { cancelled: false, answers: response.answers } : void 0)
      }
    });
  }
  dispose() {
    this.pendingResponses.clear();
    this.eventBuffer.flush();
    const child = this.process;
    this.process = null;
    if (child) {
      child.stdin?.write(`${JSON.stringify({ type: "dispose" })}
`);
      setTimeout(() => child.kill(), 500);
    }
  }
  handleWorkerMessage(data) {
    if (data.id) {
      const handler = this.pendingResponses.get(data.id);
      if (handler) {
        this.pendingResponses.delete(data.id);
        handler(data);
      }
    }
    switch (data.type) {
      case "ready":
        for (const handler of this.pendingResponses.values()) handler(data);
        this.pendingResponses.clear();
        break;
      case "session_file_path":
        this._sessionFilePath = data.sessionFilePath || data.threadId || this._sessionFilePath;
        this.emitEvent({ type: "session_file_path", sessionFilePath: this._sessionFilePath, threadId: data.threadId });
        break;
      case "agent_start":
        this.emitEvent({ type: "agent_start" });
        break;
      case "stream_start":
        this.emitEvent({ type: "stream_start", role: data.role || "assistant" });
        break;
      case "stream_delta":
        this.emitEvent({ type: "stream_delta", delta: data.delta || "" });
        break;
      case "stream_snapshot":
        this.emitEvent({ type: "stream_snapshot", content: data.content || "" });
        break;
      case "stream_end":
        this.emitEvent({ type: "stream_end", content: data.content || "", force: data.force });
        break;
      case "thinking_delta":
        this.emitEvent({ type: "thinking_delta", delta: data.delta || "" });
        break;
      case "thinking_end":
        this.emitEvent({ type: "thinking_end" });
        break;
      case "tool_start":
      case "tool_end":
      case "process_event":
      case "context_compaction":
      case "diff_update":
      case "agent_end":
        this.emitEvent(data);
        break;
      case "prompt_done":
        break;
      case "error":
        if (/Codex is already running/i.test(data.error || "")) {
          this.emitEvent({
            type: "process_event",
            entryType: "status",
            kind: "status",
            title: "Codex 仍在执行上一条请求",
            detail: "新的发送请求已忽略；当前 Codex 任务还在运行，后续输出会继续追加到当前处理中块。",
            state: "running"
          });
          break;
        }
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          kind: "error",
          title: "Codex 运行失败",
          detail: data.error || "Unknown error",
          state: "error"
        });
        break;
    }
  }
  sendWorkerCommand(command, onResponse) {
    const id = command.id || this.createCommandId();
    const fullCommand = { ...command, id };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(`${JSON.stringify(fullCommand)}
`);
    return id;
  }
  createCommandId() {
    return `codex-${++this.requestId}`;
  }
  emitEvent(data) {
    this.eventBuffer.send(data);
  }
}
let _localModelsConfig = null;
let _localModelsConfigMtime = 0;
function readLocalModelsConfig() {
  const configPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  try {
    const stat = fs.existsSync(configPath) ? fs.statSync(configPath) : null;
    const mtime = stat ? stat.mtimeMs : 0;
    if (_localModelsConfig && mtime <= _localModelsConfigMtime) {
      return _localModelsConfig;
    }
    const content = fs.readFileSync(configPath, "utf-8");
    _localModelsConfig = JSON.parse(content);
    _localModelsConfigMtime = mtime;
  } catch {
    _localModelsConfig = {};
    _localModelsConfigMtime = Date.now();
  }
  return _localModelsConfig;
}
function filterModelsByLocalConfig(models) {
  const config = readLocalModelsConfig();
  if (!config?.providers) return models;
  const result = [];
  for (const model of models) {
    const providerConfig = config.providers[model.provider];
    if (!providerConfig?.models) {
      result.push(model);
    } else {
      const configuredIds = new Set(providerConfig.models.map((m) => m.id));
      if (configuredIds.has(model.id)) {
        const configuredModel = providerConfig.models.find((m) => m.id === model.id);
        result.push({
          ...model,
          name: configuredModel?.name ?? model.name,
          reasoning: configuredModel?.reasoning ?? model.reasoning
        });
      }
    }
  }
  return result;
}
function supportsNativePlanMode(agentId) {
  return agentId === "codex" || agentId === "opencode" || agentId === "droid";
}
function withPromptPlanMode(message) {
  return [
    "<plan_mode>",
    "Plan mode is enabled for this turn.",
    "Before changing files, running commands, or using tools that modify state, first respond with a concise implementation plan and wait for the user to explicitly confirm.",
    "You may inspect context that is necessary to make the plan. If the user has already explicitly approved a previous plan in this conversation, proceed with the approved implementation.",
    "</plan_mode>",
    "",
    message
  ].join("\n");
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
  createAgentBackend(agentId, sessionId) {
    if (agentId === "codex") return new CodexAgent(sessionId);
    if (agentId === "opencode") return new OpenCodeAgent(sessionId);
    if (agentId === "droid") return new DroidAgent(sessionId);
    return new PiSDKAgent(sessionId);
  }
  /** Create or resume a session */
  async createSession(sessionId, agentId, projectPath, existingSessionFilePath) {
    console.log("[agent-manager] createSession:", sessionId, "agent:", agentId, "existingSessionFilePath:", existingSessionFilePath);
    let agent = this.sessionAgents.get(sessionId);
    if (!agent) {
      agent = this.createAgentBackend(agentId, sessionId);
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
  getSessionAgentType(sessionId) {
    return this.sessionAgentTypes.get(sessionId);
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
  getActiveAgentType() {
    return this.activeSessionId ? this.sessionAgentTypes.get(this.activeSessionId) : void 0;
  }
  async getModelsBySessionId(sessionId) {
    const agent = this.sessionAgents.get(sessionId);
    if (!agent) return [];
    const models = await agent.getModels();
    if (this.sessionAgentTypes.get(sessionId) === "codex") return models;
    return filterModelsByLocalConfig(models);
  }
  sendUIResponse(response) {
    const agent = response?.sessionId ? this.getAgentBySessionId(response.sessionId) : this.getActiveAgent();
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
  electron.ipcMain.handle("agent:sendMessage", async (_event, message, images, sessionId, options) => {
    const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
    if (!agent) return { success: false, error: "No active agent" };
    try {
      const agentType = sessionId ? agentManager.getSessionAgentType(sessionId) : agentManager.getActiveAgentType();
      const planModeEnabled = !!options?.planModeEnabled;
      const effectiveMessage = planModeEnabled && !supportsNativePlanMode(agentType) ? withPromptPlanMode(message) : message;
      await agent.sendMessage(effectiveMessage, images, {
        planModeEnabled: planModeEnabled && supportsNativePlanMode(agentType),
        displayMessage: message
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle("agent:abort", async (_event, sessionId) => {
    const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
    if (!agent) return { success: false };
    await agent.abort();
    return { success: true };
  });
  electron.ipcMain.handle("agent:getModels", async (_event, sessionId) => {
    const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
    console.log("[agent-manager] getModels sessionId:", sessionId, "agent:", agent ? agent.constructor.name : "null");
    if (!agent) return [];
    const models = await agent.getModels();
    const agentType = sessionId ? agentManager.getSessionAgentType(sessionId) : agentManager.getActiveAgentType();
    if (agentType === "codex") return models;
    return filterModelsByLocalConfig(models);
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
      nodeIntegration: false,
      backgroundThrottling: false
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
  registerPiSDKHandlers();
  registerAgentStatusHandlers();
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
