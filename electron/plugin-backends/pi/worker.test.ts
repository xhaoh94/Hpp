import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type WorkerMessage = Record<string, unknown>;

const TEST_HOST_SYSTEM_PROMPT = `[HPP 语言规则]
你是一个编程助手。请始终使用简体中文进行交流和回复。
所有面向用户的自然语言内容都必须使用简体中文，包括可见的思考或推理、计划、进度说明、提问和最终答复。
代码、标识符、文件路径、命令、日志、API 名称和专有名词应保持原文，除非为了说明确有必要翻译。`;

const fakeSDKSource = `
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
  registeredTools = [];
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
    if (message.startsWith("/skill:review")) {
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
    if (message === "compact") {
      this.listener?.({ type: "agent_start" });
      this.listener?.({ type: "compaction_start", reason: "threshold" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      this.listener?.({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: true });
      this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop" } });
      this.listener?.({ type: "agent_end" });
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
export const ModelRuntime = process.env.PI_TEST_BUILTIN_FALLBACK === "1"
  ? { create: async (options = {}) => ({ modelsPath: options.modelsPath }) }
  : undefined;
export class ModelRegistry {
  constructor(runtime) { this.runtime = runtime; }
  getAvailable() {
    return [
      ...availableModels,
      ...(process.env.PI_TEST_BUILTIN_FALLBACK === "1" ? [configuredDeepSeekModel] : []),
      proxyModel,
    ];
  }
  getAll() {
    if (this.runtime?.modelsPath === null) return [builtinDeepSeekModel];
    return [...availableModels, proxyModel];
  }
  find(provider, id) { return availableModels.find((model) => model.provider === provider && model.id === id)
    || (provider === configuredDeepSeekModel.provider && id === configuredDeepSeekModel.id ? configuredDeepSeekModel : undefined)
    || (provider === proxyModel.provider && id === proxyModel.id ? proxyModel : undefined); }
  getError() { return undefined; }
  hasConfiguredAuth() { return true; }
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
export const SettingsManager = { create: () => ({}) };
export class DefaultResourceLoader {
  constructor(options = {}) {
    this.extensionFactories = options.extensionFactories || [];
    this.appendSystemPrompt = options.appendSystemPrompt || [];
  }
  async reload() {}
  getSkills() { return { skills: [{ name: "review", description: "Review changes" }] }; }
  getPrompts() { return { prompts: [{ name: "release", description: "Prepare release", usage: "[version]" }] }; }
  getExtensions() {
    return {
      extensions: [
        { path: "<inline:1>", handlers: new Map([["tool_call", [() => undefined]]]) },
        { commands: [{ name: "inspect", description: "Inspect project" }] },
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
    })]));
    // Every registry model (not just the active one) exposes its own levels.
    expect(modelsMessage.models).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "gpt-5.6-luna",
      supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
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
    })]));
  });

  it("normalizes implicit OpenAI Responses thinking at the provider hook boundary", async () => {
    const worker = startWorker(runtimeRoot, agentDir);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    worker.send({
      id: "luna-model",
      type: "setModel",
      provider: "luna",
      modelId: "gpt-5.6-luna",
    });
    await worker.waitFor((message) => message.type === "model_changed" && message.id === "luna-model");

    worker.send({ id: "luna-models", type: "getModels" });
    const lunaModelsMessage = await worker.waitFor((message) => message.id === "luna-models");
    expect(lunaModelsMessage.models).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "gpt-5.6-luna",
      supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    })]));

    const runProviderPayload = async (id: string, payload: Record<string, unknown>) => {
      worker.send({
        id,
        type: "prompt",
        message: `provider-payload:${JSON.stringify(payload)}`,
        permissionMode: "full-access",
      });
      await worker.waitFor((message) => message.type === "prompt_done" && message.id === id);
      const message = worker.messages.filter((item) => item.type === "message_end").at(-1);
      return JSON.parse(String((message?.message as { text?: unknown })?.text || "null")) as Record<string, unknown>;
    };

    worker.send({ id: "minimal-level", type: "setThinkingLevel", level: "minimal" });
    await worker.waitFor((message) => message.id === "minimal-level");
    await expect(runProviderPayload("minimal", {
      model: "gpt-5.6-luna",
      reasoning: { effort: "high", summary: "auto" },
    })).resolves.toEqual({
      model: "gpt-5.6-luna",
      reasoning: { effort: "low", summary: "auto" },
    });

    worker.send({ id: "off-level", type: "setThinkingLevel", level: "off" });
    await worker.waitFor((message) => message.id === "off-level");
    await expect(runProviderPayload("off", {
      model: "gpt-5.6-luna",
      reasoning: { effort: "high" },
      include: ["reasoning.encrypted_content", "output_text"],
    })).resolves.toEqual({
      model: "gpt-5.6-luna",
      include: ["output_text"],
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
          { kind: "command", name: "inspect", description: "Inspect project" },
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
    worker.send({ id: "missing-skill", type: "prompt", message: "", action: { kind: "skill", name: "missing" } });
    await expect(worker.waitFor((message) => message.type === "error" && message.id === "missing-skill"))
      .resolves.toMatchObject({ error: "ACTION_NOT_FOUND: missing" });
  }, 15_000);
});
