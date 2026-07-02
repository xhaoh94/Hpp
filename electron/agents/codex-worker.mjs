import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const DEFAULT_MODEL_ID = "default";
const CODEX_PROVIDER = "codex";
const CODEX_MODELS = [
  { id: "gpt-5.5", name: "GPT-5.5", provider: CODEX_PROVIDER, reasoning: true },
  { id: "gpt-5.4", name: "GPT-5.4", provider: CODEX_PROVIDER, reasoning: true },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", provider: CODEX_PROVIDER, reasoning: true },
];
const VALID_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const PLAN_MODE_INSTRUCTIONS = [
  "<plan_mode>",
  "Plan mode is enabled for this turn.",
  "Do not modify files, apply patches, run write commands, or otherwise change workspace state.",
  "You may inspect context that is necessary to make the plan.",
  "Respond with a concise implementation plan and wait for the user to explicitly confirm before implementation.",
  "</plan_mode>",
].join("\n");

const PLATFORM_PACKAGE_BY_TARGET = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

let projectPath = "";
let threadId = null;
let appServer = null;
let appServerReady = null;
let nextRpcId = 0;
let pendingRpc = new Map();
let currentModelId = null;
let thinkingLevel = "medium";
let activePlanModeEnabled = false;
let activePermissionMode = "full-access";
let activePromptId = null;
let activeTurnId = null;
let activeThreadId = null;
let promptRunning = false;
let aborting = false;
let streamStarted = false;
let finalResponse = "";
let commandOutputByItemId = new Map();
let reasoningTextByItemId = new Map();
let agentTextByItemId = new Map();
let completedItemIds = new Set();
let emittedContextCompactionIds = new Set();
let pendingUIRequest = null;
let activeImageCleanup = null;

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

const truncate = (value, maxLength = 1200) => {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
};

const normalizeReasoningEffort = (level) => {
  const normalized = String(level || "").trim();
  return VALID_REASONING_EFFORTS.has(normalized) ? normalized : undefined;
};

const getModels = () => CODEX_MODELS;

const existingDirs = (...dirs) => dirs.filter((dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
});

const resolveCodexExecutable = () => {
  if (process.env.CODEX_PATH && existsSync(process.env.CODEX_PATH)) {
    return { executablePath: process.env.CODEX_PATH, pathDirs: [] };
  }

  const moduleRequire = createRequire(import.meta.url);
  const { platform, arch } = process;
  let targetTriple = null;
  if (platform === "linux" || platform === "android") {
    if (arch === "x64") targetTriple = "x86_64-unknown-linux-musl";
    if (arch === "arm64") targetTriple = "aarch64-unknown-linux-musl";
  } else if (platform === "darwin") {
    if (arch === "x64") targetTriple = "x86_64-apple-darwin";
    if (arch === "arm64") targetTriple = "aarch64-apple-darwin";
  } else if (platform === "win32") {
    if (arch === "x64") targetTriple = "x86_64-pc-windows-msvc";
    if (arch === "arm64") targetTriple = "aarch64-pc-windows-msvc";
  }

  if (!targetTriple || !PLATFORM_PACKAGE_BY_TARGET[targetTriple]) {
    throw new Error(`Unsupported platform for Codex CLI: ${platform}/${arch}`);
  }

  const codexPackageJsonPath = moduleRequire.resolve("@openai/codex/package.json");
  const codexRequire = createRequire(codexPackageJsonPath);
  const platformPackageJsonPath = codexRequire.resolve(`${PLATFORM_PACKAGE_BY_TARGET[targetTriple]}/package.json`);
  const vendorRoot = join(dirname(platformPackageJsonPath), "vendor");
  const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const packageRoot = join(vendorRoot, targetTriple);
  const executablePath = join(packageRoot, "bin", codexBinaryName);
  if (existsSync(executablePath)) {
    return {
      executablePath,
      pathDirs: existingDirs(join(packageRoot, "codex-path")),
    };
  }

  const legacyPath = join(packageRoot, "codex", codexBinaryName);
  if (existsSync(legacyPath)) {
    return {
      executablePath: legacyPath,
      pathDirs: existingDirs(join(packageRoot, "path")),
    };
  }

  throw new Error("Unable to locate Codex CLI binary. Ensure @openai/codex is installed.");
};

