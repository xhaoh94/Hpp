import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startOpenAIChatAdapter } from "./openai-anthropic-adapter.mjs";

const SDK_THINKING_LEVELS = new Set(["off", "low", "medium", "high", "xhigh"]);
const FORK_DESCRIPTOR_PREFIX = "hpp-claude-fork:v1:";

let sdk;
let projectPath = "";
let sessionFilePath = "";
let actualSessionId = "";
let isNewSession = true;
let deferredFork = null;
let activeProvider = null;
let currentModelId = "";
let thinkingLevel = "medium";
let permissionMode = "full-access";
let activeQuery = null;
let activeQueryPermissionMode = null;
let queryGeneration = 0;
let inputQueue = null;
let activePromptId = null;
let pendingPermissions = new Map();
let toolUses = new Map();
let streamBlockTypes = new Map();
let streamBlockToolIds = new Map();
let activeAdapter = null;
let activeAdapterKey = "";
let actionNames = new Set();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const asRecord = (value) => isRecord(value) ? value : {};
const stringValue = (value) => typeof value === "string" ? value : "";
const redact = (value) => {
  const secret = activeProvider?.apiKey;
  return secret ? String(value || "").split(secret).join("[REDACTED]") : String(value || "");
};

class PushableInput {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }

  push(value) {
    if (this.closed) throw new Error("Claude SDK input is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() { return this; }

  next() {
    if (this.values.length > 0) return Promise.resolve({ value: this.values.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolveNext) => this.waiters.push(resolveNext));
  }
}

const getNativePackageName = () => {
  if (!(["x64", "arm64"].includes(process.arch))) return undefined;
  if (process.platform === "win32") return `claude-agent-sdk-win32-${process.arch}`;
  if (process.platform === "darwin") return `claude-agent-sdk-darwin-${process.arch}`;
  if (process.platform === "linux") {
    let musl = false;
    try { musl = !process.report?.getReport?.().header?.glibcVersionRuntime; } catch { /* use glibc default */ }
    return `claude-agent-sdk-linux-${process.arch}${musl ? "-musl" : ""}`;
  }
  return undefined;
};

const loadSDK = async () => {
  const packageRoot = String(process.env.CLAUDE_AGENT_SDK_PACKAGE_ROOT || "").trim();
  if (!packageRoot) throw new Error("Claude Agent SDK 未安装，请先在 Hpp Agent 设置中安装 Claude Code");
  const packageDir = join(packageRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  try {
    const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    if (packageJson.version !== "0.3.215") {
      throw new Error(`需要 0.3.215，当前为 ${packageJson.version || "未知"}`);
    }
    const nativePackageName = getNativePackageName();
    if (!nativePackageName) throw new Error(`不支持当前平台：${process.platform}-${process.arch}`);
    const nativePackageDir = join(packageRoot, "node_modules", "@anthropic-ai", nativePackageName);
    const nativePackageJson = JSON.parse(readFileSync(join(nativePackageDir, "package.json"), "utf8"));
    const nativeExecutable = join(nativePackageDir, process.platform === "win32" ? "claude.exe" : "claude");
    if (nativePackageJson.version !== "0.3.215" || !existsSync(nativeExecutable)) {
      throw new Error("当前平台的 Claude Code 原生运行组件不完整");
    }
    const rootExport = packageJson.exports?.["."];
    const entry = typeof rootExport === "string" ? rootExport : rootExport?.import || packageJson.module || packageJson.main;
    if (!entry) throw new Error("package.json does not define an ESM entry");
    const entryPath = resolve(packageDir, entry);
    if (!entryPath.startsWith(resolve(packageDir)) || !existsSync(entryPath)) throw new Error("SDK entry is missing");
    return import(pathToFileURL(entryPath).href);
  } catch (error) {
    throw new Error(`Claude Agent SDK 未安装或安装不完整：${error?.message || String(error)}`);
  }
};

const decodeForkDescriptor = (value) => {
  if (typeof value !== "string" || !value.startsWith(FORK_DESCRIPTOR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(FORK_DESCRIPTOR_PREFIX.length), "base64url").toString("utf8"));
    if (!parsed.sourceSessionId || !parsed.targetMessageId || !parsed.newSessionId) return null;
    return parsed;
  } catch {
    return null;
  }
};

const normalizeBaseUrl = (rawUrl) => {
  const url = new URL(String(rawUrl || "").trim());
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const normalizeOpenAIBaseUrl = (rawUrl) => {
  const url = new URL(String(rawUrl || "").trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("渠道 URL 仅支持 HTTP 或 HTTPS");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const normalizeConfig = (value, preferredProviderId, preferredModelId) => {
  const state = asRecord(value);
  const providers = Array.isArray(state.providers) ? state.providers.map(asRecord) : [];
  const provider = providers.find((item) => item.providerId === preferredProviderId)
    || providers.find((item) => Array.isArray(item.models) && item.models.some((model) => asRecord(model).id === preferredModelId))
    || providers[0];
  if (!provider) throw new Error("请先为 Claude Code 配置 Anthropic API 渠道和模型");
  const endpoint = provider.endpoint === "chat-completions" ? "chat-completions" : "anthropic-messages";
  const models = Array.isArray(provider.models) ? provider.models.map(asRecord) : [];
  const model = models.find((item) => item.id === preferredModelId) || models[0];
  if (!model?.id) throw new Error("Claude Code 渠道至少需要配置一个模型");
  if (!provider.apiKey) throw new Error("Claude Code 渠道缺少 API Key");
  return {
    providerId: String(provider.providerId || "anthropic"),
    baseUrl: endpoint === "chat-completions"
      ? normalizeOpenAIBaseUrl(provider.baseUrl)
      : normalizeBaseUrl(provider.baseUrl),
    apiKey: String(provider.apiKey),
    authMode: provider.authMode === "x-api-key" ? "x-api-key" : "bearer",
    endpoint,
    models,
    modelId: String(model.id),
  };
};

const getModels = (provider) => provider.models.map((model) => ({
  id: String(model.id || ""),
  name: String(model.name || model.id || ""),
  provider: provider.providerId,
  reasoning: model.reasoning !== false,
  supportsImages: model.imageInput !== false,
  supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
})).filter((model) => model.id);

const buildSDKEnv = (provider) => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.ANTHROPIC_BASE_URL = provider.baseUrl;
  if (provider.authMode === "x-api-key") env.ANTHROPIC_API_KEY = provider.apiKey;
  else env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
  // Claude Code only treats 1/true/yes/on as enabled for boolean env flags.
  // This prevents settings.json from overriding the provider managed by Hpp.
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_AUTOUPDATER = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  env.DISABLE_TELEMETRY = "1";
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "hpp/0.1.5";
  return env;
};

const closeActiveAdapter = async () => {
  const adapter = activeAdapter;
  activeAdapter = null;
  activeAdapterKey = "";
  if (adapter) await adapter.close();
};

const prepareSDKProvider = async (provider) => {
  if (provider.endpoint !== "chat-completions") {
    await closeActiveAdapter();
    return provider;
  }
  const key = [provider.providerId, provider.baseUrl, provider.authMode, provider.apiKey].join("\u0000");
  if (!activeAdapter || activeAdapterKey !== key) {
    await closeActiveAdapter();
    activeAdapter = await startOpenAIChatAdapter(provider);
    activeAdapterKey = key;
  }
  return {
    ...provider,
    baseUrl: activeAdapter.baseUrl,
    apiKey: activeAdapter.apiKey,
    authMode: "bearer",
  };
};

const getThinkingOptions = (level) => level === "off"
  ? { thinking: { type: "disabled" } }
  : { thinking: { type: "adaptive" }, effort: level };

const extractText = (message) => {
  const content = asRecord(message).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord).filter((block) => block.type === "text").map((block) => stringValue(block.text)).join("");
};

const extractThinking = (message) => {
  const content = asRecord(message).content;
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord).filter((block) => block.type === "thinking").map((block) => stringValue(block.thinking)).join("");
};

const extractHistoryText = (rawMessage) => {
  const message = asRecord(rawMessage);
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter(isRecord).filter((block) => block.type === "text").map((block) => stringValue(block.text)).join("");
};

const buildHistory = async (sessionId, targetMessageId) => {
  if (!sessionId) return [];
  try {
    const entries = await sdk.getSessionMessages(sessionId, { dir: projectPath });
    const messages = [];
    for (const entry of entries) {
      const role = entry.type === "assistant" ? "assistant" : entry.type === "user" ? "user" : null;
      if (!role) continue;
      const content = extractHistoryText(entry.message);
      if (content) messages.push({
        id: entry.uuid,
        role,
        content,
        timestamp: Date.now() + messages.length,
        nativeTurnId: entry.uuid,
      });
      if (targetMessageId && entry.uuid === targetMessageId) break;
    }
    return messages;
  } catch {
    return [];
  }
};

const nativeSessionExists = async (sessionId) => {
  if (!sessionId) return false;
  try {
    if (typeof sdk.getSessionInfo === "function") {
      const info = await sdk.getSessionInfo(sessionId, { dir: projectPath });
      if (info) return true;
    }
    const messages = await sdk.getSessionMessages(sessionId, { dir: projectPath, limit: 1 });
    return Array.isArray(messages) && messages.length > 0;
  } catch {
    return false;
  }
};

const getAnswerValue = (answer) => {
  const record = asRecord(answer);
  if (record.kind === "multi" && Array.isArray(record.selected)) return record.selected.map(String);
  if (record.wasCustom && typeof record.answer === "string") return record.answer;
  if (typeof record.label === "string") return record.label;
  if (typeof record.answer === "string") return record.answer;
  if (typeof record.value === "string") return record.value;
  if (Array.isArray(record.selected)) return record.selected.map(String);
  return "";
};

const buildQuestionAnswers = (questions, response) => {
  const result = asRecord(response.result);
  const rawAnswers = Array.isArray(result.answers)
    ? result.answers
    : Array.isArray(response.answers) ? response.answers : [];
  return Object.fromEntries(questions.map((question, index) => [
    String(question.question || question.header || `question-${index + 1}`),
    getAnswerValue(rawAnswers[index]),
  ]));
};

const requestPermission = (toolName, input, options) => new Promise((resolvePermission) => {
  const requestId = `claude-ui-${options.toolUseID || Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const questions = toolName === "AskUserQuestion" && Array.isArray(input.questions) ? input.questions : undefined;
  pendingPermissions.set(requestId, { resolve: resolvePermission, toolName, input, questions, suggestions: options.suggestions });
  send({
    type: "ui_request",
    requestId,
    method: questions ? "questionnaire" : "confirm",
    toolName,
    questions,
    title: questions
      ? "Claude Code 正在询问"
      : options.title || (toolName === "ExitPlanMode" ? "Claude Code 请求执行计划" : `Claude Code 请求使用 ${toolName}`),
    description: options.description,
    input,
  });
  options.signal?.addEventListener("abort", () => {
    if (!pendingPermissions.delete(requestId)) return;
    resolvePermission({ behavior: "deny", message: "用户已中止", interrupt: true });
  }, { once: true });
});

const canUseTool = async (toolName, input, options) => {
  if (toolName === "AskUserQuestion" || toolName === "ExitPlanMode") {
    return requestPermission(toolName, input, options);
  }
  if (permissionMode === "full-access") return { behavior: "allow", updatedInput: input };
  return requestPermission(toolName, input, options);
};

const resolveUIResponse = (response) => {
  const id = String(response?.id || "");
  const pending = pendingPermissions.get(id);
  if (!pending) return;
  pendingPermissions.delete(id);
  if (response.cancelled) {
    pending.resolve({ behavior: "deny", message: "用户取消了操作" });
    return;
  }
  if (pending.questions) {
    pending.resolve({
      behavior: "allow",
      updatedInput: {
        ...pending.input,
        questions: pending.questions,
        answers: buildQuestionAnswers(pending.questions, response),
      },
    });
    return;
  }
  const confirmed = response.confirmed === true
    || ["true", "yes", "允许", "确认", "继续"].includes(String(response.value ?? response.text ?? "").toLowerCase());
  pending.resolve(confirmed
    ? { behavior: "allow", updatedInput: pending.input, updatedPermissions: pending.suggestions }
    : { behavior: "deny", message: "用户拒绝了操作" });
};

const sanitizeToolOutput = (value) => {
  if (value == null) return value;
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") <= 500_000) return value;
    const record = asRecord(value);
    return {
      content: stringValue(record.content || record.output || serialized).slice(0, 200_000),
      gitDiff: record.gitDiff,
      structuredPatch: record.structuredPatch,
      truncated: true,
    };
  } catch {
    return String(value).slice(0, 200_000);
  }
};

const handleStreamEvent = (message) => {
  const event = asRecord(message.event);
  if (event.type === "content_block_start") {
    const block = asRecord(event.content_block);
    streamBlockTypes.set(event.index, block.type);
    if (block.type === "tool_use") {
      const toolUseId = stringValue(block.id);
      toolUses.set(toolUseId, { toolName: stringValue(block.name), input: {} });
      streamBlockToolIds.set(event.index, toolUseId);
      send({ type: "tool_execution_start", toolUseId, toolName: block.name, input: {} });
    }
    return;
  }
  if (event.type === "content_block_delta") {
    const delta = asRecord(event.delta);
    if (delta.type === "text_delta") send({ type: "text_delta", delta: stringValue(delta.text) });
    else if (delta.type === "thinking_delta") send({ type: "thinking_delta", delta: stringValue(delta.thinking) });
    else if (delta.type === "input_json_delta") {
      const toolUseId = streamBlockToolIds.get(event.index);
      const tool = toolUses.get(toolUseId) || {};
      send({
        type: "tool_execution_update",
        toolUseId,
        toolName: tool.toolName || "工具调用",
        input: tool.input,
        output: stringValue(delta.partial_json),
      });
    }
    return;
  }
  if (event.type === "content_block_stop" && streamBlockTypes.get(event.index) === "thinking") {
    send({ type: "thinking_end" });
  }
  if (event.type === "content_block_stop") {
    streamBlockTypes.delete(event.index);
    streamBlockToolIds.delete(event.index);
  }
};

const handleAssistant = (message) => {
  const content = asRecord(message.message).content;
  if (Array.isArray(content)) {
    for (const block of content.filter(isRecord)) {
      if (block.type !== "tool_use") continue;
      const toolUseId = stringValue(block.id);
      const tracked = toolUses.get(toolUseId);
      toolUses.set(toolUseId, { toolName: stringValue(block.name), input: asRecord(block.input) });
      if (!tracked) send({ type: "tool_execution_start", toolUseId, toolName: block.name, input: block.input });
    }
  }
  send({
    type: "message_end",
    text: extractText(message.message),
    thinking: extractThinking(message.message),
    nativeTurnId: message.uuid,
    error: message.error,
  });
};

const handleUserToolResults = (message) => {
  const content = asRecord(message.message).content;
  if (!Array.isArray(content)) return;
  for (const block of content.filter(isRecord)) {
    if (block.type !== "tool_result") continue;
    const toolUseId = stringValue(block.tool_use_id);
    const tool = toolUses.get(toolUseId) || {};
    send({
      type: "tool_execution_end",
      toolUseId,
      toolName: tool.toolName || "工具调用",
      input: tool.input,
      output: sanitizeToolOutput(message.tool_use_result ?? block.content),
      isError: block.is_error === true,
    });
    toolUses.delete(toolUseId);
  }
};

const handleSDKMessage = (message) => {
  if (message?.session_id && (message.session_id !== sessionFilePath || deferredFork || isNewSession)) {
    actualSessionId = message.session_id;
    sessionFilePath = actualSessionId;
    send({ type: "session_file_path", sessionFilePath: actualSessionId });
    // Claude emits its init event before the first user message is persisted.
    // Keep an empty session in create/fork mode so an idle query restart does not
    // try to resume a conversation that does not exist on disk yet.
    if (activePromptId) {
      deferredFork = null;
      isNewSession = false;
    }
  }
  if (message.type === "stream_event") handleStreamEvent(message);
  else if (message.type === "assistant") handleAssistant(message);
  else if (message.type === "user") handleUserToolResults(message);
  else if (message.type === "system" && message.subtype === "compact_boundary") {
    send({ type: "context_compaction", uuid: message.uuid });
  } else if (message.type === "system" && message.subtype === "local_command_output") {
    send({ type: "text_delta", delta: String(message.content || "") });
  } else if (message.type === "result") {
    if (message.subtype !== "success" || message.is_error) {
      const detail = Array.isArray(message.errors) ? message.errors.join("\n") : message.result || message.stop_reason;
      send({ type: "error", id: activePromptId, error: redact(detail || "Claude Code request failed") });
    } else {
      send({ type: "prompt_done", id: activePromptId, usage: message.usage, totalCostUsd: message.total_cost_usd });
    }
    activePromptId = null;
  }
};

const createQueryOptions = (sdkProvider, queryPermissionMode) => {
  const options = {
    cwd: projectPath,
    model: currentModelId,
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    includePartialMessages: true,
    permissionMode: queryPermissionMode === "plan" ? "plan" : "bypassPermissions",
    allowDangerouslySkipPermissions: queryPermissionMode !== "plan",
    canUseTool,
    env: buildSDKEnv(sdkProvider),
    ...getThinkingOptions(thinkingLevel),
  };
  if (deferredFork) {
    options.resume = deferredFork.sourceSessionId;
    options.resumeSessionAt = deferredFork.targetMessageId;
    options.forkSession = true;
    options.sessionId = deferredFork.newSessionId;
  } else if (isNewSession) {
    options.sessionId = actualSessionId;
  } else if (actualSessionId) {
    options.resume = actualSessionId;
  }
  return options;
};

const dismissPermissions = (message) => {
  for (const pending of pendingPermissions.values()) {
    pending.resolve({ behavior: "deny", message, interrupt: true });
  }
  pendingPermissions.clear();
};

const startQuery = async () => {
  const generation = ++queryGeneration;
  const queryPermissionMode = permissionMode;
  inputQueue = new PushableInput();
  const sdkProvider = await prepareSDKProvider(activeProvider);
  const queryInstance = sdk.query({ prompt: inputQueue, options: createQueryOptions(sdkProvider, queryPermissionMode) });
  activeQuery = queryInstance;
  activeQueryPermissionMode = queryPermissionMode;
  void (async () => {
    try {
      for await (const message of queryInstance) {
        if (generation !== queryGeneration) break;
        handleSDKMessage(message);
      }
    } catch (error) {
      if (generation === queryGeneration) {
        send({ type: "error", id: activePromptId, error: redact(error?.message || String(error)) });
        activePromptId = null;
      }
    }
  })();
};

const restartQuery = async () => {
  if (activePromptId) throw new Error("SESSION_BUSY");
  dismissPermissions("Claude Code 会话正在重新配置");
  inputQueue?.close();
  activeQuery?.close();
  activeQuery = null;
  activeQueryPermissionMode = null;
  inputQueue = null;
  await startQuery();
};

const abortAndRestartQuery = async () => {
  const query = activeQuery;
  const queue = inputQueue;
  // Invalidate the old reader before interrupting so late deltas/results cannot revive the aborted turn.
  queryGeneration += 1;
  activeQuery = null;
  activeQueryPermissionMode = null;
  inputQueue = null;
  activePromptId = null;
  queue?.close();
  if (query) {
    await Promise.race([
      Promise.resolve(query.interrupt()).catch(() => undefined),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000)),
    ]);
    query.close();
  }
  await startQuery();
};

const buildPromptContent = (message, images) => {
  const content = [];
  if (message) content.push({ type: "text", text: String(message) });
  for (const image of Array.isArray(images) ? images.slice(0, 4) : []) {
    if (!image?.data || !image?.mimeType) continue;
    content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
  }
  return content;
};

const listActions = async (reload = false) => {
  if (!activeQuery) throw new Error("Claude Agent SDK session is not initialized");
  const commands = reload
    ? (await activeQuery.reloadSkills()).skills
    : await activeQuery.supportedCommands();
  const actions = [];
  const nextNames = new Set();
  for (const command of Array.isArray(commands) ? commands : []) {
    const name = String(command?.name || "").trim();
    if (!name || nextNames.has(name)) continue;
    nextNames.add(name);
    actions.push({
      kind: "skill",
      name,
      description: String(command?.description || "").trim() || undefined,
      argumentHint: String(command?.argumentHint || "").trim() || undefined,
    });
  }
  actionNames = nextNames;
  return actions;
};

const buildActionMessage = async (action, message) => {
  if (!action) return message;
  const name = String(action.name || "").trim();
  if (!name || (action.kind !== "skill" && action.kind !== "command")) throw new Error("ACTION_NOT_SUPPORTED");
  await listActions(false);
  if (!actionNames.has(name)) throw new Error("ACTION_NOT_FOUND");
  return `/${name}${String(message || "").trim() ? ` ${message}` : ""}`;
};

const init = async (command) => {
  projectPath = command.projectPath;
  sessionFilePath = command.sessionFilePath;
  deferredFork = decodeForkDescriptor(sessionFilePath);
  actualSessionId = deferredFork?.newSessionId || sessionFilePath;
  sdk = await loadSDK();
  const canResume = !deferredFork
    && command.isNewSession !== true
    && await nativeSessionExists(actualSessionId);
  isNewSession = !deferredFork && !canResume;
  activeProvider = normalizeConfig(command.config);
  currentModelId = activeProvider.modelId;
  const historySource = deferredFork?.sourceSessionId || (!isNewSession ? actualSessionId : "");
  const history = await buildHistory(historySource, deferredFork?.targetMessageId);
  if (history.length > 0) send({ type: "history_snapshot", messages: history });
  await startQuery();
  send({ type: "ready", id: command.id, sessionFilePath, models: getModels(activeProvider) });
};

const handleCommand = async (command) => {
  try {
    switch (command.type) {
      case "init":
        await init(command);
        break;
      case "prompt":
        if (!activeQuery || !inputQueue) throw new Error("Claude Agent SDK session is not initialized");
        if (activePromptId) throw new Error("SESSION_BUSY");
        permissionMode = command.permissionMode === "plan" ? "plan" : "full-access";
        if (activeQueryPermissionMode !== permissionMode) await restartQuery();
        command.message = await buildActionMessage(command.action, command.message);
        activePromptId = command.id;
        inputQueue.push({
          type: "user",
          message: { role: "user", content: buildPromptContent(command.message, command.images) },
          parent_tool_use_id: null,
          session_id: actualSessionId,
          origin: { kind: "human" },
        });
        send({ type: "accepted", id: command.id });
        break;
      case "listActions":
        send({ type: "actions", id: command.id, actions: await listActions(command.reload === true) });
        break;
      case "abort":
        dismissPermissions("用户已中止");
        await abortAndRestartQuery();
        send({ type: "aborted", id: command.id });
        break;
      case "setModel": {
        if (activePromptId) throw new Error("SESSION_BUSY");
        const nextProvider = normalizeConfig(command.config, command.provider, command.modelId);
        if (nextProvider.providerId === activeProvider.providerId) {
          await activeQuery?.setModel(command.modelId);
          activeProvider = nextProvider;
          currentModelId = command.modelId;
        } else {
          activeProvider = nextProvider;
          currentModelId = command.modelId;
          await restartQuery();
        }
        send({ type: "model_changed", id: command.id, model: { id: command.modelId, provider: command.provider } });
        break;
      }
      case "setThinkingLevel":
        if (activePromptId) throw new Error("SESSION_BUSY");
        if (!SDK_THINKING_LEVELS.has(command.level)) throw new Error("UNSUPPORTED_THINKING_LEVEL");
        thinkingLevel = command.level;
        await restartQuery();
        send({ type: "thinking_level_changed", id: command.id, level: thinkingLevel });
        break;
      case "uiResponse":
        resolveUIResponse(command.response);
        break;
      case "dispose":
        dismissPermissions("会话已关闭");
        inputQueue?.close();
        activeQuery?.close();
        await closeActiveAdapter();
        process.exit(0);
        break;
    }
  } catch (error) {
    send({ type: "error", id: command.id, error: redact(error?.message || String(error)) });
  }
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try { void handleCommand(JSON.parse(line)); }
  catch (error) { send({ type: "error", error: redact(error?.message || String(error)) }); }
});

process.on("uncaughtException", (error) => {
  send({ type: "error", error: redact(error?.message || String(error)) });
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
  send({ type: "error", error: redact(error?.message || String(error)) });
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});
