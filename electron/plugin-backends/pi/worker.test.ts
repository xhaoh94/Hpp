import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type WorkerMessage = Record<string, unknown>;

const TEST_HOST_SYSTEM_PROMPT = `[HPP 语言规则]
你是一个编程助手。请始终使用简体中文进行交流和回复。
所有面向用户的自然语言内容都必须使用简体中文，包括可见的思考或推理、计划、进度说明、提问和最终答复。
代码、标识符、文件路径、命令、日志、API 名称和专有名词应保持原文，除非为了说明确有必要翻译。`;

const fakeSDKSource = `
import { appendFileSync } from "node:fs";
const registeredExtensionCommands = process.env.PI_TEST_REGISTERED_COMMANDS
  ? JSON.parse(process.env.PI_TEST_REGISTERED_COMMANDS)
  : [];
class FakeSessionManager {
  static create() { return new FakeSessionManager(); }
  static open() { return new FakeSessionManager(); }
  getBranch() { return []; }
  getLeafId() { return null; }
  getLeafEntry() { return undefined; }
  createBranchedSession() { return undefined; }
}

class FakeSession {
  sessionFile = "fake-session.jsonl";
  sessionManager;
  modelRegistry;
  listener = null;
  uiContext = null;
  activeRun = null;
  activeTools = ["read", "bash", "edit", "write", "ask_user_question"];
  extensionFactories = [];
  toolCallHandlers = [];
  beforeAgentStartHandlers = [];
  beforeProviderRequestHandlers = [];
  sessionBeforeCompactHandlers = [];
  registeredTools = [];
  compactCalls = [];
  lastSystemPrompt = "BASE_SYSTEM_PROMPT";
  baseSystemPrompt = "BASE_SYSTEM_PROMPT";

  constructor(sessionManager, modelRegistry, extensionFactories = [], appendSystemPrompt = []) {
    this.sessionManager = sessionManager;
    this.modelRegistry = modelRegistry;
    this.model = modelRegistry.getAvailable()[0];
    this.thinkingLevel = "minimal";
    this.extensionFactories = extensionFactories;
    this.baseSystemPrompt = ["BASE_SYSTEM_PROMPT", ...appendSystemPrompt].filter(Boolean).join("\\n\\n");
  }

  async bindExtensions({ uiContext }) {
    this.uiContext = uiContext;
    for (const factory of this.extensionFactories) {
      factory({
        on: (eventName, handler) => {
          if (eventName === "tool_call") this.toolCallHandlers.push(handler);
          if (eventName === "before_agent_start") this.beforeAgentStartHandlers.push(handler);
          if (eventName === "before_provider_request") this.beforeProviderRequestHandlers.push(handler);
          if (eventName === "session_before_compact") this.sessionBeforeCompactHandlers.push(handler);
        },
        registerTool: (tool) => this.registeredTools.push(tool),
      });
    }
  }
  subscribe(listener) { this.listener = listener; return () => { this.listener = null; }; }
  getActiveToolNames() { return [...this.activeTools]; }
  setActiveToolsByName(names) { this.activeTools = [...names]; }
  getAllTools() { return ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_user_question"].map((name) => ({ name })); }
  getAvailableThinkingLevels() {
    if (!this.model?.reasoning) return ["off"];
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => {
      const mapped = this.model?.thinkingLevelMap?.[level];
      if (mapped === null) return false;
      if (level === "xhigh" || level === "max") return mapped !== undefined;
      return true;
    });
  }
  setThinkingLevel(level) {
    const levels = this.getAvailableThinkingLevels();
    this.thinkingLevel = levels.includes(level) ? level : levels[0];
  }
  async setModel(model) { this.model = model; }
  // 真实 SDK 的 AgentSession.extensionRunner 暴露 getRegisteredCommands/getCommand。
  get extensionRunner() {
    return {
      getRegisteredCommands: () => registeredExtensionCommands,
      getCommand: (name) => registeredExtensionCommands.find((command) => (command.invocationName || command.name) === name),
    };
  }
  async compact(instructions) {
    this.compactCalls.push(instructions ?? null);
    this.listener?.({ type: "agent_start" });
    this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "compacted:" + (instructions ?? "") }], stopReason: "stop" } });
    this.listener?.({ type: "agent_end" });
    this.listener?.({ type: "agent_settled" });
  }
  async steer() {}
  dispose() {}

  async emitBeforeProviderRequest(payload) {
    let currentPayload = payload;
    for (const handler of this.beforeProviderRequestHandlers) {
      const result = await handler(
        { type: "before_provider_request", payload: currentPayload },
        { model: this.model, thinkingLevel: this.thinkingLevel, hasUI: true, ui: this.uiContext },
      );
      if (result !== undefined) currentPayload = result;
    }
    return currentPayload;
  }

  prompt(message) {
    this.activeRun = this.runPrompt(message).finally(() => { this.activeRun = null; });
    return this.activeRun;
  }

  async runPrompt(message) {
    let systemPrompt = this.baseSystemPrompt;
    for (const handler of this.beforeAgentStartHandlers) {
      const result = await handler({ systemPrompt }, { hasUI: true, ui: this.uiContext });
      if (typeof result?.systemPrompt === "string") systemPrompt = result.systemPrompt;
    }
    this.lastSystemPrompt = systemPrompt;
    if (message.startsWith("system-prompt")) {
      this.listener?.({ type: "agent_start" });
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: systemPrompt }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
      this.listener?.({ type: "agent_settled" });
      return;
    }
    if (message.startsWith("provider-payload:")) {
      const payload = JSON.parse(message.slice("provider-payload:".length));
      const normalized = await this.emitBeforeProviderRequest(payload);
      this.listener?.({ type: "agent_start" });
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(normalized) }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
      this.listener?.({ type: "agent_settled" });
      return;
    }
    if (message.startsWith("active-tools")) {
      this.listener?.({ type: "agent_start" });
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(this.activeTools) }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
      this.listener?.({ type: "agent_settled" });
      return;
    }
    if (message === "registered-shell-tool") {
      const tool = this.registeredTools.find((candidate) => candidate.name === "bash");
      this.listener?.({ type: "agent_start" });
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(tool || null) }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
      this.listener?.({ type: "agent_settled" });
      return;
    }
    if (message.startsWith("/skill:review") || message.startsWith("/scout-and-plan") || message.startsWith("/implement") || message.startsWith("/implement-and-review") || message.startsWith("/compact")) {
      this.listener?.({ type: "agent_start" });
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: message }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
      this.listener?.({ type: "agent_settled" });
      return;
    }
    if (message === "retry") {
      this.listener?.({ type: "agent_start" });
      this.listener?.({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "temporary" } });
      this.listener?.({ type: "agent_end" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      this.listener?.({ type: "agent_start" });
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
      this.listener?.({ type: "agent_settled" });
      return;
    }
    if (message === "compact" || message === "slow-compact" || message === "compact-token-cap-once" || message === "compact-fail-always") {
      // 摘要内容决定 mock compact 的行为：token-cap-once 只在第一次调用失败（验证降档重试），
      // token-cap-always 每次都失败（验证连续失败止损）。
      const compactMarker = message === "compact-token-cap-once"
        ? "token-cap-once"
        : message === "compact-fail-always" ? "token-cap-always" : "summarize this";
      this.listener?.({ type: "agent_start" });
      this.listener?.({ type: "compaction_start", reason: "threshold" });
      let compaction;
      let cancelled = false;
      for (const handler of this.sessionBeforeCompactHandlers) {
        const result = await handler({
          type: "session_before_compact",
          preparation: {
            firstKeptEntryId: "kept-1",
            messagesToSummarize: [{ role: "user", content: compactMarker, timestamp: Date.now() }],
            turnPrefixMessages: [],
            isSplitTurn: false,
            tokensBefore: 1000,
            previousSummary: undefined,
            fileOps: { read: new Set(), written: new Set(), edited: new Set() },
            settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
          },
          reason: "threshold",
          willRetry: false,
          signal: new AbortController().signal,
        }, {
          modelRegistry: this.modelRegistry,
          model: this.model,
          thinkingLevel: this.thinkingLevel,
          hasUI: true,
          ui: this.uiContext,
        });
        if (result?.cancel) cancelled = true;
        if (result?.compaction) compaction = result.compaction;
      }
      await new Promise((resolve) => setTimeout(resolve, message === "slow-compact" ? 200 : 20));
      this.listener?.({ type: "compaction_end", reason: "threshold", aborted: cancelled, willRetry: true });
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: compaction?.summary || (cancelled ? "compaction-cancelled" : "continued") }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
      this.listener?.({ type: "agent_settled" });
      return;
    }
    if (message === "compact-post-turn") {
      // 收尾型压缩：agent_end 之后才开始（压缩完直接回空闲）。
      this.listener?.({ type: "agent_start" });
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "turn-finished" }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
      this.listener?.({ type: "compaction_start", reason: "threshold" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      this.listener?.({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
      this.listener?.({ type: "agent_settled" });
      return;
    }
    if (message === "permission-edit") {
      this.listener?.({ type: "agent_start" });
      let result;
      for (const handler of this.toolCallHandlers) {
        result = await handler(
          { type: "tool_call", toolCallId: "edit-1", toolName: "edit", input: { path: "src/a.ts" } },
          { hasUI: true, ui: this.uiContext },
        );
        if (result?.block) break;
      }
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(result || {}) }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
      this.listener?.({ type: "agent_settled" });
      return;
    }
    if (message === "subagent-ui") {
      this.listener?.({ type: "agent_start" });
      const tool = this.registeredTools.find((candidate) => candidate.name === "subagent");
      const result = await tool.execute(
        "subagent-call",
        { agent: "worker", task: "检查认证逻辑" },
        new AbortController().signal,
        (update) => this.listener?.({ type: "tool_execution_update", toolName: "subagent", toolCallId: "subagent-call", partialResult: update.details }),
        { cwd: process.cwd(), model: this.model, thinkingLevel: this.thinkingLevel, hasUI: true, ui: this.uiContext },
      );
      this.listener?.({ type: "tool_execution_end", toolName: "subagent", toolCallId: "subagent-call", result: result.details, isError: result.isError === true });
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(result.details) }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
      this.listener?.({ type: "agent_settled" });
      return;
    }
    if (message.startsWith("tool-call:")) {
      const payload = JSON.parse(message.slice("tool-call:".length));
      this.listener?.({ type: "agent_start" });
      let result;
      for (const handler of this.toolCallHandlers) {
        result = await handler(
          { type: "tool_call", toolCallId: "test-tool-1", ...payload },
          { hasUI: true, ui: this.uiContext },
        );
        if (result?.block) break;
      }
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(result || {}) }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
      this.listener?.({ type: "agent_settled" });
      return;
    }

    this.listener?.({ type: "agent_start" });
    this.listener?.({
      type: "tool_execution_start",
      toolName: "ask_user_question",
      toolCallId: "tool-1",
      args: { questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }] },
    });
    const result = await this.uiContext.custom(() => undefined);
    this.listener?.({ type: "tool_execution_end", toolName: "ask_user_question", toolCallId: "tool-1", result, isError: false });
    this.listener?.({ type: "agent_end" });
    this.listener?.({ type: "agent_settled" });
  }

  async abort() { await this.activeRun; }
}

export const createEventBus = () => ({ on: () => () => {} });
export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;
export const AuthStorage = { create: () => ({}) };
const availableModels = [{
  id: "pi-model",
  name: "Pi Model",
  provider: "test-provider",
  reasoning: true,
  input: ["text"],
  thinkingLevels: ["off", "minimal", "low", "medium", "high"],
}, {
  // 只声明 1 个非 off 档位（medium）：hasDeclaredLevels=true 但只 1 档 → 思考开关。
  id: "single-level-model",
  name: "Single Level",
  provider: "test-provider",
  reasoning: true,
  input: ["text"],
  thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null },
}];
const configuredDeepSeekModel = {
  id: "deepseek-v4-flash-free",
  name: "DeepSeek V4 Flash Free",
  provider: "opencode",
  reasoning: true,
  input: ["text"],
};
const proxyModel = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "luna",
  api: "openai-responses",
  reasoning: true,
  input: ["text"],
  thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
};
// 自定义渠道配置的模型：无 thinkingLevelMap，依赖内置目录按 id 兜底。
const configuredTerraModel = {
  id: "gpt-5.6-terra",
  name: "GPT-5.6 Terra",
  provider: "luna",
  api: "openai-responses",
  reasoning: true,
  input: ["text"],
};
// 运行期间新写入渠道的模型：只在 refresh 之后对 find 可见。
const refreshAddedModel = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "tanwan",
  api: "openai-responses",
  reasoning: false,
  input: ["text"],
};
export const ModelRuntime = process.env.PI_TEST_BUILTIN_FALLBACK === "1" || process.env.PI_TEST_BUILTIN_ID_FALLBACK === "1"
  ? { create: async (options = {}) => ({ modelsPath: options.modelsPath }) }
  : process.env.PI_TEST_BUILTIN_CATALOGUE === "1"
  ? {
      create: async (options = {}) => ({
        modelsPath: options.modelsPath,
        // 记录 worker 启动时重新注册的渠道，供用例断言窗口修正结果。
        registerProvider: (providerId, config) => {
          const logPath = process.env.PI_TEST_REGISTRY_LOG;
          if (!logPath) return;
          appendFileSync(logPath, JSON.stringify({ providerId, config }) + "\\n");
        },
      }),
    }
  : undefined;
export class ModelRegistry {
  constructor(runtime) { this.runtime = runtime; this.refreshCount = 0; }
  // 模拟「渠道弹窗在会话运行期间写入 models.json」：init 时的快照里没有
  // tanwan/gpt-5.6-sol，refresh（重读磁盘配置）之后才能 find 到。
  async refresh() { this.refreshCount += 1; }
  getAvailable() {
    return [
      ...availableModels,
      ...(process.env.PI_TEST_BUILTIN_FALLBACK === "1" ? [configuredDeepSeekModel] : []),
      ...(process.env.PI_TEST_BUILTIN_ID_FALLBACK === "1" ? [configuredTerraModel] : []),
      proxyModel,
    ];
  }
  getAll() {
    if (this.runtime?.modelsPath === null) {
      return [
        builtinDeepSeekModel,
        ...(process.env.PI_TEST_BUILTIN_ID_FALLBACK === "1" ? builtinTerraModels : []),
        ...(process.env.PI_TEST_BUILTIN_CATALOGUE === "1" ? builtinCatalogueWindowModels : []),
      ];
    }
    return [...availableModels, proxyModel];
  }
  find(provider, id) { return availableModels.find((model) => model.provider === provider && model.id === id)
    || (provider === configuredDeepSeekModel.provider && id === configuredDeepSeekModel.id ? configuredDeepSeekModel : undefined)
    || (provider === configuredTerraModel.provider && id === configuredTerraModel.id ? configuredTerraModel : undefined)
    || (provider === proxyModel.provider && id === proxyModel.id ? proxyModel : undefined)
    || (this.refreshCount > 0 && provider === refreshAddedModel.provider && id === refreshAddedModel.id ? refreshAddedModel : undefined); }
  getError() { return undefined; }
  hasConfiguredAuth() { return true; }
  async getApiKeyAndHeaders() { return { ok: true, apiKey: "test-api-key", headers: { "x-test": "1" } }; }
  static create() { return new ModelRegistry({}); }
}
const builtinDeepSeekModel = {
  id: "deepseek-v4-flash-free",
  name: "DeepSeek V4 Flash Free",
  provider: "opencode",
  reasoning: true,
  input: ["text"],
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  },
};
// 模拟 pi-ai 内置目录：同一模型存在多条 provider 声明，且声明质量不一。
// azure 的残缺声明在前（缺键会被“缺键=支持”误读为全部支持），opencode 的
// 完整声明在后（off/minimal 均标 null → 仅 low~max 5 档）。
const builtinTerraModels = [
  {
    id: "gpt-5.6-terra",
    provider: "azure-openai-responses",
    reasoning: true,
    thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
  },
  {
    id: "gpt-5.6-terra",
    provider: "opencode",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  },
];
// 模拟 pi-ai 内置目录的上下文窗口：同一模型存在多条 provider 声明，
// cloudflare 条目上报的是网关上限，不参与取最大值。
const builtinCatalogueWindowModels = [
  { id: "gpt-5.6-sol", provider: "opencode", contextWindow: 400000, reasoning: true },
  { id: "gpt-5.6-sol", provider: "cloudflare-workers-ai", contextWindow: 9999999, reasoning: true },
  { id: "gpt-5.6-sol", provider: "openai", contextWindow: 262144, reasoning: true },
];
export const SettingsManager = { create: () => ({ getRetrySettings: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 1 }) }) };
export class DefaultResourceLoader {
  constructor(options = {}) {
    this.extensionFactories = options.extensionFactories || [];
    this.appendSystemPrompt = options.appendSystemPrompt || [];
    this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths || [];
  }
  async reload() {}
  getSkills() { return { skills: [{ name: "review", description: "Review changes" }] }; }
  getPrompts() {
    const prompts = [{ name: "release", description: "Prepare release", usage: "[version]" }];
    if (this.additionalPromptTemplatePaths.length > 0) {
      prompts.push(
        { name: "implement", description: "scout 调查、planner 规划、worker 在隔离上下文中实施完整任务" },
        { name: "scout-and-plan", description: "先由 scout 调查代码库，再由 planner 制定计划，不执行修改" },
        { name: "implement-and-review", description: "worker 实施、reviewer 审查、worker 根据反馈修正" },
      );
    }
    return { prompts };
  }
  getExtensions() {
    return {
      extensions: [
        { path: "<inline:1>", handlers: new Map([["tool_call", [() => undefined]]]) },
        // 真实 SDK 里扩展命令集合是 Map（loader 的 extension.commands）。
        { commands: new Map([["inspect", { name: "inspect", description: "Inspect project" }]]) },
      ],
    };
  }
}
export const SessionManager = FakeSessionManager;
export const createAgentSession = async ({ sessionManager, modelRegistry, modelRuntime, resourceLoader }) => ({
  session: new FakeSession(
    sessionManager,
    modelRegistry || new ModelRegistry(modelRuntime),
    resourceLoader.extensionFactories,
    resourceLoader.appendSystemPrompt,
  ),
});
let compactAttempts = 0;
let firstCompactThinkingLevel = null;
export const compact = async (preparation, model, apiKey, headers, _instructions, _signal, thinkingLevel, _streamFn, env, retry) => {
  compactAttempts += 1;
  if (compactAttempts === 1) firstCompactThinkingLevel = thinkingLevel;
  // 摘要被输出上限截断：SDK 会抛出这条文案，worker 应据此降档重试。
  const marker = preparation?.messagesToSummarize?.[0]?.content;
  if (marker === "token-cap-always" || (marker === "token-cap-once" && compactAttempts === 1)) {
    throw new Error("Summarization failed: generation hit the token cap and the summary is incomplete");
  }
  return {
    summary: JSON.stringify({
      id: model.id,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      apiKey,
      headers,
      env,
      thinkingLevel,
      retry,
      attempts: compactAttempts,
      firstThinkingLevel: firstCompactThinkingLevel,
      summaryReserveTokens: preparation?.settings?.reserveTokens,
    }),
    firstKeptEntryId: "kept-1",
    tokensBefore: 1000,
    details: { readFiles: [], modifiedFiles: [] },
  };
};
export const createBashToolDefinition = (_cwd, options = {}) => ({
  name: "bash",
  label: "bash",
  description: "fake bash tool",
  promptSnippet: "fake bash",
  promptGuidelines: [],
  parameters: {},
  commandPrefix: options.commandPrefix,
  rewrittenCommand: options.spawnHook?.({ command: "npm run build && npx tsc", cwd: _cwd, env: {} }).command,
});
export const getShellConfig = process.env.PI_TEST_BROKEN_SHELL === "1"
  ? () => ({ shell: "hpp-definitely-missing-shell", args: ["-c"] })
  : process.env.PI_TEST_BROKEN_DEFAULT_SHELL === "1"
    ? (customShellPath) => customShellPath
      ? ({ shell: customShellPath, args: ["-c"] })
      : ({ shell: "hpp-definitely-broken-wsl-bash", args: ["-s"], commandTransport: "stdin" })
  : process.env.PI_TEST_SHELL_PATH
    ? () => ({
        shell: process.env.PI_TEST_SHELL_PATH,
        args: JSON.parse(process.env.PI_TEST_SHELL_ARGS || "[]"),
      })
    : undefined;
`;