const pathEnvKey = (env, platform = process.platform) => {
  if (platform !== "win32") return "PATH";
  const matchingKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  return matchingKeys.includes("Path") ? "Path" : matchingKeys.at(-1) ?? "PATH";
};

const prependPathDirs = (env, pathDirs) => {
  if (!pathDirs.length) return;
  const key = pathEnvKey(env);
  if (process.platform === "win32") {
    for (const envKey of Object.keys(env)) {
      if (envKey.toLowerCase() === "path" && envKey !== key) delete env[envKey];
    }
  }
  const existing = String(env[key] || "").split(process.platform === "win32" ? ";" : ":").filter((item) => item && !pathDirs.includes(item));
  env[key] = [...pathDirs, ...existing].join(process.platform === "win32" ? ";" : ":");
};

const startAppServer = async () => {
  if (appServerReady) return appServerReady;

  appServerReady = new Promise((resolve, reject) => {
    let settled = false;
    const { executablePath, pathDirs } = resolveCodexExecutable();
    const env = { ...process.env };
    prependPathDirs(env, pathDirs);
    if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
      env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "codex_sdk_ts";
    }

    const child = spawn(executablePath, ["app-server", "--stdio"], {
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
      const text = chunk.toString().trim();
      if (text) send({ type: "process_event", entryType: "status", title: "Codex app-server", detail: text, state: "running" });
    });

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
      failPendingRpc(error);
    });

    child.on("exit", (code, signal) => {
      appServer = null;
      appServerReady = null;
      const error = new Error(`Codex app-server exited with ${signal || code}`);
      failPendingRpc(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
      if (!aborting) send({ type: "agent_disconnected" });
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

const writeRpc = (message) => {
  if (!appServer?.stdin?.writable) throw new Error("Codex app-server is not running");
  appServer.stdin.write(`${JSON.stringify(message)}\n`);
};

const rpcRequest = (method, params, timeoutMs = 120000) => {
  const id = ++nextRpcId;
  writeRpc({ id, method, params });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRpc.delete(id);
      reject(new Error(`Codex app-server request timed out: ${method}`));
    }, timeoutMs);
    pendingRpc.set(id, { method, resolve, reject, timeout });
  });
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
  const cleanup = activeImageCleanup;
  activeImageCleanup = null;
  if (cleanup) {
    await cleanup();
  }
};

const buildInput = (message, images) => {
  const text = activePlanModeEnabled ? `${PLAN_MODE_INSTRUCTIONS}\n\n${message || ""}` : (message || "");
  const input = [{ type: "text", text: text || "Please continue.", text_elements: [] }];
  return [...input, ...images];
};

const buildThreadParams = () => {
  const planAccessEnabled = activePermissionMode === "plan";
  const fullAccessEnabled = activePermissionMode === "full-access";
  const params = {
    cwd: projectPath,
    sandbox: planAccessEnabled ? "read-only" : fullAccessEnabled ? "danger-full-access" : undefined,
    approvalPolicy: planAccessEnabled || fullAccessEnabled ? "never" : undefined,
    config: activePlanModeEnabled
      ? {
          collaboration_mode: "Plan",
          include_collaboration_mode_instructions: true,
        }
      : undefined,
    serviceName: "HPP",
    threadSource: "hpp",
  };

  const effort = normalizeReasoningEffort(thinkingLevel);
  if (effort) params.config = { ...(params.config || {}), model_reasoning_effort: effort };
  if (currentModelId && currentModelId !== DEFAULT_MODEL_ID) params.model = currentModelId;
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
};

const ensureThread = async () => {
  await startAppServer();
  if (threadId) {
    const result = await rpcRequest("thread/resume", {
      threadId,
      ...buildThreadParams(),
    });
    threadId = result?.thread?.id || threadId;
    activeThreadId = threadId;
    send({ type: "session_file_path", sessionFilePath: threadId, threadId });
    return threadId;
  }

  const result = await rpcRequest("thread/start", buildThreadParams());
  threadId = result?.thread?.id;
  activeThreadId = threadId;
  if (!threadId) throw new Error("Codex app-server did not return a thread id");
  send({ type: "session_file_path", sessionFilePath: threadId, threadId });
  return threadId;
};

const startStream = () => {
  if (streamStarted) return;
  streamStarted = true;
  send({ type: "agent_start" });
  send({ type: "stream_start", role: "assistant" });
};

