"use strict";
const electron = require("electron");
const promises = require("fs/promises");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const electronUpdater = require("electron-updater");
const os = require("os");
const child_process = require("child_process");
const fs = require("fs");
const https = require("https");
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
function getPathEnvKey(env = process.env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
}
function getPathEnvValue(env = process.env) {
  return env[getPathEnvKey(env)] || "";
}
function commandHasPath(command) {
  return command.includes("/") || command.includes("\\") || path.isAbsolute(command);
}
function getWindowsExecutableExtensions(env = process.env) {
  const configured = env.PATHEXT || ".EXE;.CMD;.BAT;.COM";
  return configured.split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
}
function getCommandNames(command, env = process.env) {
  if (process.platform !== "win32") return [command];
  const lower = command.toLowerCase();
  const hasKnownExtension = getWindowsExecutableExtensions(env).some((ext) => lower.endsWith(ext));
  if (hasKnownExtension) return [command];
  return [...getWindowsExecutableExtensions(env).map((ext) => `${command}${ext}`), command];
}
function findCommandOnPath(command, options = {}) {
  const env = options.env || process.env;
  if (!command.trim()) return void 0;
  if (commandHasPath(command)) {
    const normalized = path.normalize(command);
    return fs.existsSync(normalized) ? normalized : void 0;
  }
  const dirs = getPathEnvValue(env).split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of getCommandNames(command, env)) {
      const candidate = path.join(dir, name);
      if (!fs.existsSync(candidate)) continue;
      if (options.excludeNodeModules && candidate.includes(`${path.sep}node_modules${path.sep}`)) continue;
      return candidate;
    }
  }
  return void 0;
}
function resolveCommand(command, env = process.env) {
  return findCommandOnPath(command, { env }) || command;
}
function commandExists$1(command, options = {}) {
  return !!findCommandOnPath(command, {
    env: process.env,
    excludeNodeModules: options.excludeNodeModules
  });
}
function getCommandEnv(extra) {
  const env = { ...process.env, ...extra };
  const pathKey = getPathEnvKey(env);
  env[pathKey] = env[pathKey] || "";
  return env;
}
function getNodeExecutable(envKeys = []) {
  for (const key of envKeys) {
    const value = process.env[key];
    if (value && fs.existsSync(value)) return value;
  }
  return findCommandOnPath("node") || "node";
}
function isWindowsShellShim(filePath) {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(filePath);
}
function getNpmPackageBinTarget(shimPath, packageName, binPath) {
  const target = path.join(path.dirname(shimPath), "node_modules", packageName, binPath);
  return fs.existsSync(target) ? target : void 0;
}
const SEARCH_RESULT_LIMIT = 50;
const SEARCH_EXCLUDED_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".next",
  ".nuxt",
  "out",
  "release",
  "coverage",
  "target",
  "vendor"
]);
const getPathAttachmentInfo = async (targetPath) => {
  const info = await promises.stat(targetPath);
  if (!info.isFile() && !info.isDirectory()) {
    throw new Error("Path is not a file or folder");
  }
  return {
    name: path.basename(targetPath) || targetPath,
    path: targetPath,
    kind: info.isDirectory() ? "folder" : "file"
  };
};
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
  electron.ipcMain.handle("fs:statPath", async (_event, filePath) => {
    if (typeof filePath !== "string" || !filePath.trim()) {
      return { success: false, error: "Invalid file path" };
    }
    try {
      return { success: true, attachment: await getPathAttachmentInfo(filePath) };
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
  electron.ipcMain.handle("fs:reverseApplyPatch", async (_event, projectPath, patches) => {
    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return { success: false, error: "Invalid project path" };
    }
    if (!Array.isArray(patches) || patches.length === 0) {
      return { success: false, error: "No patch content to revert" };
    }
    try {
      const projectInfo = await promises.stat(projectPath);
      if (!projectInfo.isDirectory()) {
        return { success: false, error: "Project path is not a directory" };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    const patchInput = patches.filter((patch) => typeof patch === "string" && patch.trim().length > 0).map((patch) => patch.trimEnd()).join("\n");
    if (!patchInput.trim()) {
      return { success: false, error: "No patch content to revert" };
    }
    try {
      const result = child_process.spawnSync("git", ["apply", "--reverse", "--whitespace=nowarn", "-"], {
        cwd: projectPath,
        input: `${patchInput}
`,
        encoding: "utf-8",
        shell: false,
        maxBuffer: 10 * 1024 * 1024
      });
      if (result.error) {
        return { success: false, error: result.error.message };
      }
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || "").trim();
        return { success: false, error: detail || `git apply exited with code ${result.status}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
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
        if (results.length >= SEARCH_RESULT_LIMIT) return;
        if (depth > maxDepth) return;
        try {
          const entries = await promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= SEARCH_RESULT_LIMIT) return;
            if (entry.name.startsWith(".")) continue;
            if (entry.isDirectory() && SEARCH_EXCLUDED_DIRS.has(entry.name)) continue;
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
      return results;
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
  electron.ipcMain.handle("fs:openAttachmentFolder", async (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    const result = await electron.dialog.showOpenDialog(win, {
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    try {
      return { canceled: false, attachment: await getPathAttachmentInfo(result.filePaths[0]) };
    } catch (err) {
      return { canceled: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  electron.ipcMain.handle("fs:getHomeDir", () => {
    return os.homedir();
  });
  electron.ipcMain.handle("fs:isCommandAvailable", (_event, command) => {
    if (typeof command !== "string" || !/^[\w@./:-]+$/.test(command)) return false;
    try {
      return commandExists$1(command, { excludeNodeModules: true });
    } catch {
      return false;
    }
  });
}
const dataDir = path.join(electron.app.getPath("userData"), "hpp-data");
const COMPACT_JSON_KEYS = /* @__PURE__ */ new Set(["sessionMessages"]);
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
        const json = COMPACT_JSON_KEYS.has(key) ? JSON.stringify(data) : JSON.stringify(data, null, 2);
        await promises.writeFile(filePath, json, "utf-8");
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
function getRegistryBaseUrls() {
  const configured = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY;
  return Array.from(new Set([
    configured,
    "https://registry.npmjs.org/",
    "https://registry.npmmirror.com/"
  ].filter(Boolean).map((registry) => registry.endsWith("/") ? registry : `${registry}/`)));
}
function getNpmRegistryPackageUrls(packageName) {
  const packagePath = `${encodeURIComponent(packageName)}/latest`;
  return getRegistryBaseUrls().map((registry) => new URL(packagePath, registry).toString());
}
function requestLatestPackageVersion(url, timeout = 15e3) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Hpp"
        }
      },
      (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const redirectUrl = new URL(response.headers.location, url).toString();
          response.resume();
          requestLatestPackageVersion(redirectUrl, timeout).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`npm registry returned HTTP ${response.statusCode || "unknown"}`));
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(typeof parsed.version === "string" ? parsed.version : void 0);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    request.setTimeout(timeout, () => request.destroy(new Error("npm registry request timed out")));
    request.on("error", reject);
  });
}
async function getLatestNpmPackageVersion(packageName) {
  let lastError;
  for (const url of getNpmRegistryPackageUrls(packageName)) {
    try {
      return await requestLatestPackageVersion(url);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";
const MIN_NODE_VERSION = "22.19.0";
function runCommand$1(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const resolvedCommand = resolveCommand(command);
    child_process.execFile(
      resolvedCommand,
      args,
      {
        cwd: options.cwd,
        env: getCommandEnv(),
        shell: isWindowsShellShim(resolvedCommand),
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
  return getNodeExecutable(["PI_NODE_PATH"]);
}
function runNpmCommand$1(args, options = {}) {
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
async function readJsonFile(filePath) {
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
    const packageJson = await readJsonFile(packageJsonPath);
    if (packageJson?.name === "hpp" || packageJson?.dependencies?.[PI_SDK_PACKAGE] || packageJson?.devDependencies?.[PI_SDK_PACKAGE]) {
      return candidate;
    }
  }
  return void 0;
}
async function getInstalledVersion(packageRoot) {
  const packageJson = await readJsonFile(
    path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")
  );
  return packageJson?.version;
}
async function getLatestVersion() {
  return getLatestNpmPackageVersion(PI_SDK_PACKAGE);
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
    latestVersion = await getLatestVersion();
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
  codex: {
    command: "codex",
    packageName: "@openai/codex",
    displayName: "Codex CLI"
  },
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
const DEFAULT_THINKING_LEVEL = "medium";
const VALID_THINKING_LEVELS = /* @__PURE__ */ new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const updateInProgress = /* @__PURE__ */ new Set();
function normalizeThinkingLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "none") return "off";
  return VALID_THINKING_LEVELS.has(normalized) ? normalized : void 0;
}
function extractTopLevelConfigValue(content, key) {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const match = line.match(new RegExp(`^${key}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))`));
    if (match) return match[1] || match[2] || match[3];
  }
  return void 0;
}
function getCodexConfigPath$1() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
}
async function getCodexDefaultThinkingLevel() {
  try {
    const content = await promises.readFile(getCodexConfigPath$1(), "utf8");
    return normalizeThinkingLevel(extractTopLevelConfigValue(content, "model_reasoning_effort")) || DEFAULT_THINKING_LEVEL;
  } catch {
    return DEFAULT_THINKING_LEVEL;
  }
}
async function getDefaultThinkingLevel(agentId) {
  if (agentId === "codex") return getCodexDefaultThinkingLevel();
  return DEFAULT_THINKING_LEVEL;
}
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const resolvedCommand = resolveCommand(command);
    child_process.execFile(
      resolvedCommand,
      args,
      {
        cwd: options.cwd,
        env: getCommandEnv(),
        shell: isWindowsShellShim(resolvedCommand),
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
  const parts = [command, ...args].map((arg) => /[\s"]/.test(arg) ? JSON.stringify(arg) : arg);
  const fullCommand = parts.join(" ");
  return new Promise((resolve, reject) => {
    child_process.exec(
      fullCommand,
      {
        cwd: options.cwd,
        env: getCommandEnv(),
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
async function commandExists(command) {
  return commandExists$1(command, { excludeNodeModules: true });
}
async function getCommandVersion(command) {
  try {
    const { stdout, stderr } = await runCommand(command, ["--version"], { timeout: 5e3 });
    return extractVersion(`${stdout}
${stderr}`);
  } catch {
    return void 0;
  }
}
async function getLatestPackageVersion(packageName) {
  return getLatestNpmPackageVersion(packageName);
}
async function getCliAgentStatus(config) {
  const installed = await commandExists(config.command);
  if (!installed) {
    return {
      installed: false,
      updateAvailable: false,
      canUpdate: await commandExists("npm")
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
  const updateAvailable = !!(currentVersion && latestVersion && compareVersions(currentVersion, latestVersion) < 0);
  return {
    installed: true,
    currentVersion,
    latestVersion,
    updateAvailable,
    canUpdate: await commandExists("npm"),
    error
  };
}
async function getAgentStatus(agentId) {
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
  electron.ipcMain.handle("agent:getDefaultThinkingLevel", async (_event, agentId) => {
    return getDefaultThinkingLevel(agentId);
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
const SUPPORTED_CONFIG_AGENTS = /* @__PURE__ */ new Set(["codex", "pi", "droid", "opencode"]);
const SETTINGS_KEY = "agentConfigs";
const CODEX_FALLBACK_MODEL_ID = "gpt-5.5";
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function getDataDir() {
  return path.join(electron.app.getPath("userData"), "hpp-data");
}
function getSettingsPath() {
  return path.join(getDataDir(), "settings.json");
}
async function readTextFile(filePath) {
  try {
    return await promises.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}
async function readJsonObject(filePath) {
  try {
    const content = (await promises.readFile(filePath, "utf-8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
async function writeJsonObject(filePath, value) {
  await promises.mkdir(path.dirname(filePath), { recursive: true });
  await promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}
`, "utf-8");
}
async function readSettings() {
  return readJsonObject(getSettingsPath());
}
async function writeSettings(settings) {
  await promises.mkdir(getDataDir(), { recursive: true });
  await promises.writeFile(getSettingsPath(), `${JSON.stringify(settings, null, 2)}
`, "utf-8");
}
function normalizeModel(value) {
  if (!isRecord(value)) return null;
  const id = String(value.id || "").trim();
  if (!id) return null;
  const name = String(value.name || id).trim() || id;
  return {
    id,
    name,
    reasoning: value.reasoning === true,
    imageInput: value.imageInput === true
  };
}
function normalizeProvider(value) {
  if (!isRecord(value)) return null;
  const providerId = String(value.providerId || "").trim();
  if (!providerId) return null;
  const displayName = String(value.displayName || providerId).trim() || providerId;
  const baseUrl = String(value.baseUrl || "").trim();
  const apiKey = String(value.apiKey || "").trim();
  const models = Array.isArray(value.models) ? value.models.map(normalizeModel).filter((model) => !!model) : [];
  return { providerId, displayName, baseUrl, apiKey, models, hppManaged: value.hppManaged === true };
}
function getOriginalProviderId(value) {
  if (!isRecord(value)) return void 0;
  const originalProviderId = String(value.originalProviderId || "").trim();
  return originalProviderId || void 0;
}
function normalizeState(value) {
  const record = isRecord(value) ? value : {};
  const providers = Array.isArray(record.providers) ? record.providers.map(normalizeProvider).filter((provider) => !!provider) : [];
  const activeProviderId = typeof record.activeProviderId === "string" ? record.activeProviderId : void 0;
  return {
    activeProviderId: activeProviderId && providers.some((provider) => provider.providerId === activeProviderId) ? activeProviderId : void 0,
    providers
  };
}
async function readSavedAgentConfigEntry(agentId) {
  const settings = await readSettings();
  const allConfigs = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
  return {
    exists: Object.prototype.hasOwnProperty.call(allConfigs, agentId),
    state: normalizeState(allConfigs[agentId])
  };
}
function isSameCodexNativeProvider(provider, nativeProvider) {
  return provider.providerId === nativeProvider.providerId && provider.displayName === nativeProvider.displayName && provider.baseUrl === nativeProvider.baseUrl;
}
function isLegacyCodexNativeProvider(provider, nativeProviders, savedActiveProviderId) {
  if (provider.hppManaged === true) return false;
  if (provider.providerId === "custom" && provider.displayName === "custom" && provider.providerId !== savedActiveProviderId) {
    return true;
  }
  const nativeProvider = nativeProviders.find((item) => item.providerId === provider.providerId);
  return !!nativeProvider && provider.providerId !== savedActiveProviderId && isSameCodexNativeProvider(provider, nativeProvider);
}
async function readSavedCodexConfigState() {
  const savedEntry = await readSavedAgentConfigEntry("codex");
  if (!savedEntry.exists) {
    const native2 = await readCodexNativeConfigState();
    const nativeProvider = native2.providers.find((provider) => provider.providerId === native2.activeProviderId) || native2.providers[0];
    const nextState2 = nativeProvider ? {
      activeProviderId: nativeProvider.providerId,
      providers: [{ ...nativeProvider, hppManaged: true }]
    } : { providers: [] };
    await writeAgentConfigState("codex", nextState2);
    return nextState2;
  }
  const saved = savedEntry.state;
  if (saved.providers.every((provider) => provider.hppManaged === true)) return saved;
  const native = await readCodexNativeConfigState();
  const providers = saved.providers.filter((provider) => !isLegacyCodexNativeProvider(provider, native.providers, saved.activeProviderId)).map((provider) => ({ ...provider, hppManaged: true }));
  const nextState = {
    activeProviderId: saved.activeProviderId && providers.some((provider) => provider.providerId === saved.activeProviderId) ? saved.activeProviderId : void 0,
    providers
  };
  await writeAgentConfigState("codex", nextState);
  return nextState;
}
async function writeAgentConfigState(agentId, state) {
  const settings = await readSettings();
  const allConfigs = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
  settings[SETTINGS_KEY] = {
    ...allConfigs,
    [agentId]: state
  };
  await writeSettings(settings);
}
function ensureSupportedAgent(agentId) {
  if (!SUPPORTED_CONFIG_AGENTS.has(agentId)) {
    throw new Error("当前 Agent 暂不支持自定义渠道配置。");
  }
}
function validateProviderConfig(provider) {
  if (!/^[a-zA-Z0-9._:-]+$/.test(provider.providerId)) {
    throw new Error("渠道 ID 只能包含字母、数字、点、下划线、冒号和短横线。");
  }
  if (!provider.baseUrl) throw new Error("请填写渠道 URL。");
  if (!provider.apiKey) throw new Error("请填写 sk-key。");
  if (provider.models.length === 0) throw new Error("至少需要添加一个模型。");
  for (const model of provider.models) {
    if (!model.id.trim()) throw new Error("模型 ID 不能为空。");
  }
}
function uniqueById(items) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}
function mergeModels(saved, native) {
  return uniqueById([
    ...saved.map((model) => ({ ...model })),
    ...native.map((model) => ({ ...model }))
  ]);
}
function sanitizeProviderId(value, fallback) {
  const normalized = value.trim().replace(/^https?:\/\//i, "").replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}
function uniqueProviderId(baseId, usedIds) {
  let providerId = sanitizeProviderId(baseId, "custom");
  let index = 2;
  while (usedIds.has(providerId)) {
    providerId = `${sanitizeProviderId(baseId, "custom")}-${index}`;
    index += 1;
  }
  usedIds.add(providerId);
  return providerId;
}
function providerIdFromUrl(baseUrl, fallback, usedIds) {
  try {
    const url = new URL(baseUrl);
    return uniqueProviderId(url.hostname.replace(/^api\./i, ""), usedIds);
  } catch {
    return uniqueProviderId(fallback, usedIds);
  }
}
function modelSupportsImages$1(value) {
  if (value.imageInput === true || value.supportsImages === true || value.attachment === true) return true;
  if (Array.isArray(value.input) && value.input.includes("image")) return true;
  const modalities = isRecord(value.modalities) ? value.modalities : {};
  return Array.isArray(modalities.input) && modalities.input.includes("image");
}
function normalizeNativeModel(value, fallbackId) {
  if (!isRecord(value)) {
    const id2 = String(fallbackId || value || "").trim();
    return id2 ? { id: id2, name: id2, reasoning: false, imageInput: false } : null;
  }
  const id = asString(value.id) || asString(value.model) || asString(value.name) || fallbackId || "";
  if (!id) return null;
  return {
    id,
    name: asString(value.name) || asString(value.displayName) || id,
    reasoning: value.reasoning === true,
    imageInput: modelSupportsImages$1(value)
  };
}
function getPiModelsPath() {
  return path.join(os.homedir(), ".pi", "agent", "models.json");
}
function getDroidSettingsPath() {
  return path.join(os.homedir(), ".factory", "settings.json");
}
function getOpenCodeConfigPath() {
  return process.env.OPENCODE_CONFIG || path.join(os.homedir(), ".config", "opencode", "opencode.json");
}
function getCodexHomeDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}
function getCodexConfigPath() {
  return path.join(getCodexHomeDir(), "config.toml");
}
function getCodexAuthPath() {
  return path.join(getCodexHomeDir(), "auth.json");
}
async function readPiNativeConfigState() {
  const config = await readJsonObject(getPiModelsPath());
  const providersRecord = isRecord(config.providers) ? config.providers : {};
  const providers = [];
  for (const [providerId, value] of Object.entries(providersRecord)) {
    if (!isRecord(value)) continue;
    const models = Array.isArray(value.models) ? value.models.map((model) => normalizeNativeModel(model)).filter((model) => !!model) : [];
    providers.push({
      providerId,
      displayName: asString(value.name) || providerId,
      baseUrl: asString(value.baseUrl) || asString(value.baseURL) || asString(value.url),
      apiKey: asString(value.apiKey) || asString(value.api_key),
      models
    });
  }
  return {
    activeProviderId: asString(config.activeProviderId) || asString(config.activeProvider),
    providers
  };
}
async function readDroidNativeConfigState() {
  const config = await readJsonObject(getDroidSettingsPath());
  const customModels = Array.isArray(config.customModels) ? config.customModels : [];
  const groups = /* @__PURE__ */ new Map();
  const keyToProviderId = /* @__PURE__ */ new Map();
  const usedIds = /* @__PURE__ */ new Set();
  for (const model of customModels) {
    if (!isRecord(model)) continue;
    const baseUrl = asString(model.baseUrl) || asString(model.baseURL);
    const apiKey = asString(model.apiKey);
    const providerName = asString(model.hppProviderId) || asString(model.provider) || "custom";
    const groupKey = asString(model.hppProviderId) || `${providerName}|${baseUrl}|${apiKey}`;
    let providerId = keyToProviderId.get(groupKey);
    if (!providerId) {
      providerId = asString(model.hppProviderId) || providerIdFromUrl(baseUrl, providerName, usedIds);
      keyToProviderId.set(groupKey, providerId);
      groups.set(providerId, {
        providerId,
        displayName: asString(model.hppProviderId) || providerName,
        baseUrl,
        apiKey,
        models: []
      });
    }
    const group = groups.get(providerId);
    if (!group) continue;
    const modelId = asString(model.model) || asString(model.id) || asString(model.displayName);
    if (!modelId) continue;
    group.models.push({
      id: modelId,
      name: asString(model.displayName) || modelId,
      reasoning: model.reasoning === true,
      imageInput: model.noImageSupport !== true
    });
  }
  const activeModel = asString(isRecord(config.sessionDefaultSettings) ? config.sessionDefaultSettings.model : void 0).replace(/^custom:/, "");
  const providers = Array.from(groups.values()).map((provider) => ({
    ...provider,
    models: uniqueById(provider.models)
  }));
  const activeProvider = activeModel ? providers.find((provider) => provider.models.some((model) => model.id === activeModel))?.providerId : void 0;
  return { activeProviderId: activeProvider, providers };
}
function parseOpenCodeModels(rawModels) {
  if (Array.isArray(rawModels)) {
    return rawModels.map((model) => normalizeNativeModel(model)).filter((model) => !!model);
  }
  if (!isRecord(rawModels)) return [];
  return Object.entries(rawModels).map(([modelId, value]) => normalizeNativeModel(value, modelId)).filter((model) => !!model);
}
async function readOpenCodeNativeConfigState() {
  const config = await readJsonObject(getOpenCodeConfigPath());
  const providersRecord = isRecord(config.provider) ? config.provider : {};
  const providers = [];
  for (const [providerId, value] of Object.entries(providersRecord)) {
    if (!isRecord(value)) continue;
    const options = isRecord(value.options) ? value.options : {};
    providers.push({
      providerId,
      displayName: asString(value.name) || providerId,
      baseUrl: asString(options.baseURL) || asString(options.baseUrl) || asString(value.baseURL) || asString(value.baseUrl),
      apiKey: asString(options.apiKey) || asString(value.apiKey),
      models: parseOpenCodeModels(value.models)
    });
  }
  const configuredModel = asString(config.model);
  const activeProviderId = configuredModel.includes("/") ? configuredModel.split("/")[0] : asString(config.providerID) || asString(config.providerId);
  return { activeProviderId, providers };
}
function unquoteTomlValue(rawValue) {
  const value = rawValue.trim();
  if (!value) return "";
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:\\.|[^"\\])*)"/);
    if (!match) return "";
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'([^']*)'/);
    return match ? match[1] : "";
  }
  return value.split(/\s+#/)[0].trim();
}
function parseTomlKeyValue(line) {
  const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
  if (!match) return null;
  return { key: match[1], value: unquoteTomlValue(match[2]) };
}
function unescapeTomlKey(rawKey) {
  const key = rawKey.trim();
  if (key.startsWith('"') && key.endsWith('"')) {
    try {
      return JSON.parse(key);
    } catch {
      return key.slice(1, -1);
    }
  }
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1);
  return key;
}
function parseCodexProviderSection(line) {
  const match = line.match(/^\s*\[\s*model_providers\.(.+?)\s*\]\s*$/);
  return match ? unescapeTomlKey(match[1]) : null;
}
async function readCodexNativeConfigState() {
  const content = await readTextFile(getCodexConfigPath());
  const auth = await readJsonObject(getCodexAuthPath());
  const providers = /* @__PURE__ */ new Map();
  let activeProviderId = "";
  let activeModelId = "";
  let currentProviderId = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const providerSection = parseCodexProviderSection(line);
    if (providerSection) {
      currentProviderId = providerSection;
      providers.set(providerSection, {
        providerId: providerSection,
        displayName: providerSection,
        baseUrl: "",
        apiKey: asString(auth.OPENAI_API_KEY),
        models: []
      });
      continue;
    }
    if (line.startsWith("[")) {
      currentProviderId = null;
      continue;
    }
    const pair = parseTomlKeyValue(rawLine);
    if (!pair) continue;
    if (!currentProviderId) {
      if (pair.key === "model_provider") activeProviderId = pair.value;
      if (pair.key === "model") activeModelId = pair.value;
      continue;
    }
    const provider = providers.get(currentProviderId);
    if (!provider) continue;
    if (pair.key === "name") provider.displayName = pair.value || currentProviderId;
    if (pair.key === "base_url") provider.baseUrl = pair.value;
  }
  if (activeProviderId && !providers.has(activeProviderId)) {
    providers.set(activeProviderId, {
      providerId: activeProviderId,
      displayName: activeProviderId,
      baseUrl: "",
      apiKey: asString(auth.OPENAI_API_KEY),
      models: []
    });
  }
  const modelId = activeModelId || CODEX_FALLBACK_MODEL_ID;
  const modelDefaults = [
    { id: modelId, name: modelId, reasoning: true, imageInput: true }
  ];
  for (const provider of providers.values()) {
    provider.apiKey = asString(auth.OPENAI_API_KEY);
    provider.models = provider.models.length > 0 ? mergeModels(modelDefaults, provider.models) : modelDefaults;
  }
  return { activeProviderId, providers: Array.from(providers.values()) };
}
async function readNativeAgentConfigState(agentId) {
  if (agentId === "codex") return readCodexNativeConfigState();
  if (agentId === "pi") return readPiNativeConfigState();
  if (agentId === "droid") return readDroidNativeConfigState();
  if (agentId === "opencode") return readOpenCodeNativeConfigState();
  return { providers: [] };
}
async function readCurrentAgentConfigState(agentId) {
  return agentId === "codex" ? readSavedCodexConfigState() : readNativeAgentConfigState(agentId);
}
async function listAgentConfig(agentId) {
  try {
    if (!SUPPORTED_CONFIG_AGENTS.has(agentId)) {
      return { success: true, config: { providers: [] } };
    }
    return { success: true, config: await readCurrentAgentConfigState(agentId) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
async function saveAgentProviderConfig(agentId, providerValue) {
  try {
    ensureSupportedAgent(agentId);
    const normalizedProvider = normalizeProvider(providerValue);
    if (!normalizedProvider) throw new Error("渠道配置无效。");
    const provider = agentId === "codex" ? { ...normalizedProvider, hppManaged: true } : normalizedProvider;
    validateProviderConfig(provider);
    const originalProviderId = getOriginalProviderId(providerValue);
    const state = await readCurrentAgentConfigState(agentId);
    const providers = state.providers.filter(
      (item) => item.providerId !== provider.providerId && item.providerId !== originalProviderId
    );
    providers.push(provider);
    const nextState = {
      activeProviderId: state.activeProviderId === originalProviderId ? provider.providerId : state.activeProviderId,
      providers
    };
    if (agentId === "codex") {
      await writeAgentConfigState(agentId, nextState);
    } else {
      await writeNativeAgentConfig(agentId, nextState);
    }
    return { success: true, config: nextState };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
async function deleteAgentProviderConfig(agentId, providerId) {
  try {
    ensureSupportedAgent(agentId);
    const state = agentId === "codex" ? await readSavedCodexConfigState() : await readNativeAgentConfigState(agentId);
    const nextProviders = state.providers.filter((provider) => provider.providerId !== providerId);
    const nextState = {
      activeProviderId: state.activeProviderId === providerId ? void 0 : state.activeProviderId,
      providers: nextProviders
    };
    if (agentId === "codex") {
      await writeAgentConfigState(agentId, nextState);
    } else {
      await writeNativeAgentConfig(agentId, nextState);
    }
    return { success: true, config: nextState };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
async function setActiveAgentProviderConfig(agentId, providerId) {
  if (agentId !== "codex") {
    throw new Error("只有 Codex 需要启用渠道。");
  }
  const state = await readSavedCodexConfigState();
  if (!state.providers.some((provider) => provider.providerId === providerId)) {
    throw new Error("未找到要启用的渠道。");
  }
  const nextState = { ...state, activeProviderId: providerId };
  await writeAgentConfigState(agentId, nextState);
  return nextState;
}
async function snapshotFile(filePath) {
  if (!fs.existsSync(filePath)) return { filePath, existed: false, content: "" };
  return { filePath, existed: true, content: await promises.readFile(filePath, "utf-8") };
}
async function restoreNativeConfigSnapshot(snapshot) {
  if (snapshot.existed) {
    await promises.mkdir(path.dirname(snapshot.filePath), { recursive: true });
    await promises.writeFile(snapshot.filePath, snapshot.content, "utf-8");
  } else {
    await promises.rm(snapshot.filePath, { force: true });
  }
}
async function restoreNativeConfigSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    await restoreNativeConfigSnapshot(snapshot);
  }
}
function toPiProviderConfig(provider, existingProvider = {}) {
  return {
    ...existingProvider,
    baseUrl: provider.baseUrl,
    api: existingProvider.api || "openai-completions",
    apiKey: provider.apiKey,
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      reasoning: !!model.reasoning,
      input: model.imageInput ? ["text", "image"] : ["text"]
    }))
  };
}
async function writePiNativeConfigProviders(state) {
  const filePath = getPiModelsPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const existingProviders = isRecord(config.providers) ? config.providers : {};
  const providers = {};
  for (const provider of state.providers) {
    const existingProvider = isRecord(existingProviders[provider.providerId]) ? existingProviders[provider.providerId] : {};
    providers[provider.providerId] = toPiProviderConfig(provider, existingProvider);
  }
  await writeJsonObject(filePath, { ...config, providers });
  return [snapshot];
}
async function writeDroidNativeConfigProviders(state) {
  const filePath = getDroidSettingsPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const customModels = [];
  for (const provider of state.providers) {
    for (const model of provider.models) {
      customModels.push({
        hppManaged: true,
        hppProviderId: provider.providerId,
        provider: "generic-chat-completion-api",
        model: model.id,
        id: `custom:${model.id}`,
        displayName: model.name || model.id,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        reasoning: !!model.reasoning,
        noImageSupport: !model.imageInput
      });
    }
  }
  await writeJsonObject(filePath, { ...config, customModels });
  return [snapshot];
}
function toOpenCodeProviderConfig(provider) {
  const models = {};
  for (const model of provider.models) {
    models[model.id] = {
      name: model.name || model.id,
      reasoning: !!model.reasoning,
      attachment: !!model.imageInput,
      modalities: {
        input: model.imageInput ? ["text", "image"] : ["text"],
        output: ["text"]
      }
    };
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: provider.displayName || provider.providerId,
    options: {
      baseURL: provider.baseUrl,
      apiKey: provider.apiKey
    },
    models
  };
}
async function writeOpenCodeNativeConfigProviders(state) {
  const filePath = getOpenCodeConfigPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const providers = {};
  for (const provider of state.providers) {
    providers[provider.providerId] = toOpenCodeProviderConfig(provider);
  }
  await writeJsonObject(filePath, { ...config, provider: providers });
  return [snapshot];
}
function escapeTomlString(value) {
  return JSON.stringify(value);
}
function tomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : escapeTomlString(key);
}
function setTopLevelTomlValue(content, key, value) {
  const lines = content ? content.split(/\r?\n/) : [];
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const scanEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  const nextLine = `${key} = ${escapeTomlString(value)}`;
  for (let index = 0; index < scanEnd; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) {
      lines[index] = nextLine;
      return lines.join("\n");
    }
  }
  const insertIndex = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  lines.splice(insertIndex, 0, nextLine);
  return lines.join("\n");
}
function getTopLevelTomlValue(content, key) {
  const lines = content ? content.split(/\r?\n/) : [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("[")) return "";
    if (!line || line.startsWith("#")) continue;
    const pair = parseTomlKeyValue(rawLine);
    if (pair?.key === key) return pair.value;
  }
  return "";
}
function providerSectionHeader(providerId) {
  return `[model_providers.${tomlKey(providerId)}]`;
}
function getFirstCodexProviderSectionId(content) {
  for (const rawLine of content.split(/\r?\n/)) {
    const providerId = parseCodexProviderSection(rawLine);
    if (providerId) return providerId;
  }
  return "";
}
function upsertCodexProviderBaseUrl(content, providerId, baseUrl) {
  const lines = content ? content.split(/\r?\n/) : [];
  const nextLine = `base_url = ${escapeTomlString(baseUrl)}`;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (parseCodexProviderSection(lines[index]) === providerId) {
      start = index;
      break;
    }
  }
  if (start === -1) {
    const suffix = lines.length > 0 && lines[lines.length - 1].trim() ? [""] : [];
    return [...lines, ...suffix, providerSectionHeader(providerId), nextLine, ""].join("\n");
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  for (let index = start + 1; index < end; index += 1) {
    const pair = parseTomlKeyValue(lines[index]);
    if (pair?.key === "base_url") {
      lines[index] = nextLine;
      return lines.join("\n");
    }
  }
  let insertIndex = end;
  while (insertIndex > start + 1 && !lines[insertIndex - 1].trim()) insertIndex -= 1;
  lines.splice(insertIndex, 0, nextLine);
  return lines.join("\n");
}
async function writeCodexNativeConfig(_state, provider) {
  const configPath = getCodexConfigPath();
  const authPath = getCodexAuthPath();
  const snapshots = await Promise.all([snapshotFile(configPath), snapshotFile(authPath)]);
  let configContent = await readTextFile(configPath);
  const activeNativeProviderId = getTopLevelTomlValue(configContent, "model_provider");
  const firstNativeProviderId = getFirstCodexProviderSectionId(configContent);
  const targetProviderId = activeNativeProviderId || firstNativeProviderId || "openai";
  const selectedModel = provider.models[0]?.id || CODEX_FALLBACK_MODEL_ID;
  if (!activeNativeProviderId && !firstNativeProviderId) {
    configContent = setTopLevelTomlValue(configContent, "model_provider", targetProviderId);
  }
  configContent = setTopLevelTomlValue(configContent, "model", selectedModel);
  configContent = upsertCodexProviderBaseUrl(configContent, targetProviderId, provider.baseUrl);
  await promises.mkdir(path.dirname(configPath), { recursive: true });
  await promises.writeFile(configPath, configContent.endsWith("\n") ? configContent : `${configContent}
`, "utf-8");
  const auth = await readJsonObject(authPath);
  auth.OPENAI_API_KEY = provider.apiKey;
  await writeJsonObject(authPath, auth);
  return snapshots;
}
async function writeNativeAgentProviderConfig(agentId, providerId) {
  ensureSupportedAgent(agentId);
  if (agentId !== "codex") {
    throw new Error("只有 Codex 需要启用指定渠道。");
  }
  const state = await readSavedCodexConfigState();
  const provider = state.providers.find((item) => item.providerId === providerId);
  if (!provider) throw new Error("未找到要启用的渠道。");
  validateProviderConfig(provider);
  const snapshots = await writeCodexNativeConfig(state, provider);
  return { state, provider, snapshots };
}
async function writeNativeAgentConfig(agentId, stateOverride) {
  ensureSupportedAgent(agentId);
  if (agentId === "codex") {
    throw new Error("Codex 需要启用指定渠道后才能写入当前渠道。");
  }
  const state = stateOverride || await readNativeAgentConfigState(agentId);
  for (const provider of state.providers) {
    validateProviderConfig(provider);
  }
  const snapshots = agentId === "pi" ? await writePiNativeConfigProviders(state) : agentId === "droid" ? await writeDroidNativeConfigProviders(state) : await writeOpenCodeNativeConfigProviders(state);
  return { state, snapshots };
}
async function getConfiguredAgentModels(agentId) {
  if (!SUPPORTED_CONFIG_AGENTS.has(agentId)) return [];
  const state = agentId === "codex" ? await readSavedCodexConfigState() : await readNativeAgentConfigState(agentId);
  const providers = agentId === "codex" ? [
    state.providers.find((provider) => provider.providerId === state.activeProviderId) || state.providers[0]
  ].filter((provider) => !!provider) : state.providers;
  return providers.flatMap((provider) => {
    const providerName = agentId === "codex" ? "codex" : provider.providerId;
    return provider.models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      provider: providerName,
      reasoning: !!model.reasoning,
      supportsImages: !!model.imageInput
    }));
  });
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
    patch: patch || void 0,
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
function readOpenCodeConfigContent() {
  try {
    return fs.readFileSync(getOpenCodeConfigPath(), "utf-8");
  } catch {
    return void 0;
  }
}
function buildOpenCodeConfigContent(existing) {
  const source = existing?.trim() ? existing : readOpenCodeConfigContent();
  if (!source?.trim()) {
    return JSON.stringify({ permission: "allow" });
  }
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !("permission" in parsed)) {
      return JSON.stringify({ ...parsed, permission: "allow" });
    }
  } catch {
  }
  return source;
}
function modelSupportsImages(modelInfo) {
  if (!modelInfo || typeof modelInfo !== "object") return false;
  if (modelInfo.attachment === true || modelInfo.supportsImages === true || modelInfo.imageInput === true) return true;
  const input = modelInfo.input || modelInfo.modalities?.input;
  return Array.isArray(input) && input.includes("image");
}
function imageExtension(mimeType) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "png";
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
    const opencodeCommand = resolveCommand("opencode");
    this.process = child_process.spawn(opencodeCommand, ["serve", "--port", String(this.port), "--hostname", this.host], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWindowsShellShim(opencodeCommand),
      env: getCommandEnv({
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent(process.env.OPENCODE_CONFIG_CONTENT)
      })
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
  async sendMessage(message, images, options) {
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
      const parts = [{ type: "text", text: message }];
      if (images?.length) {
        images.forEach((image, index) => {
          const mimeType = image.mimeType || "image/png";
          parts.push({
            type: "file",
            mime: mimeType,
            filename: `image-${index + 1}.${imageExtension(mimeType)}`,
            url: `data:${mimeType};base64,${image.data}`
          });
        });
      }
      const body = { parts };
      if (options?.planModeEnabled || options?.permissionMode === "plan") {
        body.agent = "plan";
      } else {
        body.agent = "build";
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
  isIdle() {
    return !this.eventSource && !this.idleTimer && this.runningToolParts.size === 0 && this.pendingQuestionToolParts.size === 0;
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
    this.runningToolParts.clear();
    this.pendingQuestionToolParts.clear();
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
                reasoning: m.reasoning ?? false,
                supportsImages: modelSupportsImages(m)
              });
            }
          } else if (provider.models && typeof provider.models === "object") {
            for (const [modelId, modelInfo] of Object.entries(provider.models)) {
              models.push({
                id: modelId,
                name: modelInfo?.name || modelId,
                provider: providerId,
                reasoning: modelInfo?.reasoning ?? false,
                supportsImages: modelSupportsImages(modelInfo)
              });
            }
          } else if (result.default?.[providerId]) {
            models.push({
              id: result.default[providerId],
              name: result.default[providerId],
              provider: providerId,
              reasoning: false,
              supportsImages: false
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
    this.runningToolParts.clear();
    this.pendingQuestionToolParts.clear();
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
function getDroidExecutable(args) {
  if (process.env.DROID_PATH && fs.existsSync(process.env.DROID_PATH)) {
    if (isWindowsShellShim(process.env.DROID_PATH)) {
      return { command: process.env.DROID_PATH, args, shell: true };
    }
    return { command: process.env.DROID_PATH, args };
  }
  const executable = findCommandOnPath("droid");
  if (!executable) return { command: "droid", args };
  if (!isWindowsShellShim(executable)) return { command: executable, args };
  const shimTarget = getNpmPackageBinTarget(executable, "droid", path.join("bin", "droid"));
  if (shimTarget) return { command: getNodeExecutable(["DROID_NODE_PATH", "PI_NODE_PATH"]), args: [shimTarget, ...args] };
  return { command: executable, args, shell: true };
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
  pendingPermissionRequestId = null;
  isReady = false;
  autonomyLevel = "high";
  interactionMode = "auto";
  planModeEnabled = false;
  turnActive = false;
  isAborting = false;
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
    const executable = getDroidExecutable(args);
    this.process = child_process.spawn(executable.command, executable.args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: executable.shell || false,
      env: getCommandEnv()
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
      void this.mockResponse(message);
      return;
    }
    this.turnActive = true;
    this.isAborting = false;
    this.emitEvent({ type: "stream_start", role: "assistant" });
    const planModeEnabled = !!options?.planModeEnabled || options?.permissionMode === "plan";
    await this.setPermissionMode(planModeEnabled ? "plan" : "full-access");
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
  isIdle() {
    return !this.isAborting && !this.turnActive && this.pendingResponses.size === 0 && !this.pendingAskUserRequestId && !this.pendingPermissionRequestId;
  }
  async mockResponse(message) {
    this.turnActive = true;
    this.isAborting = false;
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
    this.turnActive = false;
  }
  /** Abort current response */
  async abort() {
    this.isAborting = true;
    if (this.pendingPermissionRequestId) {
      this.sendRpcResponse(this.pendingPermissionRequestId, { selectedOption: "deny" });
      this.pendingPermissionRequestId = null;
    }
    if (this.pendingAskUserRequestId) {
      this.sendRpcResponse(this.pendingAskUserRequestId, { cancelled: true, answers: [] });
      this.pendingAskUserRequestId = null;
    }
    if (this.process) {
      this.sendRpc("droid.interrupt_session", {});
    }
    this.turnActive = false;
    this.isAborting = false;
  }
  /** Get available models - Factory provides a curated set + local custom models */
  async getModels() {
    if (this.models.length > 0) return this.models;
    this.models = [
      { id: "claude-opus-4-7", name: "Claude Opus 4", provider: "factory", reasoning: true, supportsImages: true },
      { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", provider: "factory", reasoning: true, supportsImages: true },
      { id: "claude-sonnet-4-6-20250514", name: "Claude Sonnet 4.6", provider: "factory", reasoning: true, supportsImages: true },
      { id: "gpt-5-codex", name: "GPT-5 Codex", provider: "factory", reasoning: true, supportsImages: true },
      { id: "gpt-5.1-codex", name: "GPT-5.1 Codex", provider: "factory", reasoning: true, supportsImages: true },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "factory", reasoning: true, supportsImages: true },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "factory", reasoning: false, supportsImages: true }
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
            provider: m.hppProviderId || m.provider || "factory-custom",
            reasoning: !!m.reasoning,
            supportsImages: m.noImageSupport !== true
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
  async setPermissionMode(mode) {
    const nextPlanModeEnabled = mode === "plan";
    const nextInteractionMode = nextPlanModeEnabled ? "spec" : "auto";
    const nextAutonomyLevel = nextPlanModeEnabled ? "medium" : "high";
    const settings = {};
    this.planModeEnabled = nextPlanModeEnabled;
    if (this.interactionMode !== nextInteractionMode) {
      this.interactionMode = nextInteractionMode;
      settings.interactionMode = nextInteractionMode;
    }
    if (this.autonomyLevel !== nextAutonomyLevel) {
      this.autonomyLevel = nextAutonomyLevel;
      settings.autonomyLevel = nextAutonomyLevel;
    }
    if (this.process && this.isReady && Object.keys(settings).length > 0) {
      await this.sendRpcAsync("droid.update_session_settings", settings);
    }
    this.emitEvent({
      type: "process_event",
      entryType: "status",
      title: nextPlanModeEnabled ? "Droid 已进入 Spec 模式" : "Droid 已开启完全访问模式",
      state: "completed"
    });
  }
  sendUIResponse(response) {
    if (!this.process || !this.isReady) return;
    if (this.pendingPermissionRequestId) {
      const answers = Array.isArray(response?.answers) ? response.answers : [];
      const firstAnswer = answers[0] || {};
      const selectedValue = String(
        firstAnswer.value || firstAnswer.answer || firstAnswer.label || response?.value || response?.text || ""
      );
      this.sendRpcResponse(this.pendingPermissionRequestId, {
        selectedOption: selectedValue === "proceed_once" ? "proceed_once" : "deny"
      });
      this.pendingPermissionRequestId = null;
      return;
    }
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
    this.pendingPermissionRequestId = null;
    this.turnActive = false;
    this.isAborting = false;
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
        if (!this.planModeEnabled) {
          this.sendRpcResponse(requestId, { selectedOption: "proceed_once" });
        } else {
          this.pendingPermissionRequestId = requestId;
          this.emitEvent(normalizeQuestionProcessEvent({
            type: method,
            requestId,
            detail: params,
            title: params?.title || params?.message || "Droid 请求权限",
            options: [
              { label: "允许", value: "proceed_once" },
              { label: "拒绝", value: "deny" }
            ]
          }));
        }
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
        this.turnActive = false;
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
        {
          const state = String(notifData?.state || notifData?.status || "").toLowerCase();
          if (typeof notifData?.working === "boolean") {
            this.turnActive = notifData.working;
          } else if (["idle", "completed", "complete", "done"].includes(state)) {
            this.turnActive = false;
          } else if (["running", "working", "busy"].includes(state)) {
            this.turnActive = true;
          }
        }
        break;
      case "error":
        this.turnActive = false;
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
    const child = child_process.spawn(getNodeExecutable(["PI_NODE_PATH"]), [getWorkerPath$1()], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: getCommandEnv()
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
    const promptId = options?.clientMessageId || this.createCommandId();
    this.activePromptIds.add(promptId);
    this.emitEvent({ type: "message_start", role: "user", content: options?.displayMessage || message });
    this.beginTurn();
    this.sendWorkerCommand({
      id: promptId,
      type: "prompt",
      message,
      images,
      planModeEnabled: !!options?.planModeEnabled,
      permissionMode: options?.permissionMode || (options?.planModeEnabled ? "plan" : "full-access")
    });
  }
  isIdle() {
    return !this.isAborting && !this.turnActive && this.activePromptIds.size === 0 && this.pendingUIRequestIds.size === 0 && this.pendingResponses.size === 0;
  }
  async sendGuidance(message, images, options) {
    if (!this.process) throw new Error("Pi SDK worker is not running");
    if (this.isAborting) this.finishAbortState();
    const guidanceId = this.createCommandId();
    const displayMessage = options?.displayMessage || message;
    const messagePreview = displayMessage.length > 50 ? `${displayMessage.slice(0, 50)}...` : displayMessage;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(guidanceId);
        reject(new Error("Pi SDK guidance timed out"));
      }, 12e3);
      this.sendWorkerCommand({
        id: guidanceId,
        type: "guidance",
        message,
        images
      }, (data) => {
        clearTimeout(timeout);
        if (data.type === "accepted" || data.type === "guidance_done") {
          resolve();
        } else {
          reject(new Error(data.error || "Pi SDK guidance failed"));
        }
      });
    });
    this.emitEvent({
      type: "process_event",
      entryType: "status",
      title: `收到引导: "${messagePreview || "用户引导"}"`,
      detail: displayMessage || void 0,
      state: "completed"
    });
  }
  async forkSession(target) {
    if (!this.process) {
      return { supported: true, success: false, error: "Pi SDK worker is not running" };
    }
    const requestId = this.createCommandId();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        resolve({ supported: true, success: false, error: "Pi SDK fork timed out" });
      }, 12e3);
      this.sendWorkerCommand({
        id: requestId,
        type: "forkSession",
        ...target,
        sourceSessionFilePath: target.sourceSessionFilePath || this._sessionFilePath || void 0
      }, (data) => {
        clearTimeout(timeout);
        resolve({
          supported: data.supported !== false,
          success: !!data.success,
          sessionFilePath: data.sessionFilePath,
          nativeEntryId: data.nativeEntryId,
          error: data.error,
          reason: data.reason
        });
      });
    });
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
    if (!this.process) throw new Error("Pi SDK worker is not running");
    let requestId = "";
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (requestId) this.pendingResponses.delete(requestId);
        reject(new Error("Pi SDK set model timed out"));
      }, 8e3);
      requestId = this.sendWorkerCommand({ type: "setModel", provider, modelId }, (data) => {
        clearTimeout(timeout);
        if (data.type === "model_changed") {
          this.emitEvent({ type: "model_changed", model: data.model });
          resolve();
          return;
        }
        reject(new Error(data.error || "Pi SDK set model failed"));
      });
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
    this.activePromptIds.clear();
    this.turnActive = false;
    this.isAborting = false;
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
  activePromptIds = /* @__PURE__ */ new Set();
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
    const child = child_process.spawn(getNodeExecutable(["CODEX_NODE_PATH", "PI_NODE_PATH"]), [getWorkerPath()], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: getCommandEnv()
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
      this.activePromptIds.clear();
    });
    child.on("exit", () => {
      if (this.process === child) this.process = null;
      this.activePromptIds.clear();
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
    const promptId = options?.clientMessageId || this.createCommandId();
    this.activePromptIds.add(promptId);
    this.emitEvent({ type: "message_start", role: "user", content: options?.displayMessage || message });
    this.sendWorkerCommand({
      id: promptId,
      type: "prompt",
      message,
      images,
      planModeEnabled: !!options?.planModeEnabled,
      permissionMode: options?.permissionMode || (options?.planModeEnabled ? "plan" : "full-access")
    });
  }
  isIdle() {
    return !this.isAborting && this.activePromptIds.size === 0 && this.pendingResponses.size === 0;
  }
  async sendGuidance(message, images, options) {
    if (!this.process) throw new Error("Codex worker is not running");
    const guidanceId = this.createCommandId();
    const displayMessage = options?.displayMessage || message;
    const messagePreview = displayMessage.length > 50 ? `${displayMessage.slice(0, 50)}...` : displayMessage;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(guidanceId);
        reject(new Error("Codex guidance timed out"));
      }, 3e4);
      this.sendWorkerCommand({
        id: guidanceId,
        type: "guidance",
        message,
        images,
        planModeEnabled: !!options?.planModeEnabled
      }, (data) => {
        clearTimeout(timeout);
        if (data.type === "accepted" || data.type === "guidance_done") {
          resolve();
        } else {
          reject(new Error(data.error || "Codex guidance failed"));
        }
      });
    });
    this.emitEvent({
      type: "process_event",
      entryType: "status",
      kind: "status",
      title: `收到引导: "${messagePreview || "用户引导"}"`,
      detail: displayMessage || void 0,
      state: "completed"
    });
  }
  async forkSession(target) {
    if (!this.process) {
      return { supported: true, success: false, error: "Codex worker is not running" };
    }
    const requestId = this.createCommandId();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        resolve({ supported: true, success: false, error: "Codex fork timed out" });
      }, 3e4);
      this.sendWorkerCommand({
        id: requestId,
        type: "forkSession",
        ...target,
        sourceSessionFilePath: target.sourceSessionFilePath || this._sessionFilePath || void 0
      }, (data) => {
        clearTimeout(timeout);
        resolve({
          supported: data.supported !== false,
          success: !!data.success,
          sessionFilePath: data.sessionFilePath,
          nativeEntryId: data.nativeEntryId,
          error: data.error,
          reason: data.reason
        });
      });
    });
  }
  async abort() {
    this.isAborting = true;
    this.eventBuffer.clear();
    for (const [id, handler] of this.pendingResponses.entries()) {
      handler({ type: "error", id, error: "Codex request interrupted" });
    }
    this.pendingResponses.clear();
    this.activePromptIds.clear();
    if (!this.process) {
      this.emitEvent({ type: "aborted" });
      this.isAborting = false;
      return;
    }
    await new Promise((resolve) => {
      let acknowledged = false;
      const timeout = setTimeout(() => {
        if (!acknowledged) this.emitEvent({ type: "aborted" });
        resolve();
      }, 5e3);
      this.sendWorkerCommand({ type: "abort" }, () => {
        acknowledged = true;
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
    this.activePromptIds.clear();
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
      case "plan_update":
      case "context_compaction":
      case "diff_update":
        this.emitEvent(data);
        break;
      case "agent_end":
        this.activePromptIds.clear();
        this.emitEvent(data);
        break;
      case "prompt_done":
        if (data.id) this.activePromptIds.delete(String(data.id));
        else this.activePromptIds.clear();
        break;
      case "aborted":
        if (data.promptId) this.activePromptIds.delete(String(data.promptId));
        else this.activePromptIds.clear();
        this.emitEvent({ type: "aborted", promptId: data.promptId });
        break;
      case "error":
        if (data.id) this.activePromptIds.delete(String(data.id));
        else this.activePromptIds.clear();
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
    const content = fs.readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
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
          reasoning: configuredModel?.reasoning ?? model.reasoning,
          supportsImages: Array.isArray(configuredModel?.input) ? configuredModel.input.includes("image") : model.supportsImages
        });
      }
    }
  }
  return result;
}
async function mergeModelsWithConfiguredAgentModels(agentId, models) {
  if (!agentId) return models;
  const configuredModels = await getConfiguredAgentModels(agentId).catch(() => []);
  if (configuredModels.length === 0) return models;
  if (agentId === "codex") return configuredModels;
  if (agentId === "pi") return models;
  const merged = /* @__PURE__ */ new Map();
  for (const model of models) {
    merged.set(`${model.provider}:${model.id}`, model);
  }
  for (const model of configuredModels) {
    merged.set(`${model.provider}:${model.id}`, model);
  }
  return Array.from(merged.values());
}
function resetLocalModelsConfigCache() {
  _localModelsConfig = null;
  _localModelsConfigMtime = 0;
}
function supportsNativePlanMode(agentId) {
  return agentId === "codex" || agentId === "opencode" || agentId === "droid";
}
function supportsGuidance(agentId) {
  return agentId === "pi" || agentId === "codex";
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
  sessionProjectPaths = /* @__PURE__ */ new Map();
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
    this.sessionProjectPaths.set(sessionId, projectPath);
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
  getAgentForSession(sessionId) {
    return sessionId ? this.getAgentBySessionId(sessionId) : this.getActiveAgent();
  }
  getActiveAgentType() {
    return this.activeSessionId ? this.sessionAgentTypes.get(this.activeSessionId) : void 0;
  }
  canReloadConfig(agentId, sessionId) {
    const entries = Array.from(this.sessionAgents.entries());
    const targetEntries = sessionId ? entries.filter(([sid]) => sid === sessionId) : entries.filter(([sid]) => this.sessionAgentTypes.get(sid) === agentId);
    if (sessionId && targetEntries.length === 0) {
      return { success: false, error: "目标 Agent 会话尚未初始化。", reloadedSessionIds: [] };
    }
    for (const [sid] of targetEntries) {
      if (this.sessionAgentTypes.get(sid) !== agentId) {
        return { success: false, error: "目标会话不是指定 Agent。", reloadedSessionIds: [] };
      }
    }
    const busySession = targetEntries.find(([, agent]) => !agent.isIdle());
    if (busySession) {
      return {
        success: false,
        error: "当前 Agent 会话正在运行，请等待空闲后再重载配置。",
        reloadedSessionIds: []
      };
    }
    return { success: true, reloadedSessionIds: targetEntries.map(([sid]) => sid) };
  }
  async getModelsBySessionId(sessionId) {
    const agent = this.sessionAgents.get(sessionId);
    if (!agent) return [];
    const models = await agent.getModels();
    const agentType = this.sessionAgentTypes.get(sessionId);
    const filteredModels = agentType === "pi" ? filterModelsByLocalConfig(models) : models;
    return mergeModelsWithConfiguredAgentModels(agentType, filteredModels);
  }
  sendUIResponse(response) {
    const agent = response?.sessionId ? this.getAgentBySessionId(response.sessionId) : this.getActiveAgent();
    if (!agent) return;
    agent.sendUIResponse(response);
  }
  async sendGuidance(sessionId, message, images, options) {
    const agent = sessionId ? this.getAgentBySessionId(sessionId) : this.getActiveAgent();
    if (!agent) throw new Error("No active agent");
    const agentType = sessionId ? this.getSessionAgentType(sessionId) : this.getActiveAgentType();
    if (!supportsGuidance(agentType) || typeof agent.sendGuidance !== "function") {
      throw new Error("Guidance is not supported by this agent");
    }
    await agent.sendGuidance(message, images, options);
  }
  async forkSession(sessionId, target) {
    const agent = this.getAgentBySessionId(sessionId);
    if (!agent) {
      return { supported: false, success: false, reason: "source session is not initialized" };
    }
    if (typeof agent.forkSession !== "function") {
      return { supported: false, success: false, reason: "agent does not support native fork" };
    }
    return agent.forkSession({
      ...target,
      sourceSessionFilePath: target.sourceSessionFilePath || agent.sessionFilePath || void 0
    });
  }
  async reloadConfig(agentId, sessionId) {
    const entries = Array.from(this.sessionAgents.entries());
    const targetEntries = sessionId ? entries.filter(([sid]) => sid === sessionId) : entries.filter(([sid]) => this.sessionAgentTypes.get(sid) === agentId);
    if (sessionId && targetEntries.length === 0) {
      return { success: false, error: "目标 Agent 会话尚未初始化。", reloadedSessionIds: [] };
    }
    if (targetEntries.length === 0) {
      return {
        success: true,
        models: await mergeModelsWithConfiguredAgentModels(agentId, []),
        reloadedSessionIds: []
      };
    }
    const idleCheck = this.canReloadConfig(agentId, sessionId);
    if (!idleCheck.success) return idleCheck;
    for (const [sid] of targetEntries) {
      if (this.sessionAgentTypes.get(sid) !== agentId) {
        return { success: false, error: "目标会话不是指定 Agent。", reloadedSessionIds: [] };
      }
    }
    const busySession = targetEntries.find(([, agent]) => !agent.isIdle());
    if (busySession) {
      return {
        success: false,
        error: "当前 Agent 会话正在运行，请等待空闲后再重载配置。",
        reloadedSessionIds: []
      };
    }
    const targets = targetEntries.map(([sid, agent]) => {
      const projectPath = this.sessionProjectPaths.get(sid);
      if (!projectPath) {
        throw new Error(`会话 ${sid} 缺少项目路径，无法重载配置。`);
      }
      return {
        sessionId: sid,
        agent,
        agentType: this.sessionAgentTypes.get(sid) || agentId,
        projectPath,
        sessionFilePath: agent.sessionFilePath || this.sessionFilePaths.get(sid)
      };
    });
    resetLocalModelsConfigCache();
    const initializedTargets = [];
    try {
      for (const target of targets) {
        const nextAgent = this.createAgentBackend(target.agentType, target.sessionId);
        if (this.window) nextAgent.setWindow(this.window);
        await nextAgent.init(target.projectPath, target.sessionFilePath);
        initializedTargets.push({
          target,
          nextAgent,
          nextSessionFilePath: nextAgent.sessionFilePath || target.sessionFilePath
        });
      }
    } catch (error) {
      for (const initialized of initializedTargets) {
        initialized.nextAgent.dispose();
      }
      throw error;
    }
    for (const { target, nextAgent, nextSessionFilePath } of initializedTargets) {
      target.agent.dispose();
      this.sessionAgents.set(target.sessionId, nextAgent);
      this.sessionAgentTypes.set(target.sessionId, target.agentType);
      if (nextSessionFilePath) {
        this.sessionFilePaths.set(target.sessionId, nextSessionFilePath);
      } else {
        this.sessionFilePaths.delete(target.sessionId);
      }
    }
    const reloadedSessionIds = targets.map((target) => target.sessionId);
    const modelSessionId = this.activeSessionId && reloadedSessionIds.includes(this.activeSessionId) ? this.activeSessionId : reloadedSessionIds[0];
    const models = modelSessionId ? await this.getModelsBySessionId(modelSessionId) : [];
    return { success: true, models, reloadedSessionIds };
  }
  removeSession(sessionId) {
    const agent = this.sessionAgents.get(sessionId);
    if (agent) {
      agent.dispose();
      this.sessionAgents.delete(sessionId);
    }
    this.sessionAgentTypes.delete(sessionId);
    this.sessionFilePaths.delete(sessionId);
    this.sessionProjectPaths.delete(sessionId);
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
      const permissionMode = planModeEnabled ? "plan" : "full-access";
      const effectiveMessage = planModeEnabled && !supportsNativePlanMode(agentType) ? withPromptPlanMode(message) : message;
      await agent.sendMessage(effectiveMessage, images, {
        planModeEnabled: planModeEnabled && supportsNativePlanMode(agentType),
        permissionMode,
        displayMessage: message,
        clientMessageId: options?.clientMessageId
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle("agent:forkSession", async (_event, sessionId, target) => {
    try {
      return await agentManager.forkSession(sessionId, target);
    } catch (err) {
      return { supported: true, success: false, error: err.message || String(err) };
    }
  });
  electron.ipcMain.handle("agent:reloadConfig", async (_event, agentId, sessionId) => {
    try {
      return await agentManager.reloadConfig(agentId, sessionId);
    } catch (err) {
      return { success: false, error: err.message || String(err), reloadedSessionIds: [] };
    }
  });
  electron.ipcMain.handle("agentConfig:list", async (_event, agentId) => {
    return listAgentConfig(agentId);
  });
  electron.ipcMain.handle("agentConfig:save", async (_event, agentId, config) => {
    const saveResult = await saveAgentProviderConfig(agentId, config);
    if (!saveResult.success || !saveResult.config) {
      return saveResult;
    }
    if (agentId === "codex") {
      const models = await mergeModelsWithConfiguredAgentModels(agentId, []);
      return { ...saveResult, models };
    }
    const idleCheck = agentManager.canReloadConfig(agentId);
    if (!idleCheck.success) {
      const models = await mergeModelsWithConfiguredAgentModels(agentId, []);
      return {
        ...saveResult,
        models,
        error: `配置已保存到本地文件；${idleCheck.error || "当前 Agent 会话不是空闲状态，暂未重载。"}`,
        reloadedSessionIds: []
      };
    }
    try {
      resetLocalModelsConfigCache();
      const reloadResult = await agentManager.reloadConfig(agentId);
      return { ...reloadResult, config: saveResult.config };
    } catch (err) {
      return { success: false, error: err.message || String(err), config: saveResult.config, reloadedSessionIds: [] };
    }
  });
  electron.ipcMain.handle("agentConfig:delete", async (_event, agentId, providerId) => {
    const deleteResult = await deleteAgentProviderConfig(agentId, providerId);
    if (!deleteResult.success || !deleteResult.config) {
      return deleteResult;
    }
    if (agentId === "codex") {
      const models = await mergeModelsWithConfiguredAgentModels(agentId, []);
      return { ...deleteResult, models };
    }
    const idleCheck = agentManager.canReloadConfig(agentId);
    if (!idleCheck.success) {
      const models = await mergeModelsWithConfiguredAgentModels(agentId, []);
      return {
        ...deleteResult,
        models,
        error: `渠道已从本地配置删除；${idleCheck.error || "当前 Agent 会话不是空闲状态，暂未重载。"}`,
        reloadedSessionIds: []
      };
    }
    try {
      resetLocalModelsConfigCache();
      const reloadResult = await agentManager.reloadConfig(agentId);
      return { ...reloadResult, config: deleteResult.config };
    } catch (err) {
      return { success: false, error: err.message || String(err), config: deleteResult.config, reloadedSessionIds: [] };
    }
  });
  electron.ipcMain.handle("agentConfig:activate", async (_event, agentId, providerId) => {
    if (agentId !== "codex") {
      return { success: false, error: "只有 Codex 需要启用渠道；其它 Agent 保存后会以多渠道形式写入配置。", reloadedSessionIds: [] };
    }
    const idleCheck = agentManager.canReloadConfig(agentId);
    if (!idleCheck.success) return idleCheck;
    let snapshots = [];
    try {
      const written = await writeNativeAgentProviderConfig(agentId, providerId);
      snapshots = written.snapshots;
      resetLocalModelsConfigCache();
      const reloadResult = await agentManager.reloadConfig(agentId);
      if (!reloadResult.success) {
        await restoreNativeConfigSnapshots(snapshots);
        resetLocalModelsConfigCache();
        return reloadResult;
      }
      const config = await setActiveAgentProviderConfig(agentId, providerId);
      const models = await mergeModelsWithConfiguredAgentModels(agentId, reloadResult.models || []);
      return { ...reloadResult, models, config };
    } catch (err) {
      if (snapshots.length > 0) {
        await restoreNativeConfigSnapshots(snapshots).catch(() => void 0);
        resetLocalModelsConfigCache();
      }
      return { success: false, error: err.message || String(err), reloadedSessionIds: [] };
    }
  });
  electron.ipcMain.handle("agent:sendGuidance", async (_event, message, images, sessionId, options) => {
    try {
      await agentManager.sendGuidance(sessionId, message, images, options);
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
    const filteredModels = agentType === "pi" ? filterModelsByLocalConfig(models) : models;
    return mergeModelsWithConfiguredAgentModels(agentType, filteredModels);
  });
  electron.ipcMain.handle("agent:setModel", async (_event, provider, modelId, sessionId) => {
    try {
      const agent = agentManager.getAgentForSession(sessionId);
      if (!agent) return { success: false, error: "No active agent" };
      await agent.setModel(provider, modelId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });
  electron.ipcMain.handle("agent:setThinkingLevel", async (_event, level, sessionId) => {
    const agent = agentManager.getAgentForSession(sessionId);
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
if (process.platform === "win32") {
  electron.app.setAppUserModelId("com.hpp.app");
}
const DEFAULT_CLOSE_TO_TRAY = true;
let mainWindow = null;
let tray = null;
let closeToTray = DEFAULT_CLOSE_TO_TRAY;
let isQuitting = false;
let updaterInitialized = false;
let updateStatus = {
  state: "idle",
  currentVersion: electron.app.getVersion(),
  canCheck: false,
  canDownload: false,
  canInstall: false
};
const singleInstanceLock = electron.app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  electron.app.quit();
}
function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}
function getIconPath() {
  return utils.is.dev ? path.join(process.cwd(), "public/icon.png") : path.join(__dirname, "../renderer/icon.png");
}
async function loadCloseToTraySetting() {
  try {
    const settingsPath = path.join(electron.app.getPath("userData"), "hpp-data", "settings.json");
    const content = await promises.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    closeToTray = typeof settings.general?.closeToTray === "boolean" ? settings.general.closeToTray : DEFAULT_CLOSE_TO_TRAY;
  } catch {
    closeToTray = DEFAULT_CLOSE_TO_TRAY;
  }
}
function createTray() {
  if (tray) return;
  const trayIcon = electron.nativeImage.createFromPath(getIconPath());
  tray = new electron.Tray(trayIcon.isEmpty() ? getIconPath() : trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Hpp");
  tray.setContextMenu(electron.Menu.buildFromTemplate([
    { label: "显示 Hpp", click: focusMainWindow },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        electron.app.quit();
      }
    }
  ]));
  tray.on("click", focusMainWindow);
}
function getUpdateFeedLabel() {
  const explicitUrl = process.env.HPP_UPDATE_URL?.trim();
  if (explicitUrl) return explicitUrl;
  return "github:xhaoh94/Hpp";
}
function updateStatusPatch(patch) {
  updateStatus = {
    ...updateStatus,
    currentVersion: electron.app.getVersion(),
    feedUrl: getUpdateFeedLabel(),
    canCheck: electron.app.isPackaged,
    canDownload: patch.state === "available" || patch.state === void 0 && updateStatus.state === "available",
    canInstall: patch.state === "downloaded" || patch.state === void 0 && updateStatus.state === "downloaded",
    ...patch
  };
  mainWindow?.webContents.send("app:update-status", updateStatus);
}
function getReleaseNotes(info) {
  const notes = info.releaseNotes;
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    return notes.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "note" in item) return String(item.note || "");
      return "";
    }).filter(Boolean).join("\n");
  }
  return void 0;
}
function updateStatusFromInfo(state, info, extra) {
  updateStatusPatch({
    state,
    version: info?.version || updateStatus.version,
    releaseDate: info?.releaseDate || updateStatus.releaseDate,
    releaseName: info?.releaseName || updateStatus.releaseName,
    releaseNotes: info ? getReleaseNotes(info) : updateStatus.releaseNotes,
    error: void 0,
    ...extra
  });
}
function notifyUpdate(title, body) {
  if (!electron.Notification.isSupported()) return;
  const notification = new electron.Notification({ title, body, icon: getIconPath() });
  notification.on("click", focusMainWindow);
  notification.show();
}
function initAutoUpdater() {
  if (updaterInitialized) return;
  updaterInitialized = true;
  electronUpdater.autoUpdater.autoDownload = false;
  electronUpdater.autoUpdater.autoInstallOnAppQuit = true;
  const explicitUrl = process.env.HPP_UPDATE_URL?.trim();
  if (explicitUrl) {
    electronUpdater.autoUpdater.setFeedURL({ provider: "generic", url: explicitUrl });
  }
  electronUpdater.autoUpdater.on("checking-for-update", () => {
    updateStatusPatch({
      state: "checking",
      error: void 0,
      percent: void 0,
      bytesPerSecond: void 0,
      transferred: void 0,
      total: void 0
    });
  });
  electronUpdater.autoUpdater.on("update-available", (info) => {
    updateStatusFromInfo("available", info);
    notifyUpdate("Hpp 有新版本", `v${info.version} 可下载`);
  });
  electronUpdater.autoUpdater.on("update-not-available", (info) => {
    updateStatusFromInfo("not-available", info, {
      version: electron.app.getVersion()
    });
  });
  electronUpdater.autoUpdater.on("download-progress", (progress) => {
    updateStatusPatch({
      state: "downloading",
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
      error: void 0
    });
  });
  electronUpdater.autoUpdater.on("update-downloaded", (info) => {
    updateStatusFromInfo("downloaded", info, {
      percent: 100
    });
    notifyUpdate("Hpp 更新已下载", "重启应用即可安装新版本");
  });
  electronUpdater.autoUpdater.on("error", (error) => {
    updateStatusPatch({
      state: "error",
      error: error?.message || String(error)
    });
  });
  updateStatusPatch({
    state: "idle",
    error: void 0
  });
}
async function checkForAppUpdates() {
  if (!electron.app.isPackaged) {
    updateStatusPatch({
      state: "idle",
      error: "自动更新仅在打包后的应用中可用。",
      canCheck: false
    });
    return { success: false, error: updateStatus.error, status: updateStatus };
  }
  try {
    initAutoUpdater();
    updateStatusPatch({ state: "checking", error: void 0 });
    await electronUpdater.autoUpdater.checkForUpdates();
    return { success: true, status: updateStatus };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateStatusPatch({ state: "error", error: message });
    return { success: false, error: message, status: updateStatus };
  }
}
async function downloadAppUpdate() {
  if (!electron.app.isPackaged) {
    return { success: false, error: "自动更新仅在打包后的应用中可用。", status: updateStatus };
  }
  if (updateStatus.state !== "available") {
    return { success: false, error: "当前没有可下载的更新。", status: updateStatus };
  }
  try {
    initAutoUpdater();
    await electronUpdater.autoUpdater.downloadUpdate();
    return { success: true, status: updateStatus };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateStatusPatch({ state: "error", error: message });
    return { success: false, error: message, status: updateStatus };
  }
}
function installAppUpdate() {
  if (updateStatus.state !== "downloaded") {
    return { success: false, error: "更新尚未下载完成。", status: updateStatus };
  }
  isQuitting = true;
  setImmediate(() => electronUpdater.autoUpdater.quitAndInstall(false, true));
  return { success: true, status: updateStatus };
}
function createWindow() {
  electron.Menu.setApplicationMenu(null);
  const iconPath = getIconPath();
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
  mainWindow.on("close", (event) => {
    if (isQuitting || !closeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (utils.is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
if (singleInstanceLock) {
  electron.app.whenReady().then(async () => {
    await loadCloseToTraySetting();
    createWindow();
    createTray();
    registerFileHandlers();
    registerStoreHandlers();
    registerPiSDKHandlers();
    registerAgentStatusHandlers();
    registerAgentHandlers(() => mainWindow);
    updateStatusPatch({
      state: "idle",
      canCheck: electron.app.isPackaged,
      error: electron.app.isPackaged ? void 0 : "自动更新仅在打包后的应用中可用。"
    });
    if (electron.app.isPackaged) {
      initAutoUpdater();
      setTimeout(() => {
        void checkForAppUpdates();
      }, 3e3);
    }
    electron.app.on("activate", () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  electron.app.on("second-instance", () => {
    focusMainWindow();
  });
}
electron.app.on("before-quit", () => {
  isQuitting = true;
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
electron.ipcMain.handle("app:getVersion", () => electron.app.getVersion());
electron.ipcMain.handle("app:update:getStatus", () => updateStatus);
electron.ipcMain.handle("app:update:check", () => checkForAppUpdates());
electron.ipcMain.handle("app:update:download", () => downloadAppUpdate());
electron.ipcMain.handle("app:update:install", () => installAppUpdate());
electron.ipcMain.handle("app:getCloseToTray", () => closeToTray);
electron.ipcMain.handle("app:setCloseToTray", (_event, enabled) => {
  closeToTray = enabled;
  return { success: true };
});
electron.ipcMain.handle("app:showNotification", (_event, options) => {
  if (!electron.Notification.isSupported()) {
    return { success: false, error: "System notifications are not supported on this platform." };
  }
  const notification = new electron.Notification({
    title: options.title || "Hpp",
    body: options.body || "",
    icon: getIconPath()
  });
  notification.on("click", focusMainWindow);
  notification.show();
  return { success: true };
});
electron.ipcMain.handle("clipboard:writeImage", async (_event, imageDataUrl) => {
  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    return { success: false, error: "Invalid image data" };
  }
  const image = electron.nativeImage.createFromDataURL(imageDataUrl);
  if (image.isEmpty()) {
    return { success: false, error: "Invalid image data" };
  }
  electron.clipboard.writeImage(image);
  return { success: true };
});