const writeFakeSDK = async (runtimeRoot: string) => {
  const packageDir = join(runtimeRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "0.0.0-test",
    type: "module",
    exports: { ".": { import: "./index.mjs" } },
  }), "utf8");
  await writeFile(join(packageDir, "index.mjs"), fakeSDKSource, "utf8");
};

const startWorker = (runtimeRoot: string, agentDir: string, extraEnv: NodeJS.ProcessEnv = {}) => {
  const workerPath = resolve("electron/plugin-backends/pi/worker.mjs");
  const child = spawn(process.execPath, [workerPath], {
    env: { ...process.env, PI_SDK_PACKAGE_ROOT: runtimeRoot, PI_CODING_AGENT_DIR: agentDir, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: WorkerMessage[] = [];
  const waiters: Array<{
    predicate: (message: WorkerMessage) => boolean;
    resolve: (message: WorkerMessage) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: WorkerMessage;
    try { message = JSON.parse(line) as WorkerMessage; } catch { return; }
    messages.push(message);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) return;
    const waiter = waiters.splice(index, 1)[0];
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  });
  const waitFor = (predicate: (message: WorkerMessage) => boolean, timeoutMs = 10000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<WorkerMessage>((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        reject,
        timeout: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Pi worker response timed out"));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  };
  const send = (message: WorkerMessage) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return { child, messages, send, waitFor };
};

const stopWorker = async (child: ChildProcessWithoutNullStreams) => {
  if (child.exitCode !== null) return;
  child.stdin.write(`${JSON.stringify({ id: "dispose", type: "dispose" })}\n`);
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolvePromise();
    }, 1000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
};

describe("Pi SDK worker protocol", () => {
  let tempRoot = "";
  let runtimeRoot = "";
  let agentDir = "";
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hpp-pi-worker-"));
    runtimeRoot = join(tempRoot, "runtime");
    agentDir = join(tempRoot, "agent");
    await Promise.all([writeFakeSDK(runtimeRoot), mkdir(agentDir, { recursive: true })]);
  });

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stopWorker));
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("reports the current model's native thinking levels and its effective selection", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "models", type: "getModels" });
    const modelsMessage = await worker.waitFor((message) => message.id === "models");
    expect(modelsMessage.models).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "pi-model",
      supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"],
      // 无档位声明（无 thinkingLevelMap、目录兜底 miss）→ 思考开关模式。
      thinkingLevelMode: "toggle",
    })]));
    // Every registry model (not just the active one) exposes its own levels.
    // GPT-5.6's catalogue map marks off/minimal as unsupported, so those
    // choices are simply not listed.
    expect(modelsMessage.models).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "gpt-5.6-luna",
      supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      // 条目自带档位 map → 档位下拉模式。
      thinkingLevelMode: "levels",
    })]));
    // 只声明 1 个非 off 档位 → 虽有声明但只 1 档 → 思考开关模式。
    expect(modelsMessage.models).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "single-level-model",
      supportedThinkingLevels: ["medium"],
      thinkingLevelMode: "toggle",
    })]));

    worker.send({ id: "thinking", type: "setThinkingLevel", level: "xhigh" });
    await expect(worker.waitFor((message) => message.id === "thinking"))
      .resolves.toMatchObject({ type: "thinking_level_changed", level: "off" });
  });

  it("falls back to the SDK built-in catalogue when a configured model omits its capability map", async () => {
    const worker = startWorker(runtimeRoot, agentDir, { PI_TEST_BUILTIN_FALLBACK: "1" });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "models", type: "getModels" });
    const modelsMessage = await worker.waitFor((message) => message.id === "models");

    expect(modelsMessage.models).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "deepseek-v4-flash-free",
      provider: "opencode",
      supportedThinkingLevels: ["high", "max"],
      // 内置目录兜底命中档位 map → 档位下拉模式。
      thinkingLevelMode: "levels",
    })]));
  });

  it("prefers a complete capability map when the id fallback matches several catalogue entries", async () => {
    const worker = startWorker(runtimeRoot, agentDir, { PI_TEST_BUILTIN_ID_FALLBACK: "1" });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "models", type: "getModels" });
    const modelsMessage = await worker.waitFor((message) => message.id === "models");

    // 内置目录中同一模型存在多条声明：azure 的残缺声明（只写 off/xhigh/max，
    // 其余档位缺键会被误读为支持）不应被采用；应命中完整的 opencode 声明，
    // off/minimal 均标 null → 仅 low~max 5 档，不出现“最低”。
    expect(modelsMessage.models).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "gpt-5.6-terra",
      provider: "luna",
      supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    })]));
  });

  it("adopts built-in catalogue context windows for custom channels on start-up", async () => {
    // Hpp 同步写入 models.json 的自建渠道只声明 id/name/reasoning/input。
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        tanwan: {
          name: "Tanwan",
          baseUrl: "https://api.example.com/v1",
          api: "openai-responses",
          apiKey: "test-key",
          models: [
            { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, input: ["text"] },
            { id: "unknown-model", name: "Unknown", reasoning: true, input: ["text"] },
            { id: "declared-model", name: "Declared", reasoning: true, input: ["text"], contextWindow: 555000 },
          ],
        },
      },
    }), "utf8");
    const registryLog = join(tempRoot, "registry-log.jsonl");
    const worker = startWorker(runtimeRoot, agentDir, {
      PI_TEST_BUILTIN_CATALOGUE: "1",
      PI_TEST_REGISTRY_LOG: registryLog,
    });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    type RegistryEntry = { providerId: string; config: { models: Array<{ id: string; contextWindow: number }> } };
    const entries = (await readFile(registryLog, "utf8")).trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as RegistryEntry);
    expect(entries.map((entry) => entry.providerId)).toEqual(["tanwan"]);
    expect(Object.fromEntries(entries[0].config.models.map((model) => [model.id, model.contextWindow]))).toEqual({
      // 目录命中：多 provider 同名取最大，cloudflare 网关条目被忽略。
      "gpt-5.6-sol": 400000,
      // 目录未命中且未声明 → pi 默认窗口。
      "unknown-model": 128000,
      // 目录未命中但 models.json 声明了 → 保留声明值。
      "declared-model": 555000,
    });
  });

  it("reloads model config from disk before declaring a model unavailable", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    // 模拟渠道弹窗在会话运行期间写入 models.json：init 时的注册表快照没有
    // tanwan/gpt-5.6-sol（fake registry 只在 refresh 后才让 find 命中）。
    // setModel 必须先重读磁盘配置再宣判不可用，否则新加的模型永远切不上。
    worker.send({ id: "switch", type: "setModel", provider: "tanwan", modelId: "gpt-5.6-sol" });
    await expect(worker.waitFor((message) => message.id === "switch"))
      .resolves.toMatchObject({
        type: "model_changed",
        model: { id: "gpt-5.6-sol", provider: "tanwan" },
      });
  });

  it("still reports an unavailable model when a config reload does not reveal it", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "switch", type: "setModel", provider: "tanwan", modelId: "nonexistent-model" });
    await expect(worker.waitFor((message) => message.id === "switch"))
      .resolves.toMatchObject({
        type: "error",
        error: "Pi model is not available: tanwan/nonexistent-model",
      });
  });

  it("emits prompt_done only after the final settled retry", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "prompt-1", type: "prompt", message: "retry", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-1");

    const types = worker.messages.map((message) => message.type);
    expect(types.filter((type) => type === "agent_start")).toHaveLength(2);
    expect(types.lastIndexOf("prompt_done")).toBeGreaterThan(types.lastIndexOf("agent_end"));
  });

  it("reports context compaction start and completion with one stable id", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "compact-1", type: "prompt", message: "compact", permissionMode: "full-access" });

    const started = await worker.waitFor((message) => message.type === "context_compaction" && message.phase === "started");
    const completed = await worker.waitFor((message) => message.type === "context_compaction" && message.phase === "completed");
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-1");

    expect(completed.id).toBe(started.id);
    expect(worker.messages.indexOf(completed)).toBeLessThan(
      worker.messages.findIndex((message) => message.type === "prompt_done" && message.id === "compact-1"),
    );
  });

  it("marks compaction that only starts after the turn ended", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    // 运行中压缩（工具循环之间）：agent run 尚未结束，压缩完对话继续。
    worker.send({ id: "compact-mid-run", type: "prompt", message: "compact", permissionMode: "full-access" });
    const midRun = await worker.waitFor(
      (message) => message.type === "context_compaction" && message.phase === "started" && message.postTurn === false,
    );
    expect(midRun.postTurn).toBe(false);
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-mid-run");

    // 收尾型压缩：agent_end 之后才开始，压缩完直接回空闲。
    worker.send({ id: "compact-after-turn", type: "prompt", message: "compact-post-turn", permissionMode: "full-access" });
    const postTurn = await worker.waitFor(
      (message) => message.type === "context_compaction" && message.phase === "started" && message.postTurn === true,
    );
    expect(postTurn.postTurn).toBe(true);
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-after-turn");
    await worker.waitFor(
      (message) => message.type === "context_compaction" && message.phase === "completed" && message.id === postTurn.id,
    );
  });

  it("accepts guidance while compaction runs and rejects it once the turn has ended", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    // 压缩仍在运行（agent run 未结束）：引导可以入队，压缩结束后 Pi 继续对话时消费它。
    worker.send({ id: "compact-slow", type: "prompt", message: "slow-compact", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "context_compaction" && message.phase === "started");
    worker.send({ id: "guide-running", type: "guidance", message: "顺便改下文案" });
    const accepted = await worker.waitFor(
      (message) => message.id === "guide-running" && (message.type === "guidance_done" || message.type === "error"),
    );
    expect(accepted.type).toBe("guidance_done");
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-slow");

    // 本轮已经结束：没有运行的回合会消费这条引导，直接拒绝而不是让它卡在 Pi 的队列里。
    worker.send({ id: "guide-idle", type: "guidance", message: "现在呢" });
    const rejected = await worker.waitFor(
      (message) => message.id === "guide-idle" && (message.type === "guidance_done" || message.type === "error"),
    );
    expect(rejected.type).toBe("error");
    expect(String(rejected.error)).toContain("本轮已结束");
  });

  it("uses low thinking by default for Agent compaction", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "compact-low", type: "prompt", message: "compact", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-low");

    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    const summary = JSON.parse(String((message?.message as { text?: unknown })?.text || "{}"));
    expect(summary).toMatchObject({
      id: "pi-model",
      provider: "test-provider",
      apiKey: "test-api-key",
      thinkingLevel: "low",
    });
  });

  it("raises the summary output budget and caps an inherited thinking level", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({
      id: "init",
      type: "init",
      projectPath: tempRoot,
      // “跟随聊天”（inherit）+ 支持 max 档的压缩模型。
      compactionConfig: { thinkingLevel: "inherit", modelMode: "custom", model: "luna/gpt-5.6-luna" },
    });
    await worker.waitFor((message) => message.type === "ready");
    // 聊天档位调到 max：继承给摘要请求会把输出预算耗在思考上，必须下调到 medium。
    worker.send({ id: "switch", type: "setModel", provider: "luna", modelId: "gpt-5.6-luna" });
    await worker.waitFor((message) => message.type === "model_changed");
    worker.send({ id: "level", type: "setThinkingLevel", level: "max" });
    await expect(worker.waitFor((message) => message.id === "level"))
      .resolves.toMatchObject({ type: "thinking_level_changed", level: "max" });
    worker.send({ id: "compact-inherit", type: "prompt", message: "compact", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-inherit");

    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    const summary = JSON.parse(String((message?.message as { text?: unknown })?.text || "{}"));
    expect(summary).toMatchObject({
      id: "gpt-5.6-luna",
      provider: "luna",
      thinkingLevel: "medium",
      // pi 默认 reserveTokens=16384 只给摘要 13107 tokens，压缩前抬高到 32768。
      summaryReserveTokens: 32768,
    });
  });

  it("retries a token-capped summary with the lowest thinking level", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "compact-cap", type: "prompt", message: "compact-token-cap-once", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-cap");

    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    const summary = JSON.parse(String((message?.message as { text?: unknown })?.text || "{}"));
    expect(summary).toMatchObject({
      id: "pi-model",
      // 第一次以默认 low 档被输出上限截断，第二次降到 off 档重试成功，不必回退到别的模型。
      firstThinkingLevel: "low",
      thinkingLevel: "off",
      attempts: 2,
    });
    expect(worker.messages.some((item) => item.type === "status" && String(item.title || "").includes("不可用"))).toBe(false);
  });

  it("suspends auto compaction after repeated failures and resumes when the config changes", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    const runFailingCompaction = async (id: string) => {
      worker.send({ id, type: "prompt", message: "compact-fail-always", permissionMode: "full-access" });
      await worker.waitFor((message) => message.type === "prompt_done" && message.id === id);
      const last = worker.messages.filter((item) => item.type === "message_end").at(-1);
      return String((last?.message as { text?: unknown })?.text || "");
    };

    await runFailingCompaction("fail-1");
    expect(worker.messages.some((item) => item.type === "status" && String(item.title || "") === "上下文压缩已暂停")).toBe(false);

    // 第二次彻底失败达到阈值：发出暂停提示，不再反复发起注定失败的摘要请求。
    expect(await runFailingCompaction("fail-2")).toBe("continued");
    expect(worker.messages.some((item) => item.type === "status" && String(item.title || "") === "上下文压缩已暂停")).toBe(true);

    // 已暂停：自动压缩直接取消，不再产生摘要请求。
    expect(await runFailingCompaction("fail-3")).toBe("compaction-cancelled");

    // 用户改完压缩配置（例如换了渠道/模型）后恢复尝试。
    worker.send({ id: "resume", type: "setCompactionConfig", config: { enabled: true, thinkingLevel: "low" } });
    await worker.waitFor((message) => message.type === "compaction_config_changed");
    expect(await runFailingCompaction("fail-4")).toBe("continued");
  });

  it("uses a configured OpenAI-compatible model for Agent compaction", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({
      id: "init",
      type: "init",
      projectPath: tempRoot,
      compactionConfig: {
        thinkingLevel: "low",
        modelMode: "custom",
        customModel: {
          baseUrl: "https://summary.example.com/v1/",
          apiKey: "summary-key",
          modelId: "summary-fast",
          api: "openai-responses",
          reasoning: true,
        },
      },
    });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "compact-custom", type: "prompt", message: "compact", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-custom");

    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    const summary = JSON.parse(String((message?.message as { text?: unknown })?.text || "{}"));
    expect(summary).toMatchObject({
      id: "summary-fast",
      provider: "hpp-compaction",
      api: "openai-responses",
      baseUrl: "https://summary.example.com/v1",
      reasoning: true,
      apiKey: "summary-key",
      thinkingLevel: "low",
    });
  });

  it("uses a configured channel model for Agent compaction", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({
      id: "init",
      type: "init",
      projectPath: tempRoot,
      // 渠道弹窗里从已配置渠道选的压缩模型："providerId/modelId"。
      compactionConfig: { modelMode: "custom", model: "test-provider/single-level-model" },
    });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "compact-channel", type: "prompt", message: "compact", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-channel");

    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    const summary = JSON.parse(String((message?.message as { text?: unknown })?.text || "{}"));
    expect(summary).toMatchObject({
      id: "single-level-model",
      provider: "test-provider",
      apiKey: "test-api-key",
    });
  });

  it("re-reads the model catalogue before reporting a freshly added compaction model", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({
      id: "init",
      type: "init",
      projectPath: tempRoot,
      // 渠道弹窗在会话运行期间新加入的模型：init 快照里 find 不到，
      // refresh（重读磁盘配置）之后才能找到，不应误报不可用。
      compactionConfig: { modelMode: "custom", model: "tanwan/gpt-5.6-sol" },
    });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "compact-added", type: "prompt", message: "compact", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-added");

    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    const summary = JSON.parse(String((message?.message as { text?: unknown })?.text || "{}"));
    expect(summary).toMatchObject({ id: "gpt-5.6-sol", provider: "tanwan" });
    expect(worker.messages.some((item) => item.type === "status"
      && String(item.title || "").includes("自定义压缩模型不可用"))).toBe(false);
  });

  it("falls back to the current model when the configured channel model is gone", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({
      id: "init",
      type: "init",
      projectPath: tempRoot,
      // 渠道或模型已被删除：注册表 find 不到，应回退当前模型而不是中断压缩。
      compactionConfig: { modelMode: "custom", model: "deleted-provider/summary-model" },
    });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "compact-missing", type: "prompt", message: "compact", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-missing");

    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    const summary = JSON.parse(String((message?.message as { text?: unknown })?.text || "{}"));
    expect(summary).toMatchObject({ id: "pi-model", provider: "test-provider" });
    expect(worker.messages.some((item) => item.type === "status"
      && String(item.detail || "").includes("已配置的压缩模型不可用"))).toBe(true);
    // 用户看不懂“不可用”应该怎么做：detail 里要给可直接照做的指引。
    expect(worker.messages.some((item) => item.type === "status"
      && String(item.detail || "").includes("跟随当前 Agent 模型"))).toBe(true);
  });

  it("cancels compaction when the channel config disables it", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({
      id: "init",
      type: "init",
      projectPath: tempRoot,
      // 渠道弹窗「启用上下文压缩」关闭后的配置形态：其余字段缺省。
      compactionConfig: { enabled: false },
    });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "compact-off", type: "prompt", message: "compact", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-off");

    // 处理器应返回 { cancel: true }：fake session 不走 compact()，正文为取消标记。
    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    expect((message?.message as { text?: unknown })?.text).toBe("compaction-cancelled");
  });

  it("applies a hot-updated compaction toggle to the next compaction", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    // 运行期间通过 setCompactionConfig 热更新关闭（弹窗「应用压缩设置」走的路径）。
    worker.send({ id: "cfg", type: "setCompactionConfig", config: { enabled: false } });
    await expect(worker.waitFor((message) => message.id === "cfg"))
      .resolves.toMatchObject({ type: "compaction_config_changed", config: { enabled: false } });

    worker.send({ id: "compact-hot", type: "prompt", message: "compact", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact-hot");
    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    expect((message?.message as { text?: unknown })?.text).toBe("compaction-cancelled");
  });

  it("applies a hot-updated subagent config without restarting the worker", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({
      id: "init",
      type: "init",
      projectPath: tempRoot,
      subagentConfig: { enabled: true, defaultModelMode: "custom", defaultModel: "provider/first" },
    });
    await worker.waitFor((message) => message.type === "ready");
    // 弹窗「应用 SubAgent 设置」走的路径：模型/profile 热更新后
    // 下一次 subagent 调用即使用新配置。
    worker.send({
      id: "subagent-cfg",
      type: "setSubagentConfig",
      config: { enabled: true, defaultModelMode: "custom", defaultModel: "provider/second" },
    });
    await expect(worker.waitFor((message) => message.id === "subagent-cfg"))
      .resolves.toMatchObject({
        type: "subagent_config_changed",
        config: { enabled: true, defaultModelMode: "custom", defaultModel: "provider/second" },
      });
  });

  it("waits for an active post-turn compaction to settle before worker exit", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "slow-compact", type: "prompt", message: "slow-compact", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "context_compaction" && message.phase === "started");

    const startedAt = Date.now();
    worker.send({ id: "dispose-during-compaction", type: "dispose" });
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("Pi worker did not exit after compaction disposal")), 1500);
      worker.child.once("exit", () => {
        clearTimeout(timeout);
        resolvePromise();
      });
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(worker.child.exitCode).toBe(0);
  });

  it("keeps tools available while the permission hook guards execution", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    const readTools = async (id: string, permissionMode: "ask" | "auto" | "full-access") => {
      worker.send({ id, type: "prompt", message: `active-tools:${id}`, permissionMode });
      await worker.waitFor((message) => message.type === "prompt_done" && message.id === id);
      const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
      return JSON.parse(String((message?.message as { text?: unknown })?.text || "[]")) as string[];
    };

    const fullAccessTools = await readTools("full-1", "full-access");
    expect(fullAccessTools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "grep", "find", "ls"]));

    const automaticTools = await readTools("auto-1", "auto");
    expect(automaticTools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "grep", "find", "ls"]));

    const restoredTools = await readTools("full-2", "full-access");
    expect(restoredTools).toEqual(expect.arrayContaining(["bash", "edit", "write", "grep", "find", "ls"]));
  });

  it("enforces native Plan mode per turn and restores implementation tools when disabled", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    const readLastText = () => String((worker.messages.filter((item) => item.type === "message_end").at(-1)?.message as { text?: unknown })?.text || "");

    worker.send({
      id: "plan-on",
      type: "prompt",
      message: "active-tools:plan-on",
      permissionMode: "auto",
      planModeEnabled: true,
    });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "plan-on");
    const planTools = JSON.parse(readLastText()) as string[];
    expect(planTools).toEqual(expect.arrayContaining(["read", "bash", "grep", "find", "ls"]));
    expect(planTools).not.toEqual(expect.arrayContaining(["edit", "write"]));

    worker.send({
      id: "plan-off",
      type: "prompt",
      message: "active-tools:plan-off",
      permissionMode: "auto",
      planModeEnabled: false,
    });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "plan-off");
    expect(JSON.parse(readLastText())).toEqual(expect.arrayContaining(["edit", "write"]));
  });

  it("injects the Plan prompt transiently without leaving it on the next implementation turn", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({
      id: "init",
      type: "init",
      projectPath: tempRoot,
      hostSystemPrompt: TEST_HOST_SYSTEM_PROMPT,
    });
    await worker.waitFor((message) => message.type === "ready");

    worker.send({ id: "prompt-on", type: "prompt", message: "system-prompt:on", permissionMode: "auto", planModeEnabled: true });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-on");
    const planPrompt = String((worker.messages.filter((item) => item.type === "message_end").at(-1)?.message as { text?: unknown })?.text || "");
    expect(planPrompt).toContain("[HPP 计划模式已启用]");
    expect(planPrompt).toContain("不要询问用户是否要继续实施");
    expect(planPrompt).toContain("[HPP 语言规则]");
    expect(planPrompt).toContain("请始终使用简体中文进行交流和回复");
    expect(planPrompt).toContain("可见的思考或推理");
    expect(planPrompt.indexOf("[HPP 语言规则]")).toBeGreaterThan(planPrompt.indexOf("[HPP 计划模式已启用]"));
    expect(planPrompt.trim().endsWith("除非为了说明确有必要翻译。")).toBe(true);

    worker.send({ id: "prompt-off", type: "prompt", message: "system-prompt:off", permissionMode: "auto", planModeEnabled: false });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-off");
    const implementationPrompt = String((worker.messages.filter((item) => item.type === "message_end").at(-1)?.message as { text?: unknown })?.text || "");
    expect(implementationPrompt).toContain("[HPP 语言规则]");
    expect(implementationPrompt).toContain("请始终使用简体中文进行交流和回复");
    expect(implementationPrompt).toContain("可见的思考或推理");
    expect(implementationPrompt.trim().endsWith("除非为了说明确有必要翻译。")).toBe(true);
    expect(implementationPrompt).not.toContain("[HPP 计划模式已启用]");
  });

  it("blocks Plan mutations before permission UI and permits safe inspection commands", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    worker.send({ id: "plan-edit", type: "prompt", message: "permission-edit", permissionMode: "ask", planModeEnabled: true });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "plan-edit");
    expect(worker.messages).not.toContainEqual(expect.objectContaining({ type: "extension_ui_request" }));
    let result = JSON.parse(String((worker.messages.filter((item) => item.type === "message_end").at(-1)?.message as { text?: unknown })?.text || "{}"));
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("Plan 模式为只读模式");

    worker.send({
      id: "safe-shell",
      type: "prompt",
      message: `tool-call:${JSON.stringify({ toolName: "bash", input: { command: "git status --short" } })}`,
      permissionMode: "auto",
      planModeEnabled: true,
    });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "safe-shell");
    result = JSON.parse(String((worker.messages.filter((item) => item.type === "message_end").at(-1)?.message as { text?: unknown })?.text || "{}"));
    expect(result).toEqual({});

    worker.send({
      id: "unsafe-shell",
      type: "prompt",
      message: `tool-call:${JSON.stringify({ toolName: "bash", input: { command: "git reset --hard" } })}`,
      permissionMode: "full-access",
      planModeEnabled: true,
    });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "unsafe-shell");
    result = JSON.parse(String((worker.messages.filter((item) => item.type === "message_end").at(-1)?.message as { text?: unknown })?.text || "{}"));
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("git reset --hard");
  });

  it("disables an unhealthy shell while preserving file discovery tools", async () => {
    const worker = startWorker(runtimeRoot, agentDir, { PI_TEST_BROKEN_SHELL: "1" });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "tools", type: "prompt", message: "active-tools:broken-shell", permissionMode: "full-access" });

    await expect(worker.waitFor((message) => message.type === "status" && message.status === "warning"))
      .resolves.toMatchObject({ title: "Pi Shell 不可用，已改用文件发现工具" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "tools");
    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    const tools = JSON.parse(String((message?.message as { text?: unknown })?.text || "[]")) as string[];
    expect(tools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
    expect(tools).not.toContain("bash");
  });

  it.skipIf(process.platform !== "win32")("keeps the bash tool when Pi uses Windows PowerShell", async () => {
    const powershellPath = join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const worker = startWorker(runtimeRoot, agentDir, {
      PI_TEST_SHELL_PATH: powershellPath,
      PI_TEST_SHELL_ARGS: JSON.stringify(["-NoProfile", "-Command"]),
    });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "tools", type: "prompt", message: "active-tools:powershell", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "tools");

    expect(worker.messages).not.toContainEqual(expect.objectContaining({
      type: "status",
      id: "pi-shell-unavailable",
    }));
    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    const tools = JSON.parse(String((message?.message as { text?: unknown })?.text || "[]")) as string[];
    expect(tools).toContain("bash");
  });

  it.skipIf(process.platform !== "win32")("registers a PowerShell-aware bash tool with command normalization", async () => {
    const powershellPath = join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const worker = startWorker(runtimeRoot, agentDir, {
      PI_TEST_SHELL_PATH: powershellPath,
      PI_TEST_SHELL_ARGS: JSON.stringify(["-NoProfile", "-Command"]),
    });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "tool", type: "prompt", message: "registered-shell-tool", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "tool");

    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    const tool = JSON.parse(String((message?.message as { text?: unknown })?.text || "null")) as Record<string, unknown>;
    expect(tool).toMatchObject({
      name: "bash",
      label: "PowerShell",
      rewrittenCommand: "npm.cmd run build && npx.cmd tsc",
    });
    expect(String(tool.description)).toContain("注册的工具名称仍为 bash");
    expect(String(tool.commandPrefix)).toContain("[Console]::OutputEncoding");
    expect(tool.promptGuidelines).toEqual(expect.arrayContaining([
      expect.stringContaining("bash 工具已注册并可用"),
      expect.stringContaining("npm.cmd"),
    ]));
  });

  it.skipIf(process.platform !== "win32")("falls back to an installed shell when Pi selects a broken WSL bash", async () => {
    const worker = startWorker(runtimeRoot, agentDir, { PI_TEST_BROKEN_DEFAULT_SHELL: "1" });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "tools", type: "prompt", message: "active-tools:wsl-fallback", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "tools");

    expect(worker.messages).not.toContainEqual(expect.objectContaining({
      type: "status",
      id: "pi-shell-unavailable",
    }));
    const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
    const tools = JSON.parse(String((message?.message as { text?: unknown })?.text || "[]")) as string[];
    expect(tools).toContain("bash");
  });

  it("dismisses a pending questionnaire before waiting for abort", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "prompt-1", type: "prompt", message: "ask", permissionMode: "full-access" });
    const request = await worker.waitFor((message) => message.type === "extension_ui_request");
    expect((request.request as { questions?: unknown[] }).questions).toHaveLength(1);

    worker.send({ id: "abort-1", type: "abort" });
    await expect(worker.waitFor((message) => message.type === "aborted" && message.id === "abort-1"))
      .resolves.toMatchObject({ type: "aborted", id: "abort-1" });
  });

  it("returns only the questionnaire options selected by the remote client", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "prompt-1", type: "prompt", message: "ask", permissionMode: "full-access" });
    const request = await worker.waitFor((message) => message.type === "extension_ui_request");
    const requestId = String((request.request as { id?: unknown }).id || "");

    worker.send({
      id: "ui-response-1",
      type: "uiResponse",
      response: {
        id: requestId,
        cancelled: false,
        result: {
          cancelled: false,
          answers: [{
            id: "agents",
            questionIndex: 0,
            question: "常用 Agent",
            kind: "multi",
            answer: null,
            selected: ["Pi"],
            selectedOptions: [{ label: "Pi", value: "pi" }],
            values: ["pi"],
          }],
        },
      },
    });

    await expect(worker.waitFor((message) => message.type === "ui_response_done" && message.id === "ui-response-1"))
      .resolves.toMatchObject({ type: "ui_response_done", id: "ui-response-1" });

    const completed = await worker.waitFor((message) => message.type === "tool_execution_end");
    expect(completed.result).toMatchObject({
      cancelled: false,
      answers: [{ selected: ["Pi"], values: ["pi"] }],
    });
  });

  it("returns an error for a UI response without a matching request", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    worker.send({
      id: "ui-missing",
      type: "uiResponse",
      response: { id: "missing-request", text: "answer" },
    });

    await expect(worker.waitFor((message) => message.type === "error" && message.id === "ui-missing"))
      .resolves.toMatchObject({
        type: "error",
        id: "ui-missing",
        error: "Unknown Pi UI request: missing-request",
      });
  });

  it("routes a child subagent permission request through the parent UI protocol", async () => {
    const cliDir = join(runtimeRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, "cli.js"), [
      "import { createInterface } from 'node:readline';",
      "const rl = createInterface({input: process.stdin});",
      "rl.on('line', (line) => { const command = JSON.parse(line);",
      "if (command.type === 'prompt') { const question = process.env.PI_TEST_SUBAGENT_QUESTION === '1'; const request = question ? {type:'extension_ui_request', id:'child-question-1', method:'select', title:'Child question', options:['Yes','No']} : {type:'extension_ui_request', id:'child-permission-1', method:'confirm', title:'Child permission', message:'Allow edit?'}; process.stdout.write(JSON.stringify(request)+'\\n'); }",
      "if (command.type === 'extension_ui_response') { const text = process.env.PI_TEST_SUBAGENT_QUESTION === '1' ? 'selected:' + command.value : (command.confirmed ? 'approved' : 'denied'); process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text}], stopReason:'stop', model:'test/child'}})+'\\n'); process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n'); } });",
    ].join("\n"), "utf8");

    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    worker.send({ id: "subagent-ui", type: "prompt", message: "subagent-ui", permissionMode: "ask" });
    const request = await worker.waitFor((message) => message.type === "extension_ui_request" && (message.request as Record<string, unknown>)?.source === "pi-subagent");
    expect(request.request).toMatchObject({
      method: "confirm",
      source: "pi-subagent",
      subagentAgent: "worker",
      subagentTask: "检查认证逻辑",
    });

    worker.send({
      id: "subagent-ui-response",
      type: "uiResponse",
      response: {
        id: String((request.request as Record<string, unknown>).id),
        confirmed: true,
      },
    });
    await worker.waitFor((message) => message.type === "ui_response_done" && message.id === "subagent-ui-response");
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "subagent-ui");

    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "tool_execution_end",
      toolName: "subagent",
      result: expect.objectContaining({
        results: [expect.objectContaining({ output: "approved", model: "test/child", exitCode: 0 })],
      }),
    }));
  }, 20_000);

  it("routes a child subagent question through the parent questionnaire protocol", async () => {
    const cliDir = join(runtimeRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, "cli.js"), [
      "import { createInterface } from 'node:readline';",
      "const rl = createInterface({input: process.stdin});",
      "rl.on('line', (line) => { const command = JSON.parse(line);",
      "if (command.type === 'prompt') { const question = process.env.PI_TEST_SUBAGENT_QUESTION === '1'; const request = question ? {type:'extension_ui_request', id:'child-question-1', method:'select', title:'Child question', options:['Yes','No']} : {type:'extension_ui_request', id:'child-permission-1', method:'confirm', title:'Child permission', message:'Allow edit?'}; process.stdout.write(JSON.stringify(request)+'\\n'); }",
      "if (command.type === 'extension_ui_response') { const text = process.env.PI_TEST_SUBAGENT_QUESTION === '1' ? 'selected:' + command.value : (command.confirmed ? 'approved' : 'denied'); process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text}], stopReason:'stop', model:'test/child'}})+'\\n'); process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n'); } });",
    ].join("\n"), "utf8");

    const worker = startWorker(runtimeRoot, agentDir, { PI_TEST_SUBAGENT_QUESTION: "1" });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    worker.send({ id: "subagent-question", type: "prompt", message: "subagent-ui", permissionMode: "ask" });
    const request = await worker.waitFor((message) => message.type === "extension_ui_request" && (message.request as Record<string, unknown>)?.source === "pi-subagent");
    expect(request.request).toMatchObject({
      method: "select",
      source: "pi-subagent",
      subagentAgent: "worker",
      subagentTask: "检查认证逻辑",
      options: ["Yes", "No"],
    });

    worker.send({
      id: "subagent-question-response",
      type: "uiResponse",
      response: {
        id: String((request.request as Record<string, unknown>).id),
        value: "Yes",
      },
    });
    await worker.waitFor((message) => message.type === "ui_response_done" && message.id === "subagent-question-response");
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "subagent-question");

    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "tool_execution_end",
      toolName: "subagent",
      result: expect.objectContaining({
        results: [expect.objectContaining({ output: "selected:Yes", model: "test/child", exitCode: 0 })],
      }),
    }));
  }, 20_000);

  it("uses Pi's tool_call hook for Hpp permission approval", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    worker.send({ id: "auto-edit", type: "prompt", message: "permission-edit", permissionMode: "auto" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "auto-edit");
    expect(worker.messages).not.toContainEqual(expect.objectContaining({ type: "extension_ui_request" }));

    worker.send({ id: "ask-edit", type: "prompt", message: "permission-edit", permissionMode: "ask" });
    const request = await worker.waitFor((message) => message.type === "extension_ui_request");
    expect(request.request).toMatchObject({ method: "confirm", title: "Pi 请求权限" });
    worker.send({
      id: "deny-edit",
      type: "uiResponse",
      response: {
        id: String((request.request as { id?: unknown }).id || ""),
        cancelled: false,
        confirmed: false,
      },
    });
    const resultMessage = await worker.waitFor((message) =>
      message.type === "message_end" && String((message.message as { text?: unknown })?.text || "").includes("block"));
    expect(JSON.parse(String((resultMessage.message as { text?: unknown }).text))).toMatchObject({
      block: true,
      reason: "用户拒绝了该操作",
    });
  });

  it("lists native resources and expands selected skills with Pi slash syntax", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "actions", type: "listActions", reload: true });
    await expect(worker.waitFor((message) => message.type === "actions" && message.id === "actions"))
      .resolves.toMatchObject({
        actions: [
          { kind: "skill", name: "review", description: "Review changes" },
          { kind: "command", name: "release", description: "Prepare release", argumentHint: "[version]" },
          { kind: "command", name: "implement", description: "scout 调查、planner 规划、worker 在隔离上下文中实施完整任务" },
          { kind: "command", name: "scout-and-plan", description: "先由 scout 调查代码库，再由 planner 制定计划，不执行修改" },
          { kind: "command", name: "implement-and-review", description: "worker 实施、reviewer 审查、worker 根据反馈修正" },
          { kind: "command", name: "inspect", description: "Inspect project" },
          // Hpp 客户端命令总是排在末尾（扩展可用同名命令覆盖它）。
          { kind: "command", name: "compact", description: "手动压缩当前会话上下文", argumentHint: "[补充说明]" },
        ],
      });
    worker.send({
      id: "skill-prompt",
      type: "prompt",
      message: "src",
      action: { kind: "skill", name: "review" },
      permissionMode: "full-access",
    });
    await expect(worker.waitFor((message) => message.type === "message_end" && (message.message as { text?: unknown })?.text === "/skill:review src"))
      .resolves.toMatchObject({ type: "message_end" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "skill-prompt");
    worker.send({
      id: "workflow-prompt",
      type: "prompt",
      message: "重构认证模块",
      action: { kind: "command", name: "scout-and-plan" },
      permissionMode: "full-access",
    });
    await expect(worker.waitFor((message) => message.type === "message_end" && (message.message as { text?: unknown })?.text === "/scout-and-plan 重构认证模块"))
      .resolves.toMatchObject({ type: "message_end" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "workflow-prompt");
    worker.send({ id: "missing-skill", type: "prompt", message: "", action: { kind: "skill", name: "missing" } });
    await expect(worker.waitFor((message) => message.type === "error" && message.id === "missing-skill"))
      .resolves.toMatchObject({ error: "ACTION_NOT_FOUND: missing" });
  }, 15_000);

  it("lists commands from the SDK command runner and exposes the Hpp compact action", async () => {
    const worker = startWorker(runtimeRoot, agentDir, {
      PI_TEST_REGISTERED_COMMANDS: JSON.stringify([
        { name: "deploy", invocationName: "deploy", description: "Deploy the app" },
        { name: "probe", invocationName: "probe:2", description: "Second probe" },
      ]),
    });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "actions", type: "listActions" });
    const actionsMessage = await worker.waitFor((message) => message.type === "actions" && message.id === "actions");
    expect(actionsMessage.actions).toEqual(expect.arrayContaining([
      { kind: "command", name: "deploy", description: "Deploy the app" },
      // 重名命令以 invocationName（name:2）作为可调用名字。
      { kind: "command", name: "probe:2", description: "Second probe" },
      // Hpp 客户端命令：Pi 内置斜杠命令只在它自己的 TUI 里实现。
      { kind: "command", name: "compact", description: "手动压缩当前会话上下文", argumentHint: "[补充说明]" },
    ]));
  });

  it("runs the compact action through the Pi session instead of prompting the model", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "compact", type: "prompt", message: "把测试细节压缩掉", action: { kind: "command", name: "compact" } });
    // fake session 的 compact() 回显指令 → 证明走的是 session.compact 而非 session.prompt。
    await expect(worker.waitFor((message) => message.type === "message_end"))
      .resolves.toMatchObject({ message: { text: "compacted:把测试细节压缩掉" } });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact");
  });

  it("prefers a Pi extension command over the Hpp client action with the same name", async () => {
    const worker = startWorker(runtimeRoot, agentDir, {
      PI_TEST_REGISTERED_COMMANDS: JSON.stringify([
        { name: "compact", invocationName: "compact", description: "Extension compact" },
      ]),
    });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "compact", type: "prompt", message: "keep", action: { kind: "command", name: "compact" } });
    // 扩展注册了同名命令 → 交给 Pi 原生命令分发（消息以 /compact 文本进入 prompt）。
    await expect(worker.waitFor((message) => message.type === "message_end"))
      .resolves.toMatchObject({ message: { text: "/compact keep" } });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "compact");
  });
});
