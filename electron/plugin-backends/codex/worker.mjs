import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative } from "node:path";
import {
  getRollbackTurnCountForIndex,
  getRollbackTurnCountForTarget,
  normalizeCodexTurns,
} from "./fork-utils.mjs";
import { getCodexCommandInvocation } from "./command-invocation.mjs";

const DEFAULT_MODEL_ID = "default";
const CODEX_PROVIDER = "codex";
const DEFAULT_CODEX_MODEL = {
  id: DEFAULT_MODEL_ID,
  name: "Codex Default",
  provider: CODEX_PROVIDER,
  reasoning: true,
  supportsImages: true,
};
const PLAN_MODE_INSTRUCTIONS = [
  "<plan_mode>",
  "当前回合已启用计划模式。",
  "不要修改文件、应用补丁、运行写入命令，或以其他方式改变工作区状态。",
  "可以检查制定计划所需的上下文。",
  "请用简体中文输出简洁的实施计划，并等待用户明确确认后再实施。",
  "</plan_mode>",
].join("\n");

const DEFAULT_THINKING_LEVEL = "medium";

const normalizeDefaultThinkingLevel = (level) => {
  const normalized = String(level || "").trim().toLowerCase();
  if (normalized === "none") return "off";
  return normalized || undefined;
};

const getTopLevelConfigValue = (content, key) => {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;

    const match = line.match(new RegExp(`^${key}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))`));
    if (match) return match[1] || match[2] || match[3];
  }
  return undefined;
};

const getDefaultThinkingLevel = () => {
  try {
    const configPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
    const content = readFileSync(configPath, "utf8");
    return normalizeDefaultThinkingLevel(getTopLevelConfigValue(content, "model_reasoning_effort")) || DEFAULT_THINKING_LEVEL;
  } catch {
    return DEFAULT_THINKING_LEVEL;
  }
};

let projectPath = "";
let threadId = null;
let appServer = null;
let appServerReady = null;
let nextRpcId = 0;
let pendingRpc = new Map();
let currentModelId = null;
let thinkingLevel = getDefaultThinkingLevel();
let activePlanModeEnabled = false;
let activeHostSystemPrompt = "";
let configuredDeveloperInstructions = "";
let configuredDeveloperInstructionsLoaded = false;
let activePermissionMode = "auto";
let activePromptId = null;
let activeTurnId = null;
let activeThreadId = null;
// Set after a guidance command resolves (turn/steer only injects the input).
// Cleared when the agent starts a new item (the first output that responds
// to the guidance), which the backend uses to place the guidance bubble.
let steerResponsePending = false;
let promptRunning = false;
let aborting = false;
let abortRequested = false;
let abortedPromptId = null;
let interruptedPromptIds = new Set();
let interruptedTurnIds = new Set();
let ignoredTurnIds = new Set();
let streamStarted = false;
let finalResponse = "";
let commandOutputByItemId = new Map();
let reasoningTextByItemId = new Map();
let agentTextByItemId = new Map();
let agentMessagePhaseByItemId = new Map();
let itemStartedAtMsByItemId = new Map();
let subagentMetadataByThreadId = new Map();
let spawnEventIdByThreadId = new Map();
let activityDisplayEventIdByItemId = new Map();
let startedActivityEventIdByThreadId = new Map();
let completedItemIds = new Set();
let contextCompactionEmitted = false;
let pendingUIRequest = null;
let activeImageCleanups = [];
let forkRequestActive = false;
let shuttingDown = false;
let skillPathsByName = new Map();

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const stringifyValue = (value) => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const CODEX_RECONNECT_ENTRY_ID = "codex-reconnect-status";

const getCodexReconnectTitle = (params) => {
  const message = String(params?.message || "").trim();
  const match = message.match(/reconnecting\s*\.{3}\s*(\d+)\s*\/\s*(\d+)/i);
  if (match) return `Reconnecting... ${match[1]}/${match[2]}`;
  return message || "Reconnecting...";
};

const isRetryingCodexError = (params) => {
  if (!isRecord(params)) return false;
  if (params.willRetry === true) return true;
  if (params.willRetry === false) return false;
  return /^reconnecting\s*\.{3}/i.test(String(params.message || ""));
};

const getCodexFinalErrorDetail = (params) => {
  if (!isRecord(params)) return stringifyValue(params);
  const detail = stringifyValue(params);
  if (detail) return detail;
  return String(params.message || params.additionalDetails || "Unknown error");
};

const truncate = (value, maxLength = 1200) => {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
};

const normalizeReasoningEffort = (level) => {
  const normalized = String(level || "").trim().toLowerCase();
  if (normalized === "off" || normalized === "none") return "none";
  // Preserve unknown effort ids returned by the app-server model list so the
  // UI can show exactly what the backend exposes; the server validates them.
  return normalized || undefined;
};

const getSupportedThinkingLevels = (reasoningEfforts) => {
  const levels = [];
  const seen = new Set();
  for (const effort of reasoningEfforts) {
    const value = isRecord(effort) ? effort.reasoningEffort : effort;
    const normalized = normalizeReasoningEffort(value);
    const level = normalized === "none" ? "off" : normalized;
    if (!level || seen.has(level)) continue;
    seen.add(level);
    levels.push(level);
  }
  return levels;
};

const normalizeCodexModel = (model) => {
  if (!isRecord(model) || model.hidden === true) return null;
  const id = String(model.id || model.model || "").trim();
  if (!id) return null;
  const reasoningEfforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
    : [];
  const supportedThinkingLevels = getSupportedThinkingLevels(reasoningEfforts);
  const inputModalities = Array.isArray(model.inputModalities) ? model.inputModalities : [];
  return {
    id,
    name: String(model.displayName || model.name || id),
    provider: CODEX_PROVIDER,
    reasoning: supportedThinkingLevels.some((level) => level !== "off"),
    supportsImages: inputModalities.includes("image"),
    supportedThinkingLevels,
    isDefault: model.isDefault === true,
  };
};

const getModels = async () => {
  try {
    await startAppServer();
    const models = [];
    let cursor = null;
    do {
      const result = await rpcRequest("model/list", { cursor, limit: 100 }, 15000);
      const page = Array.isArray(result?.data) ? result.data : [];
      models.push(...page.map(normalizeCodexModel).filter(Boolean));
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
    } while (cursor && models.length < 1000);
    if (models.length > 0) {
      return models
        .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
        .map(({ isDefault: _isDefault, ...model }) => model);
    }
  } catch (error) {
    process.stderr.write(`[codex-models] ${error?.message || String(error)}\n`);
  }
  return [DEFAULT_CODEX_MODEL];
};

const getActions = async (forceReload = false) => {
  await startAppServer();
  const result = await rpcRequest("skills/list", {
    cwds: projectPath ? [projectPath] : [],
    forceReload,
  }, 30000);
  const entries = Array.isArray(result?.data) ? result.data : [];
  const nextPaths = new Map();
  const actions = [];
  const seen = new Set();
  for (const entry of entries) {
    for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
      const name = String(skill?.name || "").trim();
      const path = String(skill?.path || "").trim();
      if (!name || !path || skill?.enabled === false || seen.has(name)) continue;
      seen.add(name);
      nextPaths.set(name, path);
      actions.push({
        kind: "skill",
        name,
        description: String(skill?.interface?.shortDescription || skill?.shortDescription || skill?.description || "").trim() || undefined,
      });
    }
  }
  skillPathsByName = nextPaths;
  return actions;
};

const resolveActionInput = async (action) => {
  if (!action) return null;
  const kind = String(action.kind || "");
  const name = String(action.name || "").trim();
  if (kind !== "skill" || !name) throw new Error("ACTION_NOT_SUPPORTED");
  await getActions(false);
  const path = skillPathsByName.get(name);
  if (!path) throw new Error("ACTION_NOT_FOUND");
  return { type: "skill", name, path };
};

const pathEnvKey = (env, platform = process.platform) => {
  if (platform !== "win32") return "PATH";
  const matchingKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  return matchingKeys.includes("Path") ? "Path" : matchingKeys.at(-1) ?? "PATH";
};

const getWindowsCommandNames = (command) => {
  if (process.platform !== "win32") return [command];
  const supported = new Set([".com", ".exe", ".cmd", ".bat"]);
  const configured = String(process.env.PATHEXT || "")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => supported.has(ext));
  const extensions = [...new Set([...configured, ".com", ".exe", ".cmd", ".bat"])];
  const lower = command.toLowerCase();
  if (extensions.some((ext) => lower.endsWith(ext))) return [command];
  return extensions.map((ext) => `${command}${ext}`);
};