const resetTurnState = () => {
  streamStarted = false;
  finalResponse = "";
  activeTurnId = null;
  commandOutputByItemId = new Map();
  reasoningTextByItemId = new Map();
  agentTextByItemId = new Map();
  completedItemIds = new Set();
  emittedContextCompactionIds = new Set();
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
      rpcRespond(message.id, { permissions: {}, scope: "turn" });
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
    method: message.method,
    title: requestText,
    questions: pendingUIRequest.questions,
    prompt: requestText,
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
  const decision = String(answer).toLowerCase() === "accept"
    ? pendingUIRequest?.approval?.acceptDecision
    : pendingUIRequest?.approval?.declineDecision;
  return { decision: decision || "decline" };
};

const runUIResponse = (response) => {
  if (!pendingUIRequest || response?.id !== pendingUIRequest.id) {
    send({ type: "ui_response_ignored", id: response?.id });
    return;
  }

  const rpcId = pendingUIRequest.rpcId;
  let result;
  if (response?.cancelled) {
    if (pendingUIRequest.approval) {
      result = { decision: pendingUIRequest.approval.declineDecision };
    } else if (pendingUIRequest.mcpElicitation) {
      result = { action: "cancel", content: null, _meta: null };
    } else {
      result = { answers: {} };
    }
  } else if (pendingUIRequest.approval) {
    result = responseToApproval(response);
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
    isError: item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0),
  });
};