const findCommandsOnPath = (command) => {
  const key = pathEnvKey(process.env);
  const matches = [];
  const seen = new Set();
  const dirs = String(process.env[key] || "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of getWindowsCommandNames(command)) {
      const candidate = join(dir, name);
      const cacheKey = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      if (!seen.has(cacheKey) && existsSync(candidate)) {
        seen.add(cacheKey);
        matches.push(candidate);
      }
    }
  }
  return matches;
};

const checkCodexExecutable = (candidate) => {
  const invocation = getCodexCommandInvocation(candidate, ["--version"]);
  const result = spawnSync(invocation.command, invocation.args, {
    env: process.env,
    encoding: "utf8",
    timeout: 5000,
  });
  if (!result.error && result.status === 0) return { usable: true };
  const detail = [
    result.error?.message,
    result.stderr,
    result.stdout,
  ].filter(Boolean).join("\n").trim();
  return { usable: false, error: detail || `exit code ${result.status ?? "unknown"}` };
};

const resolveCodexExecutable = () => {
  if (process.env.CODEX_PATH && existsSync(process.env.CODEX_PATH)) {
    return process.env.CODEX_PATH;
  }

  const candidates = findCommandsOnPath("codex");
  const errors = [];
  for (const candidate of candidates) {
    const check = checkCodexExecutable(candidate);
    if (check.usable) return candidate;
    errors.push(`${candidate}: ${check.error}`);
  }

  if (candidates.length > 0) {
    throw new Error(`Unable to launch Codex CLI. Checked ${candidates.length} candidate(s).\n${errors.slice(0, 3).join("\n")}`);
  }

  if (process.platform === "win32") {
    throw new Error("Unable to locate Codex CLI. Install it from Hpp Agent settings, use `npm install -g @openai/codex`, or set CODEX_PATH to codex.exe.");
  }

  throw new Error("Unable to locate Codex CLI. Install it from Hpp Agent settings, use `npm install -g @openai/codex`, or set CODEX_PATH to the codex executable.");
};

const startAppServer = async () => {
  if (appServerReady) return appServerReady;

  configuredDeveloperInstructions = "";
  configuredDeveloperInstructionsLoaded = false;

  appServerReady = new Promise((resolve, reject) => {
    let settled = false;
    const executablePath = resolveCodexExecutable();
    const env = { ...process.env };
    if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
      env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "codex_sdk_ts";
    }

    const invocation = getCodexCommandInvocation(executablePath, ["app-server", "--stdio"]);
    const child = spawn(invocation.command, invocation.args, {
      cwd: projectPath || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    appServer = child;

    const finishInit = async () => {
      try {
        await rpcRequest("initialize", {
          clientInfo: { name: "hpp", title: "HPP", version: "1.0.0" },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: true,
          },
        });
        rpcNotify("initialized");
        if (!settled) {
          settled = true;
          resolve();
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    };

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        handleRpcMessage(JSON.parse(line));
      } catch {
        // Ignore non-protocol output.
      }
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      if (text) process.stderr.write(`[codex-app-server] ${text}`);
    });

    let transportTerminated = false;
    const handleTransportTermination = (error) => {
      if (transportTerminated) return;
      transportTerminated = true;
      if (appServer === child) {
        appServer = null;
        appServerReady = null;
      }
      failPendingRpc(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
      if (aborting) return;
      if (promptRunning) {
        pendingUIRequest = null;
        abortRequested = false;
        send({
          type: "process_event",
          entryType: "error",
          title: "Codex app-server disconnected",
          detail: error?.message || String(error),
          state: "error",
        });
        finishPrompt();
      }
      send({ type: "agent_disconnected", detail: error?.message || String(error) });
    };

    child.stdout?.on("end", () => {
      handleTransportTermination(new Error("Codex app-server output pipe closed before the process exited"));
    });

    child.stdin?.on("error", (error) => {
      handleTransportTermination(new Error(`Codex app-server input pipe closed: ${error.message}`));
    });

    child.on("error", (error) => {
      handleTransportTermination(error);
    });

    child.on("exit", (code, signal) => {
      handleTransportTermination(new Error(`Codex app-server exited with ${signal || code}`));
    });

    setTimeout(() => void finishInit(), 0);
  });

  return appServerReady;
};

const failPendingRpc = (error) => {
  for (const pending of pendingRpc.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  pendingRpc.clear();
};

const waitForProcessExit = (child, timeoutMs) => {
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(true);
  if (child.signalCode !== null && child.signalCode !== undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
};

const killProcessTree = (child) => {
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
    });
    return;
  }
  child.kill("SIGKILL");
};

const writeRpc = (message) => {
  if (!appServer?.stdin?.writable) throw new Error("Codex app-server is not running");
  appServer.stdin.write(`${JSON.stringify(message)}\n`);
};

const rpcRequest = (method, params, timeoutMs = 120000) => {
  const id = ++nextRpcId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRpc.delete(id);
      reject(new Error(`Codex app-server request timed out: ${method}`));
    }, timeoutMs);
    pendingRpc.set(id, { method, resolve, reject, timeout });
    try {
      writeRpc({ id, method, params });
    } catch (error) {
      clearTimeout(timeout);
      pendingRpc.delete(id);
      reject(error);
    }
  });
};

const getThreadIdFromResult = (result) =>
  result?.thread?.id ||
  result?.threadId ||
  result?.id ||
  result?.thread?.threadId ||
  "";