const getFilesFromChanges = (changes) => {
  if (!Array.isArray(changes)) return [];
  return changes
    .map((change) => {
      const filePath = change?.path || change?.file || change?.filePath;
      if (!filePath) return null;
      const kind = change?.kind || change?.type || change?.status;
      return {
        file: filePath,
        label: basename(filePath),
        action: kind === "add" ? "written" : "edited",
        status: kind === "add" ? "added" : kind === "delete" ? "deleted" : "modified",
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

const handleItem = (item, phase) => {
  if (!item?.id || !item?.type) return;
  if (phase === "completed" && completedItemIds.has(item.id)) return;

  switch (item.type) {
    case "agentMessage": {
      const text = String(item.text || "");
      const delta = getDelta(agentTextByItemId, item.id, text);
      if (delta) send({ type: "stream_delta", delta });
      if (phase === "completed") finalResponse = text;
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
      if (!emittedContextCompactionIds.has(item.id)) {
        emittedContextCompactionIds.add(item.id);
        send({
          type: "context_compaction",
          id: item.id,
        });
      }
      break;
  }

  if (phase === "completed") completedItemIds.add(item.id);
};

const handleTurnStarted = (params) => {
  activeTurnId = params.turn?.id || activeTurnId;
  activeThreadId = params.threadId || activeThreadId;
  startStream();
  send({
    type: "process_event",
    entryType: "status",
    title: "Codex is processing",
    state: "running",
  });
};

const handleTurnCompleted = (params) => {
  const turn = params.turn || {};
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
      threadId = params.thread?.id || params.threadId || threadId;
      activeThreadId = threadId;
      if (threadId) send({ type: "session_file_path", sessionFilePath: threadId, threadId });
      break;
    case "turn/started":
      handleTurnStarted(params);
      break;
    case "turn/completed":
      handleTurnCompleted(params);
      break;
    case "turn/plan/updated":
      if (Array.isArray(params.plan)) {
        send({
          type: "process_event",
          entryType: "status",
          title: "Codex plan updated",
          detail: params.plan.map((step) => `${step.status || "-"} ${step.text || ""}`).join("\n"),
          state: "running",
        });
      }
      break;
    case "item/started":
      handleItem(params.item, "started");
      break;
    case "item/completed":
      handleItem(params.item, "completed");
      break;
    case "item/agentMessage/delta":
      startStream();
      if (params.itemId) {
        const nextText = `${agentTextByItemId.get(params.itemId) || ""}${params.delta || ""}`;
        agentTextByItemId.set(params.itemId, nextText);
      }
      if (params.delta) send({ type: "stream_delta", delta: params.delta });
      break;
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      startStream();
      if (params.itemId) {
        const nextText = `${reasoningTextByItemId.get(params.itemId) || ""}${params.delta || ""}`;
        reasoningTextByItemId.set(params.itemId, nextText);
      }
      if (params.delta) send({ type: "thinking_delta", delta: params.delta });
      break;
    case "item/reasoning/summaryPartAdded":
      startStream();
      if (params.text) send({ type: "thinking_delta", delta: params.text });
      break;
    case "item/commandExecution/outputDelta":
    case "command/exec/outputDelta":
      if (params.itemId) {
        commandOutputByItemId.set(params.itemId, `${commandOutputByItemId.get(params.itemId) || ""}${params.delta || ""}`);
      }
      break;
    case "item/fileChange/patchUpdated":
      if (Array.isArray(params.changes)) {
        send({ type: "diff_update", diffs: getFilesFromChanges(params.changes).map((file) => ({ file: file.file, patch: "", additions: 0, deletions: 0, status: file.status })) });
      }
      break;
    case "error":
      send({
        type: "process_event",
        entryType: "error",
        title: "Codex error",
        detail: params.message || stringifyValue(params),
        state: "error",
      });
      break;
  }
};

const finishPrompt = () => {
  if (!promptRunning || pendingUIRequest) return;
  const promptId = activePromptId;
  send({ type: "stream_end", content: finalResponse, force: true });
  send({ type: "agent_end" });
  send({ type: "prompt_done", id: promptId });
  promptRunning = false;
  activePromptId = null;
  activePlanModeEnabled = false;
  activePermissionMode = "full-access";
  activeTurnId = null;
  void cleanupActiveImages();
};

const runPrompt = async (command) => {
  if (promptRunning) throw new Error("Codex is already running");

  promptRunning = true;
  aborting = false;
  activePromptId = command.id;
  activePlanModeEnabled = !!command.planModeEnabled;
  activePermissionMode = command.permissionMode === "plan" ? "plan" : "full-access";
  resetTurnState();
  send({ type: "accepted", id: command.id });
  startStream();

  await cleanupActiveImages();
  const imagePayload = await materializeImages(command.images);
  activeImageCleanup = imagePayload.cleanup;
  try {
    const nextThreadId = await ensureThread();
    if (!promptRunning || activePromptId !== command.id) return;
    const result = await rpcRequest("turn/start", {
      threadId: nextThreadId,
      clientUserMessageId: command.id,
      input: buildInput(command.message, imagePayload.entries),
      cwd: projectPath,
      approvalPolicy: "never",
      sandboxPolicy: activePermissionMode === "plan"
        ? { type: "readOnly", networkAccess: false }
        : activePermissionMode === "full-access"
          ? { type: "dangerFullAccess" }
          : undefined,
      model: currentModelId && currentModelId !== DEFAULT_MODEL_ID ? currentModelId : undefined,
      effort: normalizeReasoningEffort(thinkingLevel),
    });
    if (!promptRunning || activePromptId !== command.id) return;
    activeTurnId = result?.turn?.id || activeTurnId;
  } catch (error) {
    if (!aborting && promptRunning && activePromptId === command.id) {
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

const abortPrompt = async (command) => {
  aborting = true;
  const abortedPromptId = activePromptId;
  const turnId = activeTurnId;
  pendingUIRequest = null;

  try {
    if (turnId) {
      await rpcRequest("turn/interrupt", { threadId: activeThreadId || threadId, turnId }, 5000);
    }
  } catch {
    // The turn may already have completed.
  }

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
  activePermissionMode = "full-access";
  activeTurnId = null;
  aborting = false;
  await cleanupActiveImages();
};

const init = async ({ projectPath: cwd, sessionFilePath }) => {
  await disposeSession();
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
  activePermissionMode = "full-access";
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
      setTimeout(() => {
        try {
          if (!child.killed) child.kill();
        } catch {}
      }, 500);
    } catch {}
  }
  aborting = false;
};

const handleCommand = async (command) => {
  try {
    switch (command.type) {
      case "init":
        await init(command);
        break;
      case "prompt":
        void runPrompt(command);
        break;
      case "abort":
        await abortPrompt(command);
        break;
      case "getModels":
        send({ type: "models", id: command.id, models: getModels() });
        break;
      case "setModel":
        currentModelId =
          command.provider === CODEX_PROVIDER && command.modelId !== DEFAULT_MODEL_ID
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
        break;
      case "dispose":
        await disposeSession();
        process.exit(0);
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

process.on("uncaughtException", (error) => {
  send({ type: "error", error: error?.message || String(error) });
});

process.on("unhandledRejection", (error) => {
  send({ type: "error", error: error?.message || String(error) });
});