const requestThreadFork = async (sourceThreadId) => {
  const params = buildThreadParams();
  const attempts = [
    { threadId: sourceThreadId, ...params },
    { threadId: sourceThreadId },
  ];
  let lastError = null;
  for (const forkParams of attempts) {
    try {
      const result = await rpcRequest("thread/fork", forkParams, 30000);
      const forkedThreadId = getThreadIdFromResult(result);
      if (forkedThreadId) return forkedThreadId;
      lastError = new Error("Codex app-server did not return a forked thread id");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Codex thread/fork failed");
};

const requestThreadRollback = async (targetThreadId, numTurns) => {
  if (numTurns <= 0) return targetThreadId;
  const result = await rpcRequest("thread/rollback", {
    threadId: targetThreadId,
    numTurns,
  }, 30000);
  return getThreadIdFromResult(result) || targetThreadId;
};

const requestThreadTurns = async (sourceThreadId) => {
  const attempts = [
    ["thread/read", { threadId: sourceThreadId, includeTurns: true }],
    ["thread/turns/list", {
      threadId: sourceThreadId,
      cursor: null,
      limit: 1000,
      sortDirection: "asc",
      itemsView: "full",
    }],
    ["thread/turns/list", {
      threadId: sourceThreadId,
      cursor: null,
      limit: 1000,
      sortDirection: "asc",
    }],
  ];
  let lastError = null;
  for (const [method, params] of attempts) {
    try {
      const result = await rpcRequest(method, params, 30000);
      const turns = normalizeCodexTurns(result);
      if (turns.length > 0) return turns;
      lastError = new Error(`${method} did not return turns`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Codex app-server did not return thread turns");
};

const getLegacyRollbackTurnCount = (command) =>
  Math.max(0, Number(command.rollbackUserMessageCount || 0));

const resolveRollbackTurnCount = async (command, sourceThreadId) => {
  const legacyRollbackTurnCount = getLegacyRollbackTurnCount(command);
  if (!Number.isInteger(legacyRollbackTurnCount)) {
    throw new Error("source Codex rollback turn count is invalid");
  }

  const targetTurnId = String(command.targetTurnId || "").trim();
  try {
    const turns = await requestThreadTurns(sourceThreadId);
    if (targetTurnId) {
      const rollbackTurnCount = getRollbackTurnCountForTarget(turns, targetTurnId);
      if (rollbackTurnCount !== null) return rollbackTurnCount;
    }

    const sourceTurnIndex = Number(command.sourceUserMessageIndex);
    const rollbackTurnCount = getRollbackTurnCountForIndex(turns, sourceTurnIndex);
    if (rollbackTurnCount !== null) return rollbackTurnCount;
  } catch {
    // Older app-server versions may not expose turn listing. Keep the legacy
    // count path as a fallback so fork remains available.
  }

  return legacyRollbackTurnCount;
};

const forkCodexSession = async (command) => {
  await startAppServer();
  const sourceThreadId = command.sourceSessionFilePath || threadId;
  if (!sourceThreadId) {
    return { supported: true, success: false, reason: "source Codex thread is not initialized" };
  }

  const originalThreadId = threadId;
  const originalActiveThreadId = activeThreadId;
  forkRequestActive = true;
  try {
    const rollbackTurnCount = await resolveRollbackTurnCount(command, sourceThreadId);
    const forkedThreadId = await requestThreadFork(sourceThreadId);
    const sessionFilePath = await requestThreadRollback(forkedThreadId, rollbackTurnCount);
    return {
      supported: true,
      success: true,
      sessionFilePath,
    };
  } catch (error) {
    const message = error?.message || String(error);
    const unsupported = /unknown method|method not found|unsupported|not found/i.test(message);
    return {
      supported: !unsupported,
      success: false,
      reason: unsupported ? "Codex app-server does not expose thread/fork in this version" : undefined,
      error: message,
    };
  } finally {
    forkRequestActive = false;
    threadId = originalThreadId;
    activeThreadId = originalActiveThreadId;
  }
};

const rpcNotify = (method, params) => {
  writeRpc(params === undefined ? { method } : { method, params });
};

const rpcRespond = (id, result) => {
  writeRpc({ id, result });
};

const rpcReject = (id, message, code = -32000) => {
  writeRpc({ id, error: { code, message } });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const interruptTurn = async (turnId, timeoutMs = 5000) => {
  if (!turnId || interruptedTurnIds.has(turnId)) return;
  const targetThreadId = activeThreadId || threadId;
  if (!targetThreadId) return;
  interruptedTurnIds.add(turnId);
  try {
    await rpcRequest("turn/interrupt", { threadId: targetThreadId, turnId }, timeoutMs);
  } catch {
    // The turn may already have completed or the app-server may be shutting down.
  }
};

const getTurnId = (params) =>
  params?.turn?.id ||
  params?.turnId ||
  params?.item?.turnId ||
  params?.item?.turn?.id ||
  null;

const getTurnClientUserMessageId = (params) =>
  params?.turn?.clientUserMessageId ||
  params?.turn?.client_user_message_id ||
  params?.clientUserMessageId ||
  params?.client_user_message_id ||
  params?.item?.clientUserMessageId ||
  params?.item?.client_user_message_id ||
  "";

const shouldIgnoreTurnNotification = (params) => {
  const turnId = getTurnId(params);
  if (turnId && ignoredTurnIds.has(turnId)) return true;

  const clientUserMessageId = String(getTurnClientUserMessageId(params) || "");
  if (clientUserMessageId && interruptedPromptIds.has(clientUserMessageId)) {
    if (turnId) {
      ignoredTurnIds.add(turnId);
      void interruptTurn(turnId);
    }
    return true;
  }

  if (clientUserMessageId && activePromptId && clientUserMessageId !== activePromptId) {
    if (turnId) {
      ignoredTurnIds.add(turnId);
      void interruptTurn(turnId);
    }
    return true;
  }

  if (turnId && activeTurnId && turnId !== activeTurnId) {
    ignoredTurnIds.add(turnId);
    return true;
  }

  return false;
};

const handleRpcMessage = (message) => {
  if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
    const pending = pendingRpc.get(message.id);
    if (!pending) return;
    pendingRpc.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(message.error.message || stringifyValue(message.error)));
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
    handleServerRequest(message);
    return;
  }

  if (message.method) {
    handleServerNotification(message.method, message.params || {});
  }
};

const getImageExtension = (mimeType) => {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  return ".png";
};

const materializeImages = async (images) => {
  if (!Array.isArray(images) || images.length === 0) {
    return { entries: [], cleanup: async () => {} };
  }

  const dir = await mkdtemp(join(tmpdir(), "hpp-codex-images-"));
  const entries = [];

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const rawData = String(image?.data || "").replace(/^data:.*?;base64,/, "");
    if (!rawData) continue;
    const filePath = join(dir, `image-${index + 1}${getImageExtension(image?.mimeType)}`);
    await writeFile(filePath, Buffer.from(rawData, "base64"));
    entries.push({ type: "localImage", path: filePath });
  }

  return {
    entries,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

const cleanupActiveImages = async () => {
  const cleanups = activeImageCleanups;
  activeImageCleanups = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch {
      // Temporary image cleanup should not affect turn state.
    }
  }
};

const registerActiveImageCleanup = (cleanup) => {
  if (typeof cleanup === "function") activeImageCleanups.push(cleanup);
};

const buildInput = (message, images, actionInput) => {
  const text = activePlanModeEnabled ? `${PLAN_MODE_INSTRUCTIONS}\n\n${message || ""}` : (message || "");
  const input = [];
  if (actionInput) input.push(actionInput);
  if (text) input.push({ type: "text", text, text_elements: [] });
  if (input.length === 0 && images.length === 0) {
    input.push({ type: "text", text: "Please continue.", text_elements: [] });
  }
  return [...input, ...images];
};

const combineDeveloperInstructions = (configuredInstructions, hostSystemPrompt) => {
  const configured = String(configuredInstructions || "").trim();
  const host = String(hostSystemPrompt || "").trim();
  if (!host) return "";
  if (!configured || configured === host || configured.endsWith(`\n\n${host}`)) return configured || host;
  return `${configured}\n\n${host}`;
};

const getHostDeveloperInstructions = () => combineDeveloperInstructions(
  configuredDeveloperInstructions,
  activeHostSystemPrompt,
);

// Codex's collaboration mode takes precedence over thread-level developer
// instructions. Include the host policy in the mode payload as well, so Plan
// mode cannot silently drop the language rule. The legacy config key remains
// in buildThreadParams for older app-server versions, while current versions
// consume the native camelCase field.
const getTurnDeveloperInstructions = () => {
  const hostInstructions = getHostDeveloperInstructions();
  if (!activePlanModeEnabled) return hostInstructions;
  return [PLAN_MODE_INSTRUCTIONS, hostInstructions].filter(Boolean).join("\n\n");
};

const refreshConfiguredDeveloperInstructions = async () => {
  if (configuredDeveloperInstructionsLoaded) return;
  configuredDeveloperInstructionsLoaded = true;
  configuredDeveloperInstructions = "";
  try {
    const result = await rpcRequest("config/read", {
      cwd: projectPath,
      includeLayers: false,
    }, 5000);
    if (typeof result?.config?.developer_instructions === "string") {
      configuredDeveloperInstructions = result.config.developer_instructions.trim();
    }
  } catch {
    // Older app-server versions may not implement config/read. Host guidance
    // must still work, even when existing developer instructions cannot be
    // discovered and merged.
  }
};

const buildThreadParams = () => {
  const askPermissionEnabled = activePermissionMode === "ask";
  const automaticPermissionEnabled = activePermissionMode === "auto";
  const fullAccessEnabled = activePermissionMode === "full-access";
  const developerInstructions = getHostDeveloperInstructions();
  const config = {
    ...(activePlanModeEnabled
      ? {
          collaboration_mode: "Plan",
          include_collaboration_mode_instructions: true,
        }
      : {}),
    ...(activeHostSystemPrompt
      ? {
          // Kept as a compatibility fallback for older app-server builds.
          developer_instructions: developerInstructions,
        }
      : {}),
  };
  const params = {
    cwd: projectPath,
    sandbox: askPermissionEnabled
      ? "read-only"
      : automaticPermissionEnabled
        ? "workspace-write"
        : "danger-full-access",
    approvalPolicy: fullAccessEnabled ? "never" : "on-request",
    // This is the native app-server field. `config.developer_instructions`
    // above is not sufficient on current Codex releases.
    developerInstructions: developerInstructions || undefined,
    config: Object.keys(config).length > 0 ? config : undefined,
    serviceName: "HPP",
    threadSource: "hpp",
  };

  const effort = normalizeReasoningEffort(thinkingLevel);
  if (effort) params.config = { ...(params.config || {}), model_reasoning_effort: effort };
  if (currentModelId && currentModelId !== DEFAULT_MODEL_ID) params.model = currentModelId;
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
};

const getRequestModelId = () =>
  currentModelId && currentModelId !== DEFAULT_MODEL_ID ? currentModelId : undefined;

const buildTurnCollaborationMode = () => ({
  mode: activePlanModeEnabled ? "plan" : "default",
  settings: {
    model: getRequestModelId() || "",
    reasoning_effort: normalizeReasoningEffort(thinkingLevel) || null,
    developer_instructions: getTurnDeveloperInstructions() || null,
  },
});

const isMissingThreadRolloutError = (error) =>
  /no rollout found for thread id\b/i.test(error?.message || String(error));

const startThread = async () => {
  const result = await rpcRequest("thread/start", buildThreadParams());
  threadId = result?.thread?.id;
  activeThreadId = threadId;
  if (!threadId) throw new Error("Codex app-server did not return a thread id");
  send({ type: "session_file_path", sessionFilePath: threadId, threadId });
  return threadId;
};

const ensureThread = async () => {
  await startAppServer();
  if (threadId) {
    try {
      const result = await rpcRequest("thread/resume", {
        threadId,
        ...buildThreadParams(),
      });
      threadId = result?.thread?.id || threadId;
      activeThreadId = threadId;
      send({ type: "session_file_path", sessionFilePath: threadId, threadId });
      return threadId;
    } catch (error) {
      if (!isMissingThreadRolloutError(error)) throw error;
      threadId = null;
      activeThreadId = null;
    }
  }

  return startThread();
};

const startStream = () => {
  if (streamStarted) return;
  streamStarted = true;
  send({ type: "agent_start" });
  send({ type: "stream_start", role: "assistant" });
};

const sendTurnMetadata = (turnId) => {
  const nativeTurnId = String(turnId || "").trim();
  if (!nativeTurnId) return;
  send({
    type: "turn_metadata",
    nativeTurnId,
    turnId: nativeTurnId,
    clientUserMessageId: activePromptId || undefined,
    threadId: activeThreadId || threadId || undefined,
  });
};

const resetTurnState = () => {
  streamStarted = false;
  finalResponse = "";
  activeTurnId = null;
  commandOutputByItemId = new Map();
  reasoningTextByItemId = new Map();
  agentTextByItemId = new Map();
  agentMessagePhaseByItemId = new Map();
  itemStartedAtMsByItemId = new Map();
  spawnEventIdByThreadId = new Map();
  activityDisplayEventIdByItemId = new Map();
  startedActivityEventIdByThreadId = new Map();
  completedItemIds = new Set();
  contextCompactionEmitted = false;
  interruptedTurnIds = new Set();
};

const normalizeQuestionOption = (option) => ({
  label: String(option?.label ?? option?.value ?? option ?? ""),
  value: String(option?.label ?? option?.value ?? option ?? ""),
  description: option?.description,
});

const normalizeUserInputQuestions = (questions) => {
  if (!Array.isArray(questions)) return [];
  return questions.map((question, index) => ({
    id: question?.id || `question-${index + 1}`,
    header: question?.header,
    question: String(question?.question || question?.prompt || question?.title || `Question ${index + 1}`),
    options: Array.isArray(question?.options) ? question.options.map(normalizeQuestionOption).filter((option) => option.label) : [],
    multiSelect: false,
    allowOther: !!question?.isOther,
    isSecret: !!question?.isSecret,
  }));
};

const handleServerRequest = (message) => {
  if (abortRequested && Object.prototype.hasOwnProperty.call(message, "id")) {
    rpcReject(message.id, "Turn was interrupted");
    return;
  }

  switch (message.method) {
    case "item/tool/requestUserInput":
      handleRequestUserInput(message);
      break;
    case "mcpServer/elicitation/request":
      handleMcpElicitationRequest(message);
      break;
    case "item/commandExecution/requestApproval":
      handleApprovalRequest(message, "command", "accept", "decline");
      break;
    case "item/fileChange/requestApproval":
      handleApprovalRequest(message, "file", "accept", "decline");
      break;
    case "execCommandApproval":
      handleApprovalRequest(message, "command", "approved", "denied");
      break;
    case "applyPatchApproval":
      handleApprovalRequest(message, "file", "approved", "denied");
      break;
    case "item/permissions/requestApproval":
      if (activePermissionMode === "full-access") {
        rpcRespond(message.id, {
          permissions: message.params?.permissions || {},
          scope: "turn",
        });
      } else {
        handlePermissionsApprovalRequest(message);
      }
      break;
    case "currentTime/read":
      rpcRespond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      break;
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
      rpcReject(message.id, `${message.method} is not supported by HPP`);
      break;
    default:
      rpcReject(message.id, `Unsupported Codex app-server request: ${message.method}`);
      break;
  }
};

const handleApprovalRequest = (message, approvalKind, acceptDecision, declineDecision) => {
  const params = message.params || {};
  const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
  const fileChanges = isRecord(params.fileChanges)
    ? Object.keys(params.fileChanges).join("\n")
    : params.grantRoot || "";
  const requestText = approvalKind === "command"
    ? `允许 Codex 执行命令${command ? `: ${command}` : ""}`
    : `允许 Codex 修改文件${fileChanges ? `:\n${fileChanges}` : ""}`;
  const requestId = `codex-request-${message.id}`;
  pendingUIRequest = {
    id: requestId,
    rpcId: message.id,
    params,
    questions: [{
      id: "approval",
      question: requestText,
      options: [
        { label: "允许", value: "accept", description: params.reason || undefined },
        { label: "拒绝", value: "decline" },
      ],
    }],
    approval: { acceptDecision, declineDecision },
  };
  startStream();
  send({
    type: "process_event",
    entryType: "question",
    kind: "question",
    requestId,
    method: "confirm",
    title: "Codex 请求权限",
    message: requestText,
    prompt: "Codex 请求权限",
    state: "running",
  });
};

const handlePermissionsApprovalRequest = (message) => {
  const params = message.params || {};
  const permissions = isRecord(params.permissions) ? params.permissions : {};
  const permissionSummary = Object.keys(permissions).join("、") || "额外能力";
  const requestText = `允许 Codex 使用${permissionSummary}`;
  const requestId = `codex-request-${message.id}`;
  pendingUIRequest = {
    id: requestId,
    rpcId: message.id,
    params,
    questions: [{
      id: "approval",
      question: requestText,
      options: [
        { label: "允许", value: "accept", description: params.reason || undefined },
        { label: "拒绝", value: "decline" },
      ],
    }],
    permissionsApproval: { permissions },
  };
  startStream();
  send({
    type: "process_event",
    entryType: "question",
    kind: "question",
    requestId,
    method: "confirm",
    title: "Codex 请求权限",
    message: requestText,
    prompt: "Codex 请求权限",
    state: "running",
  });
};

const handleRequestUserInput = (message) => {
  const params = message.params || {};
  const questions = normalizeUserInputQuestions(params.questions);
  const requestId = `codex-request-${message.id}`;
  pendingUIRequest = {
    id: requestId,
    rpcId: message.id,
    params,
    questions,
  };
  startStream();
  send({
    type: "process_event",
    entryType: "question",
    kind: "question",
    requestId,
    method: "item/tool/requestUserInput",
    title: questions[0]?.question ? `正在询问用户: ${questions[0].question}` : "正在询问用户",
    questions,
    prompt: questions[0]?.question,
    state: "running",
  });
};

const jsonSchemaToOptions = (schema) => {
  if (!isRecord(schema)) return [];
  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  const enumNames = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  return enumValues.map((value, index) => ({
    label: String(enumNames[index] || value),
    value: String(value),
  }));
};

const mcpElicitationQuestions = (params) => {
  const schema = params?.requestedSchema;
  if (!isRecord(schema)) {
    return [{
      id: "response",
      question: params?.message || "Please provide input",
      options: [],
    }];
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const questions = Object.entries(properties).map(([id, property]) => {
    const prop = isRecord(property) ? property : {};
    return {
      id,
      header: required.includes(id) ? "Required" : undefined,
      question: String(prop.title || prop.description || id),
      options: jsonSchemaToOptions(prop),
      allowOther: prop.type !== "boolean" && !Array.isArray(prop.enum),
    };
  });

  return questions.length > 0
    ? questions
    : [{
        id: "response",
        question: params?.message || "Please provide input",
        options: jsonSchemaToOptions(schema),
      }];
};

const handleMcpElicitationRequest = (message) => {
  const params = message.params || {};
  const questions = mcpElicitationQuestions(params);
  const requestId = `codex-request-${message.id}`;
  pendingUIRequest = {
    id: requestId,
    rpcId: message.id,
    params,
    questions,
    mcpElicitation: true,
  };
  startStream();
  send({
    type: "process_event",
    entryType: "question",
    kind: "question",
    requestId,
    method: "mcpServer/elicitation/request",
    title: params.message ? `正在询问用户: ${params.message}` : "正在询问用户",
    questions,
    prompt: params.message || questions[0]?.question,
    state: "running",
  });
};

const responseAnswersToCodex = (response) => {
  const rawAnswers = Array.isArray(response?.answers)
    ? response.answers
    : Array.isArray(response?.result?.answers)
      ? response.result.answers
      : [];
  const answers = {};
  const questions = pendingUIRequest?.questions || [];

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const answer = rawAnswers.find((item) => item?.id === question.id || item?.questionIndex === index) || rawAnswers[index];
    if (!answer) continue;
    const values = [];
    if (Array.isArray(answer.values)) values.push(...answer.values);
    if (Array.isArray(answer.answers)) values.push(...answer.answers);
    if (answer.label) values.push(answer.label);
    if (answer.value) values.push(answer.value);
    if (answer.answer) values.push(answer.answer);
    if (answer.custom) values.push(answer.custom);
    const normalizedValues = values.map((value) => String(value)).filter(Boolean);
    if (normalizedValues.length > 0) {
      answers[question.id] = { answers: normalizedValues };
    }
  }

  return { answers };
};

const responseAnswersToMcpElicitation = (response) => {
  const codexShape = responseAnswersToCodex(response);
  const content = {};
  for (const [id, answer] of Object.entries(codexShape.answers || {})) {
    const values = Array.isArray(answer?.answers) ? answer.answers : [];
    content[id] = values.length <= 1 ? values[0] ?? "" : values;
  }
  return { action: "accept", content, _meta: null };
};

const responseToApproval = (response) => {
  const answer = responseAnswersToCodex(response).answers?.approval?.answers?.[0] || "";
  const decision = response?.confirmed === true || String(answer).toLowerCase() === "accept"
    ? pendingUIRequest?.approval?.acceptDecision
    : pendingUIRequest?.approval?.declineDecision;
  return { decision: decision || "decline" };
};

const runUIResponse = (response) => {
  if (!pendingUIRequest || response?.id !== pendingUIRequest.id) {
    throw new Error(response?.id
      ? `Unknown Codex UI request: ${response.id}`
      : "Codex UI response is missing request id");
  }

  const rpcId = pendingUIRequest.rpcId;
  let result;
  if (response?.cancelled) {
    if (pendingUIRequest.approval) {
      result = { decision: pendingUIRequest.approval.declineDecision };
    } else if (pendingUIRequest.permissionsApproval) {
      result = { permissions: {}, scope: "turn" };
    } else if (pendingUIRequest.mcpElicitation) {
      result = { action: "cancel", content: null, _meta: null };
    } else {
      result = { answers: {} };
    }
  } else if (pendingUIRequest.approval) {
    result = responseToApproval(response);
  } else if (pendingUIRequest.permissionsApproval) {
    const accepted = response?.confirmed === true || String(
      responseAnswersToCodex(response).answers?.approval?.answers?.[0] || "",
    ).toLowerCase() === "accept";
    result = {
      permissions: accepted ? pendingUIRequest.permissionsApproval.permissions : {},
      scope: "turn",
    };
  } else if (pendingUIRequest.mcpElicitation) {
    result = responseAnswersToMcpElicitation(response);
  } else {
    result = responseAnswersToCodex(response);
  }

  pendingUIRequest = null;
  rpcRespond(rpcId, result);
};

const emitCommandItem = (item, phase) => {
  const terminal = phase === "completed" || item.status === "completed" || item.status === "failed";
  const outputText = item.aggregatedOutput || commandOutputByItemId.get(item.id) || "";
  const command = item.command || "";
  send({
    type: terminal ? "tool_end" : "tool_start",
    toolName: "shell",
    toolCallId: item.id,
    toolKind: "run_command",
    args: { command, cwd: item.cwd },
    command,
    result: terminal ? { output: outputText, exit_code: item.exitCode, status: item.status } : undefined,
    outputText,
    detail: truncate([command ? `$ ${command}` : "", outputText].filter(Boolean).join("\n")),
    exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
    isError: item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0),
  });
};

const countPatchChanges = (patch) => ({
  additions: (String(patch || "").match(/^\+[^+]/gm) || []).length,
  deletions: (String(patch || "").match(/^-[^-]/gm) || []).length,
});

const normalizeDiffPath = (filePath) => String(filePath || "").replace(/\\/g, "/");

const toProjectRelativePath = (filePath) => {
  const value = String(filePath || "");
  if (!value || !projectPath || !isAbsolute(value)) return value;
  try {
    const relativePath = relative(projectPath, value);
    if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
      return relativePath;
    }
  } catch {
    // Fall through to the original path.
  }
  return value;
};

const getChangeFilePath = (change) => toProjectRelativePath(
  change?.path ||
  change?.file ||
  change?.filePath ||
  change?.file_path ||
  change?.move_path ||
  change?.movePath ||
  ""
);

const getChangeKind = (change) => change?.kind || change?.type || change?.status || "update";

const firstChangeString = (change, keys) => {
  for (const key of keys) {
    const value = change?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
};

const splitContentLines = (content) => {
  const lines = String(content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

const buildWholeFilePatch = (filePath, kind, content) => {
  const pathForDiff = normalizeDiffPath(filePath);
  const lines = splitContentLines(content);
  const lineCount = lines.length;
  if (kind === "add") {
    return [
      `diff --git a/${pathForDiff} b/${pathForDiff}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${pathForDiff}`,
      `@@ -0,0 +1,${lineCount} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
  }
  if (kind === "delete") {
    return [
      `diff --git a/${pathForDiff} b/${pathForDiff}`,
      "deleted file mode 100644",
      `--- a/${pathForDiff}`,
      "+++ /dev/null",
      `@@ -1,${lineCount} +0,0 @@`,
      ...lines.map((line) => `-${line}`),
    ].join("\n");
  }
  return "";
};

const getPatchFromChange = (change, filePath, kind) => {
  const directPatch = firstChangeString(change, [
    "unified_diff",
    "unifiedDiff",
    "patch",
    "diff",
  ]);
  if (directPatch) return directPatch;

  const content = firstChangeString(change, ["content", "old_content", "oldContent", "new_content", "newContent"]);
  if ((kind === "add" || kind === "delete") && content) {
    return buildWholeFilePatch(filePath, kind, content);
  }
  return "";
};

const getFilesFromChanges = (changes) => {
  if (!Array.isArray(changes)) return [];
  return changes
    .map((change) => {
      const filePath = getChangeFilePath(change);
      if (!filePath) return null;
      const kind = getChangeKind(change);
      const patch = getPatchFromChange(change, filePath, kind);
      const stats = countPatchChanges(patch);
      return {
        file: filePath,
        label: basename(filePath),
        action: kind === "add" ? "written" : "edited",
        status: kind === "add" ? "added" : kind === "delete" ? "deleted" : "modified",
        patch,
        additions: stats.additions,
        deletions: stats.deletions,
      };
    })
    .filter(Boolean);
};

const emitFileChangeItem = (item, phase) => {
  const terminal = phase === "completed" || item.status === "completed" || item.status === "failed";
  const files = getFilesFromChanges(item.changes);
  send({
    type: terminal ? "tool_end" : "tool_start",
    toolName: "file_change",
    toolCallId: item.id,
    toolKind: "edit_file",
    args: { changes: item.changes },
    result: terminal ? { changes: item.changes, status: item.status } : undefined,
    detail: files.map((file) => file.file).join("\n"),
    files,
    isError: item.status === "failed",
  });
};

const emitMcpToolItem = (item, phase) => {
  const terminal = phase === "completed" || item.status === "completed" || item.status === "failed";
  const toolName = [item.server, item.tool].filter(Boolean).join(".") || item.tool || "mcp_tool";
  const resultText = item.error?.message || stringifyValue(item.result || item.contentItems);
  send({
    type: terminal ? "tool_end" : "tool_start",
    toolName,
    toolCallId: item.id,
    toolKind: "unknown",
    args: item.arguments,
    result: item.result || item.contentItems,
    outputText: resultText,
    errorText: item.error?.message,
    detail: truncate(resultText),
    isError: item.status === "failed" || !!item.error || item.success === false,
  });
};

const emitWebSearchItem = (item, phase) => {
  send({
    type: phase === "completed" ? "tool_end" : "tool_start",
    toolName: "web_search",
    toolCallId: item.id,
    toolKind: "web_search",
    args: { query: item.query },
    result: phase === "completed" ? { query: item.query, action: item.action } : undefined,
    detail: item.query,
    isError: false,
  });
};

const getDelta = (map, id, nextText) => {
  const previous = map.get(id) || "";
  map.set(id, nextText || "");
  if (!nextText) return "";
  if (nextText.startsWith(previous)) return nextText.slice(previous.length);
  return nextText;
};

const getAgentMessagePhase = (item) => {
  const hasExplicitPhase = Object.prototype.hasOwnProperty.call(item, "phase");
  const explicitPhase = typeof item.phase === "string" ? item.phase : null;
  if (hasExplicitPhase || !agentMessagePhaseByItemId.has(item.id)) {
    agentMessagePhaseByItemId.set(item.id, explicitPhase);
  }
  return agentMessagePhaseByItemId.get(item.id) || null;
};

const getTimestampMs = (value) => {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
};

const getItemLifecycleTiming = (itemId, phase, lifecycle) => {
  const explicitStartedAt = getTimestampMs(lifecycle?.startedAtMs);
  if (phase === "started" && !itemStartedAtMsByItemId.has(itemId)) {
    itemStartedAtMsByItemId.set(itemId, explicitStartedAt ?? Date.now());
  } else if (explicitStartedAt !== undefined) {
    itemStartedAtMsByItemId.set(itemId, explicitStartedAt);
  }

  const startedAt = itemStartedAtMsByItemId.get(itemId);
  const completedAt = phase === "completed"
    ? getTimestampMs(lifecycle?.completedAtMs) ?? Date.now()
    : undefined;
  return {
    timestamp: startedAt ?? completedAt ?? Date.now(),
    startedAt,
    completedAt,
  };
};

const normalizeSubagentStatus = (status, fallback = "running") => {
  switch (String(status || "")) {
    case "pendingInit":
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "completed":
    case "shutdown":
      return "completed";
    case "errored":
    case "notFound":
    case "error":
    case "failed":
      return "error";
    case "interrupted":
      return "interrupted";
    default:
      return fallback;
  }
};

const getSubagentLabel = (agentPath, threadId) => {
  const segment = String(agentPath || "").split(/[\\/]/).filter(Boolean).pop() || "";
  if (segment && segment !== "root") {
    const label = segment.replace(/[_-]+/g, " ").trim();
    return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : segment;
  }
  const shortId = String(threadId || "").slice(0, 8);
  return shortId ? `Agent ${shortId}` : "Sub-agent";
};

const rememberSubagentMetadata = (threadId, metadata) => {
  const id = String(threadId || "");
  if (!id) return;
  const previous = subagentMetadataByThreadId.get(id) || {};
  subagentMetadataByThreadId.set(id, {
    ...previous,
    ...(metadata.path ? { path: String(metadata.path) } : {}),
    ...(metadata.model ? { model: String(metadata.model) } : {}),
  });
};

const buildSubagent = (threadId, state, item, fallbackStatus = "running") => {
  const id = String(threadId || "");
  const metadata = subagentMetadataByThreadId.get(id) || {};
  const path = String(metadata.path || "");
  const model = String(item?.model || metadata.model || "");
  const message = typeof state?.message === "string" && state.message ? state.message : undefined;
  const status = normalizeSubagentStatus(state?.status, fallbackStatus);
  return {
    id,
    label: getSubagentLabel(path, id),
    status,
    ...(model ? { model } : {}),
    ...(path ? { path } : {}),
    ...(message ? { message } : {}),
  };
};

const getSubagentEventState = (subagents, fallback = "running") => {
  const statuses = subagents.map((subagent) => subagent.status);
  if (statuses.includes("error")) return "error";
  if (statuses.includes("interrupted")) return "interrupted";
  if (statuses.includes("running") || statuses.includes("pending")) return "running";
  if (statuses.length > 0 && statuses.every((status) => status === "completed")) return "completed";
  return fallback;
};

const getCollabEventTitle = (tool, state) => {
  if (state === "error") return "工作失败";
  if (state === "interrupted") return "已中断";
  switch (tool) {
    case "spawnAgent":
      return "已开始工作";
    case "sendInput":
      return "已更新";
    case "resumeAgent":
      return "已继续工作";
    case "closeAgent":
      return "已停止";
    case "wait":
      return state === "completed" ? "已完成" : "正在工作";
    default:
      return state === "completed" ? "已完成" : "正在工作";
  }
};

const emitCollabAgentItem = (item, phase, lifecycle) => {
  const tool = String(item.tool || "");
  const receiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.map((id) => String(id || "")).filter(Boolean)
    : [];
  const agentsStates = isRecord(item.agentsStates) ? item.agentsStates : {};
  const targetThreadIds = [...new Set([...receiverThreadIds, ...Object.keys(agentsStates)])];
  const timing = getItemLifecycleTiming(item.id, phase, lifecycle);
  if (targetThreadIds.length === 0) return;
  const fallbackStatus = item.status === "failed"
    ? "error"
    : tool === "closeAgent"
      ? "completed"
      : "running";
  const precedingActivityEventId = tool === "spawnAgent" && targetThreadIds.length === 1
    ? startedActivityEventIdByThreadId.get(targetThreadIds[0])
    : undefined;
  const displayEventId = tool === "spawnAgent" && targetThreadIds.length === 1
    ? precedingActivityEventId || item.id
    : item.id;

  for (const targetThreadId of targetThreadIds) {
    rememberSubagentMetadata(targetThreadId, { model: item.model });
    if (tool === "spawnAgent") spawnEventIdByThreadId.set(targetThreadId, displayEventId);
  }
  const subagents = targetThreadIds.map((targetThreadId) =>
    buildSubagent(targetThreadId, isRecord(agentsStates[targetThreadId]) ? agentsStates[targetThreadId] : null, item, fallbackStatus)
  );
  const fallbackEventState = item.status === "failed"
    ? "error"
    : tool === "closeAgent"
      ? "completed"
      : "running";
  const state = getSubagentEventState(subagents, fallbackEventState);
  send({
    type: "subagent_event",
    id: displayEventId,
    toolCallId: item.id,
    phase,
    action: tool || "collaboration",
    tool: tool || undefined,
    title: getCollabEventTitle(tool, state),
    detail: item.prompt ? truncate(item.prompt) : undefined,
    state,
    subagents,
    timestamp: timing.timestamp,
    startedAt: timing.startedAt,
    completedAt: timing.completedAt,
    senderThreadId: item.senderThreadId,
    receiverThreadIds,
    prompt: item.prompt,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    collabStatus: item.status,
  });
  if (tool === "spawnAgent" && phase === "completed") {
    for (const targetThreadId of targetThreadIds) {
      startedActivityEventIdByThreadId.delete(targetThreadId);
      if (precedingActivityEventId) spawnEventIdByThreadId.delete(targetThreadId);
    }
  }
};

const emitSubagentActivityItem = (item, phase, lifecycle) => {
  const agentThreadId = String(item.agentThreadId || "");
  const currentThreadId = String(activeThreadId || threadId || "");
  if (!agentThreadId || agentThreadId === currentThreadId) return;
  const activityKind = String(item.kind || "interacted");
  const status = activityKind === "started"
    ? "running"
    : activityKind === "interrupted"
      ? "interrupted"
      : "completed";
  rememberSubagentMetadata(agentThreadId, { path: item.agentPath });
  const subagent = buildSubagent(agentThreadId, { status }, null, status);
  const activityTiming = getItemLifecycleTiming(item.id, phase, lifecycle);
  let displayEventId = activityDisplayEventIdByItemId.get(item.id);
  if (!displayEventId && activityKind === "started") {
    displayEventId = spawnEventIdByThreadId.get(agentThreadId);
    if (displayEventId) activityDisplayEventIdByItemId.set(item.id, displayEventId);
    else startedActivityEventIdByThreadId.set(agentThreadId, item.id);
  }
  const eventId = displayEventId || item.id;
  const relatedStartedAt = displayEventId ? itemStartedAtMsByItemId.get(displayEventId) : undefined;
  send({
    type: "subagent_event",
    id: eventId,
    toolCallId: displayEventId || undefined,
    sourceActivityId: item.id,
    phase,
    action: activityKind,
    activityKind,
    title: activityKind === "started" ? "已开始工作" : activityKind === "interrupted" ? "已中断" : "已更新",
    state: status,
    subagents: [subagent],
    timestamp: relatedStartedAt ?? activityTiming.timestamp,
    startedAt: relatedStartedAt ?? activityTiming.startedAt,
    completedAt: displayEventId ? undefined : activityTiming.completedAt,
    activityTimestamp: activityTiming.timestamp,
    activityStartedAt: activityTiming.startedAt,
    activityCompletedAt: activityTiming.completedAt,
  });
  if (phase === "completed" && displayEventId) {
    activityDisplayEventIdByItemId.delete(item.id);
    spawnEventIdByThreadId.delete(agentThreadId);
  }
};

const handleItem = (item, phase, lifecycle) => {
  if (!promptRunning || abortRequested) return;
  if (!item?.id || !item?.type) return;
  if (phase === "completed" && completedItemIds.has(item.id)) return;

  switch (item.type) {
    case "agentMessage": {
      const text = String(item.text || "");
      const delta = getDelta(agentTextByItemId, item.id, text);
      const messagePhase = getAgentMessagePhase(item);
      if (messagePhase === "commentary") {
        if (delta) send({ type: "commentary_delta", itemId: item.id, delta });
        if (phase === "completed") send({ type: "commentary_end", itemId: item.id, content: text });
      } else {
        if (delta) send({ type: "stream_delta", delta });
        if (phase === "completed") finalResponse = text;
      }
      break;
    }
    case "plan": {
      const text = String(item.text || "");
      const delta = getDelta(agentTextByItemId, item.id, text);
      if (delta) send({ type: "stream_delta", delta });
      if (phase === "completed") finalResponse = text;
      break;
    }
    case "reasoning": {
      const text = [
        ...(Array.isArray(item.summary) ? item.summary : []),
        ...(Array.isArray(item.content) ? item.content : []),
      ].join("\n");
      const delta = getDelta(reasoningTextByItemId, item.id, text);
      if (delta) send({ type: "thinking_delta", delta });
      if (phase === "completed") send({ type: "thinking_end" });
      break;
    }
    case "commandExecution":
      emitCommandItem(item, phase);
      break;
    case "fileChange":
      emitFileChangeItem(item, phase);
      break;
    case "mcpToolCall":
    case "dynamicToolCall":
      emitMcpToolItem(item, phase);
      break;
    case "webSearch":
      emitWebSearchItem(item, phase);
      break;
    case "sleep":
      send({
        type: "process_event",
        entryType: "status",
        title: "Codex is waiting",
        detail: `${item.durationMs || 0}ms`,
        state: phase === "completed" ? "completed" : "running",
      });
      break;
    case "contextCompaction":
      if (!contextCompactionEmitted) {
        contextCompactionEmitted = true;
        send({
          type: "context_compaction",
          id: item.id,
        });
      }
      break;
    case "collabAgentToolCall":
      emitCollabAgentItem(item, phase, lifecycle);
      break;
    case "subAgentActivity":
      emitSubagentActivityItem(item, phase, lifecycle);
      break;
    case "imageView":
      send({
        type: phase === "completed" ? "tool_end" : "tool_start",
        toolName: "view_image",
        toolCallId: item.id,
        toolKind: "read_file",
        args: { path: item.path },
        result: phase === "completed" ? { path: item.path } : undefined,
        detail: item.path,
        isError: false,
      });
      break;
    case "imageGeneration":
      send({
        type: phase === "completed" ? "tool_end" : "tool_start",
        toolName: "image_generation",
        toolCallId: item.id,
        toolKind: "unknown",
        args: { revisedPrompt: item.revisedPrompt },
        result: phase === "completed" ? { result: item.result, savedPath: item.savedPath, status: item.status } : undefined,
        detail: item.savedPath || item.result,
        isError: item.status === "failed",
      });
      break;
  }

  if (phase === "completed") completedItemIds.add(item.id);
};

const handleTurnStarted = (params) => {
  if (shouldIgnoreTurnNotification(params)) return;
  activeTurnId = params.turn?.id || params.turnId || activeTurnId;
  activeThreadId = params.threadId || activeThreadId;
  sendTurnMetadata(activeTurnId);
  if (abortRequested) {
    void interruptTurn(activeTurnId);
    return;
  }
  if (!promptRunning) return;
  startStream();
  send({
    type: "process_event",
    entryType: "status",
    title: "Codex is processing",
    state: "running",
  });
};

const handleTurnCompleted = (params) => {
  if (shouldIgnoreTurnNotification(params)) return;
  if (!promptRunning || abortRequested) return;
  const turn = params.turn || {};
  sendTurnMetadata(turn.id || params.turnId || activeTurnId);
  if (Array.isArray(turn.items)) {
    for (const item of turn.items) handleItem(item, "completed");
  }
  const isActiveTurn = !activeTurnId || !turn.id || activeTurnId === turn.id;
  if (!isActiveTurn) return;
  send({
    type: "process_event",
    entryType: turn.status === "failed" ? "error" : "status",
    title: turn.status === "failed" ? "Codex turn failed" : "Codex completed",
    detail: turn.error ? stringifyValue(turn.error) : undefined,
    state: turn.status === "failed" ? "error" : "completed",
  });
  finishPrompt();
};

const handleServerNotification = (method, params) => {
  switch (method) {
    case "thread/started":
      if (forkRequestActive) break;
      threadId = params.thread?.id || params.threadId || threadId;
      activeThreadId = threadId;
      if (threadId) send({ type: "session_file_path", sessionFilePath: threadId, threadId });
      break;
    case "turn/started":
      if (steerResponsePending) {
        steerResponsePending = false;
        send({ type: "guidance_delivered" });
      }
      handleTurnStarted(params);
      break;
    case "turn/completed":
      handleTurnCompleted(params);
      break;
    case "turn/plan/updated":
      if (!promptRunning || abortRequested) return;
      if (Array.isArray(params.plan)) {
        send({
          type: "plan_update",
          steps: params.plan
            .map((step, index) => ({
              id: String(step.id || step.stepId || `codex-plan-${index}`),
              title: String(
                step.step ||
                step.text ||
                step.title ||
                step.description ||
                `Task ${index + 1}: description unavailable`
              ),
              status: step.status || step.state || "pending",
            }))
            .filter((step) => step.title.trim()),
        });
      }
      break;
    case "item/started":
      // A steered turn keeps streaming the same turn; the first new item
      // after turn/steer is the first output that answers the guidance.
      // Emit before handleItem so the guidance bubble precedes the item.
      if (steerResponsePending) {
        steerResponsePending = false;
        send({ type: "guidance_delivered" });
      }
      if (!promptRunning || abortRequested) return;
      handleItem(params.item, "started", params);
      break;
    case "item/completed":
      if (!promptRunning || abortRequested) return;
      handleItem(params.item, "completed", params);
      break;
    case "item/agentMessage/delta":
      if (!promptRunning || abortRequested) return;
      startStream();
      if (params.itemId) {
        const nextText = `${agentTextByItemId.get(params.itemId) || ""}${params.delta || ""}`;
        agentTextByItemId.set(params.itemId, nextText);
      }
      if (params.delta) {
        const messagePhase = agentMessagePhaseByItemId.get(params.itemId) || null;
        send(messagePhase === "commentary"
          ? { type: "commentary_delta", itemId: params.itemId, delta: params.delta }
          : { type: "stream_delta", delta: params.delta });
      }
      break;
    case "item/plan/delta":
      if (!promptRunning || abortRequested) return;
      startStream();
      if (params.itemId) {
        const nextText = `${agentTextByItemId.get(params.itemId) || ""}${params.delta || ""}`;
        agentTextByItemId.set(params.itemId, nextText);
      }
      if (params.delta) send({ type: "stream_delta", delta: params.delta });
      break;
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      if (!promptRunning || abortRequested) return;
      startStream();
      if (params.itemId) {
        const nextText = `${reasoningTextByItemId.get(params.itemId) || ""}${params.delta || ""}`;
        reasoningTextByItemId.set(params.itemId, nextText);
      }
      if (params.delta) send({ type: "thinking_delta", delta: params.delta });
      break;
    case "item/reasoning/summaryPartAdded":
      if (!promptRunning || abortRequested) return;
      startStream();
      if (params.text) send({ type: "thinking_delta", delta: params.text });
      break;
    case "item/commandExecution/outputDelta":
    case "command/exec/outputDelta":
      if (!promptRunning || abortRequested) return;
      if (params.itemId) {
        commandOutputByItemId.set(params.itemId, `${commandOutputByItemId.get(params.itemId) || ""}${params.delta || ""}`);
      }
      break;
    case "item/fileChange/patchUpdated":
      if (!promptRunning || abortRequested) return;
      if (Array.isArray(params.changes)) {
        send({
          type: "diff_update",
          diffs: getFilesFromChanges(params.changes).map((file) => ({
            file: file.file,
            patch: file.patch || "",
            additions: file.additions || 0,
            deletions: file.deletions || 0,
            status: file.status,
          })),
        });
      }
      break;
    case "thread/compacted": {
      const compactionId = `${params.threadId || threadId || "thread"}:${params.turnId || "turn"}`;
      if (!contextCompactionEmitted) {
        contextCompactionEmitted = true;
        send({ type: "context_compaction", id: compactionId });
      }
      break;
    }
    case "warning":
    case "guardianWarning":
    case "deprecationNotice":
    case "configWarning":
      send({
        type: "process_event",
        entryType: "status",
        title: String(params.message || "Codex warning"),
        detail: params.details || params.help,
        state: "completed",
      });
      break;
    case "thread/closed":
      if (params.threadId && params.threadId === threadId) {
        threadId = null;
        activeThreadId = null;
        send({ type: "agent_disconnected" });
      }
      break;
    case "error":
      if (!promptRunning || abortRequested) return;
      if (isRetryingCodexError(params)) {
        send({
          type: "process_event",
          id: CODEX_RECONNECT_ENTRY_ID,
          entryType: "status",
          title: getCodexReconnectTitle(params),
          state: "running",
        });
        break;
      }
      send({
        type: "process_event",
        entryType: "error",
        title: "Codex error",
        detail: getCodexFinalErrorDetail(params),
        state: "error",
      });
      pendingUIRequest = null;
      abortRequested = false;
      finishPrompt();
      break;
  }
};

const finishPrompt = () => {
  if (!promptRunning || pendingUIRequest || abortRequested) return;
  const promptId = activePromptId;
  send({ type: "stream_end", content: finalResponse, force: true });
  send({ type: "agent_end" });
  send({ type: "prompt_done", id: promptId });
  promptRunning = false;
  activePromptId = null;
  activePlanModeEnabled = false;
  activePermissionMode = "auto";
  activeTurnId = null;
  void cleanupActiveImages();
};

const runPrompt = async (command) => {
  if (promptRunning) throw new Error("Codex is already running");

  promptRunning = true;
  aborting = false;
  abortRequested = false;
  abortedPromptId = null;
  activePromptId = command.id;
  activePlanModeEnabled = !!command.planModeEnabled;
  if (typeof command.hostSystemPrompt === "string") {
    activeHostSystemPrompt = command.hostSystemPrompt.trim();
  }
  activePermissionMode = ["ask", "auto", "full-access"].includes(command.permissionMode)
    ? command.permissionMode
    : "auto";
  resetTurnState();
  send({ type: "accepted", id: command.id });
  startStream();

  try {
    await cleanupActiveImages();
    const imagePayload = await materializeImages(command.images);
    registerActiveImageCleanup(imagePayload.cleanup);
    const actionInput = await resolveActionInput(command.action);
    await startAppServer();
    if (activeHostSystemPrompt) await refreshConfiguredDeveloperInstructions();
    const nextThreadId = await ensureThread();
    if (!promptRunning || activePromptId !== command.id) return;
    const result = await rpcRequest("turn/start", {
      threadId: nextThreadId,
      clientUserMessageId: command.id,
      input: buildInput(command.message, imagePayload.entries, actionInput),
      cwd: projectPath,
      approvalPolicy: activePermissionMode === "full-access" ? "never" : "on-request",
      sandboxPolicy: activePermissionMode === "ask"
        ? { type: "readOnly", networkAccess: false }
        : activePermissionMode === "full-access"
          ? { type: "dangerFullAccess" }
          : {
              type: "workspaceWrite",
              writableRoots: [projectPath],
              networkAccess: false,
            },
      model: getRequestModelId(),
      effort: normalizeReasoningEffort(thinkingLevel),
      collaborationMode: buildTurnCollaborationMode(),
    });
    if (abortRequested) {
      const startedTurnId = result?.turn?.id || result?.turnId || activeTurnId;
      if (startedTurnId) {
        ignoredTurnIds.add(startedTurnId);
        void interruptTurn(startedTurnId);
      }
      return;
    }
    if (!promptRunning || activePromptId !== command.id) return;
    activeTurnId = result?.turn?.id || result?.turnId || activeTurnId;
    sendTurnMetadata(activeTurnId);
  } catch (error) {
    if (!aborting && !abortRequested && promptRunning && activePromptId === command.id) {
      send({
        type: "process_event",
        entryType: "error",
        title: "Codex request failed",
        detail: error?.message || String(error),
        state: "error",
      });
      finishPrompt();
    }
  }
};

const waitForActiveTurn = async (timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (promptRunning && !activeTurnId && Date.now() < deadline) {
    await sleep(100);
  }
  return activeTurnId;
};

const runGuidance = async (command) => {
  if (!promptRunning || abortRequested) {
    throw new Error("Codex has no active turn to guide");
  }

  if (typeof command.hostSystemPrompt === "string") {
    activeHostSystemPrompt = command.hostSystemPrompt.trim();
  }

  const turnId = await waitForActiveTurn();
  const currentThreadId = activeThreadId || threadId;
  if (!promptRunning || abortRequested || !turnId || !currentThreadId) {
    throw new Error("Codex has no active turn to guide");
  }

  const imagePayload = await materializeImages(command.images);
  let cleanupRegistered = false;
  try {
    if (!promptRunning || abortRequested) return;
    const result = await rpcRequest("turn/steer", {
      threadId: currentThreadId,
      clientUserMessageId: command.id,
      input: buildInput(command.message, imagePayload.entries),
      expectedTurnId: turnId,
      collaborationMode: buildTurnCollaborationMode(),
    }, 25000);
    registerActiveImageCleanup(imagePayload.cleanup);
    cleanupRegistered = true;
    if (!promptRunning || abortRequested) return;
    activeTurnId = result?.turnId || activeTurnId;
    sendTurnMetadata(activeTurnId);
    send({ type: "guidance_done", id: command.id });
    steerResponsePending = true;
  } finally {
    if (!cleanupRegistered) await imagePayload.cleanup();
  }
};

const abortPrompt = async (command) => {
  if (abortRequested) {
    send({ type: "aborted", id: command.id, promptId: abortedPromptId });
    return;
  }
  aborting = true;
  abortRequested = true;
  abortedPromptId = activePromptId;
  if (abortedPromptId) interruptedPromptIds.add(abortedPromptId);
  const turnId = activeTurnId;
  const pendingRequestRpcId = pendingUIRequest?.rpcId;
  pendingUIRequest = null;

  if (pendingRequestRpcId) rpcReject(pendingRequestRpcId, "Turn was interrupted");
  if (turnId) void interruptTurn(turnId, 5000);

  send({
    type: "process_event",
    entryType: "status",
    title: "Codex interrupted",
    state: "interrupted",
  });
  send({ type: "stream_end", content: finalResponse, force: true });
  send({ type: "agent_end" });
  send({ type: "prompt_done", id: abortedPromptId });
  send({ type: "aborted", id: command.id, promptId: abortedPromptId });
  promptRunning = false;
  activePromptId = null;
  activePlanModeEnabled = false;
  activePermissionMode = "auto";
  activeTurnId = null;
  aborting = false;
  await cleanupActiveImages();
};

const init = async ({ projectPath: cwd, sessionFilePath, hostSystemPrompt }) => {
  await disposeSession();
  activeHostSystemPrompt = String(hostSystemPrompt || "").trim();
  projectPath = cwd;
  threadId = sessionFilePath || null;
  activeThreadId = threadId;
  await startAppServer();
  send({ type: "ready", sessionFilePath: threadId });
};

const disposeSession = async () => {
  promptRunning = false;
  aborting = true;
  activePromptId = null;
  activeTurnId = null;
  activeThreadId = null;
  activePlanModeEnabled = false;
  activeHostSystemPrompt = "";
  configuredDeveloperInstructions = "";
  configuredDeveloperInstructionsLoaded = false;
  activePermissionMode = "auto";
  pendingUIRequest = null;
  resetTurnState();
  await cleanupActiveImages();
  failPendingRpc(new Error("Codex worker disposed"));
  if (appServer) {
    const child = appServer;
    appServer = null;
    appServerReady = null;
    try {
      child.stdin?.end();
    } catch {}
    if (!(await waitForProcessExit(child, 1500))) {
      try { killProcessTree(child); } catch {}
      await waitForProcessExit(child, 500);
    }
  }
  aborting = false;
};

const shutdownWorker = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await disposeSession();
  } finally {
    process.exit(0);
  }
};

const handleCommand = async (command) => {
  try {
    switch (command.type) {
      case "init":
        await init(command);
        break;
      case "prompt":
        await runPrompt(command);
        break;
      case "guidance":
        await runGuidance(command);
        break;
      case "forkSession": {
        const result = await forkCodexSession(command);
        send({ type: "fork_session_result", id: command.id, ...result });
        break;
      }
      case "abort":
        await abortPrompt(command);
        break;
      case "getModels":
        send({ type: "models", id: command.id, models: await getModels() });
        break;
      case "listActions":
        send({ type: "actions", id: command.id, actions: await getActions(command.reload === true) });
        break;
      case "setModel":
        currentModelId =
          command.modelId !== DEFAULT_MODEL_ID
            ? command.modelId
            : null;
        send({ type: "model_changed", id: command.id, model: { id: command.modelId, provider: command.provider } });
        break;
      case "setThinkingLevel":
        thinkingLevel = String(command.level || "medium");
        send({ type: "thinking_level_changed", id: command.id, level: thinkingLevel });
        break;
      case "uiResponse":
        runUIResponse(command.response);
        send({ type: "ui_response_done", id: command.id });
        break;
      case "dispose":
        await shutdownWorker();
        break;
    }
  } catch (error) {
    send({ type: "error", id: command.id, error: error?.message || String(error) });
  }
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    void handleCommand(JSON.parse(line));
  } catch (error) {
    send({ type: "error", error: error?.message || String(error) });
  }
});

rl.on("close", () => {
  void shutdownWorker();
});

process.on("SIGINT", () => {
  void shutdownWorker();
});

process.on("SIGTERM", () => {
  void shutdownWorker();
});

process.on("uncaughtException", (error) => {
  send({ type: "error", error: error?.message || String(error) });
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});

process.on("unhandledRejection", (error) => {
  send({ type: "error", error: error?.message || String(error) });
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});
