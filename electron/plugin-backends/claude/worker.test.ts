import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createServer } from "http";
import { createInterface } from "readline";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type WorkerMessage = Record<string, unknown>;

const fakeSDKSource = `
const persistedSessions = new Set(["history-session"]);
let subagentReadCount = 0;

class FakeQuery {
  constructor(prompt, options) {
    if (options.model === "invalid-model") {
      throw new Error("Unable to validate model: undefined is not an object (evaluating 'Js.usage.input_tokens')");
    }
    if (options.resume && !persistedSessions.has(options.resume)) {
      throw new Error(\`No conversation found with session ID: \${options.resume}\`);
    }
    this.options = options;
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    this.transportReady = false;
    this.permissionMode = options.permissionMode;
    this.model = options.model;
    this.sessionId = options.sessionId || (options.forkSession ? "forked-session" : options.resume || "generated-session");
    this.enqueue({ type: "system", subtype: "init", session_id: this.sessionId, uuid: "init-1" });
    void this.consume(prompt);
  }
  enqueue(value) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.messages.push(value);
  }
  next() {
    if (this.messages.length) return Promise.resolve({ value: this.messages.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  [Symbol.asyncIterator]() { return this; }
  async consume(prompt) {
    for await (const user of prompt) {
      this.transportReady = true;
      persistedSessions.add(this.sessionId);
      const commandUuid = user.uuid || "generated-command";
      this.enqueue({ type: "command_lifecycle", command_uuid: commandUuid, state: "queued", uuid: "lifecycle-queued-" + commandUuid, session_id: this.sessionId });
      this.enqueue({ type: "command_lifecycle", command_uuid: commandUuid, state: "started", uuid: "lifecycle-started-" + commandUuid, session_id: this.sessionId });
      const content = Array.isArray(user.message.content) ? user.message.content : [];
      const text = content.filter((part) => part.type === "text").map((part) => part.text).join("");
      const imageCount = content.filter((part) => part.type === "image").length;
      if (text === "disconnect") {
        this.close();
        continue;
      } else if (text === "model-validation-failed") {
        this.enqueue({ type: "result", subtype: "error_during_execution", is_error: true, uuid: "result-" + commandUuid, session_id: this.sessionId, usage: {}, total_cost_usd: 0, result: "Unable to validate model: undefined is not an object (evaluating 'Js.usage.input_tokens')" });
        continue;
      } else if (text === "ask") {
        const input = { questions: [{ question: "Which agent?", header: "Agent", multiSelect: false, options: [{ label: "Pi", description: "Pi" }, { label: "Claude", description: "Claude" }] }] };
        const decision = await this.options.canUseTool("AskUserQuestion", input, { toolUseID: "ask-1", signal: new AbortController().signal });
        const answer = JSON.stringify(decision.updatedInput?.answers || {});
        this.enqueue({ type: "assistant", uuid: "assistant-ask", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: answer }] } });
      } else if (text === "approve") {
        const decision = await this.options.canUseTool("ExitPlanMode", { plan: "Implement it" }, { toolUseID: "approve-1", title: "Execute plan?", signal: new AbortController().signal });
        this.enqueue({ type: "assistant", uuid: "assistant-approve", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: decision.behavior }] } });
      } else if (text === "edit") {
        this.enqueue({ type: "assistant", uuid: "assistant-tool", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Edit", input: { file_path: "src/a.ts" } }] } });
        this.enqueue({ type: "user", uuid: "tool-result", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] }, tool_use_result: { filePath: "src/a.ts", gitDiff: { filename: "src/a.ts", additions: 1, deletions: 1, patch: "--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1 +1 @@\\n-old\\n+new" } } });
        this.enqueue({ type: "assistant", uuid: "assistant-edit", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "edited" }] } });
      } else if (text === "subagents") {
        this.enqueue({ type: "assistant", uuid: "assistant-task", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id: "task-tool-1", name: "Task", input: { description: "Inspect backend", prompt: "Inspect the backend.", subagent_type: "explore" } }] } });
        this.enqueue({ type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "task-tool-1", task_type: "explore", description: "Inspect backend", prompt: "Inspect the backend.", session_id: this.sessionId });
        this.enqueue({ type: "assistant", uuid: "assistant-child", session_id: this.sessionId, parent_tool_use_id: "task-tool-1", message: { role: "assistant", content: [{ type: "text", text: "child text must stay out of the parent stream" }] } });
        this.enqueue({ type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: "task-tool-1", status: "completed", total_tokens: 42, session_id: this.sessionId });
        this.enqueue({ type: "user", uuid: "task-result", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "task-tool-1", content: JSON.stringify({ description: "Inspect backend", prompt: "Inspect the backend.", subagent_type: "explore" }) }] }, tool_use_result: { agentId: "agent-1", agentType: "explore", status: "completed" } });
      } else if (text === "subagents-no-result") {
        const input = { description: "No result task", prompt: "Return a marker.", subagent_type: "explore" };
        this.enqueue({ type: "assistant", uuid: "assistant-task-empty", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id: "task-tool-empty", name: "Task", input }] } });
        this.enqueue({ type: "user", uuid: "task-result-empty", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "task-tool-empty", content: JSON.stringify(input) }] }, tool_use_result: { agentId: "agent-empty", agentType: "explore", status: "completed" } });
      } else if (text === "background-bash") {
        // 超过 60s 被挪到后台的 Bash：Claude 会照常发 local_bash 的 task_started /
        // task_notification（TaskStop 后是 stopped）。它不是子 Agent。
        this.enqueue({ type: "assistant", uuid: "assistant-bash", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id: "bash-tool-1", name: "Bash", input: { command: "grep -rn hppPresentExtension" } }] } });
        this.enqueue({ type: "system", subtype: "task_started", task_id: "bash-task-1", tool_use_id: "bash-tool-1", task_type: "local_bash", description: "确认 present 扩展引用并定位 pi SDK 安装", session_id: this.sessionId });
        this.enqueue({ type: "system", subtype: "task_notification", task_id: "bash-task-1", tool_use_id: "bash-tool-1", status: "stopped", session_id: this.sessionId });
        this.enqueue({ type: "user", uuid: "bash-result", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-tool-1", content: "Command did not complete within its 60s timeout" }] }, tool_use_result: { stdout: "", stderr: "", interrupted: false } });
      } else if (text === "usage-progress") {
        // 一条响应会被拆成多帧（thinking / text / tool_use），每帧带同一份 usage。
        const frame = (messageId, block, usage) => this.enqueue({
          type: "assistant",
          uuid: messageId + "-" + block.type,
          session_id: this.sessionId,
          parent_tool_use_id: null,
          message: { id: messageId, role: "assistant", usage, content: [block] },
        });
        frame("msg-u1", { type: "thinking", thinking: "plan" }, { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 10 });
        frame("msg-u1", { type: "text", text: "first" }, { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 10 });
        frame("msg-u2", { type: "text", text: "second" }, { input_tokens: 160, cache_read_input_tokens: 40, output_tokens: 20 });
        // 整轮累计（含子 Agent 的消耗）比逐条之和多 100 输入 / 20 输出。
        this.resultUsage = { input_tokens: 400, cache_read_input_tokens: 40, output_tokens: 50 };
      } else if (text === "env") {
        const managedProvider = this.options.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
        this.enqueue({ type: "assistant", uuid: "assistant-env", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: managedProvider }] } });
      } else if (text === "adapter-env") {
        const details = JSON.stringify({
          local: String(this.options.env.ANTHROPIC_BASE_URL).startsWith("http://127.0.0.1:"),
          isolated: this.options.env.ANTHROPIC_AUTH_TOKEN !== "secret-key",
        });
        this.enqueue({ type: "assistant", uuid: "assistant-adapter-env", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: details }] } });
      } else if (text === "session-mode") {
        const details = JSON.stringify({ resume: this.options.resume, sessionId: this.options.sessionId });
        this.enqueue({ type: "assistant", uuid: "assistant-session-mode", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: details }] } });
      } else if (text === "system-prompt") {
        this.enqueue({ type: "assistant", uuid: "assistant-system-prompt", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(this.options.systemPrompt) }] } });
      } else if (text === "compact") {
        this.enqueue({ type: "system", subtype: "compact_boundary", uuid: "compact-1", session_id: this.sessionId });
        this.enqueue({ type: "assistant", uuid: "assistant-compact", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "compacted" }] } });
      } else if (text === "guidance-old") {
        this.enqueue({ type: "stream_event", uuid: "stream-old", session_id: this.sessionId, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "old tail" } } });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
        this.enqueue({ type: "assistant", uuid: "assistant-old", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "old tail" }] } });
      } else if (text === "steer this turn") {
        const details = "guided:" + user.priority + ":" + user.uuid;
        this.enqueue({ type: "stream_event", uuid: "stream-guided", session_id: this.sessionId, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: details } } });
        this.enqueue({ type: "assistant", uuid: "assistant-guided", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: details }] } });
      } else if (text.startsWith("/review")) {
        this.enqueue({ type: "assistant", uuid: "assistant-action", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }] } });
      } else {
        this.enqueue({ type: "stream_event", uuid: "stream-1", session_id: this.sessionId, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: imageCount ? "image:1" : "hello" } } });
        this.enqueue({ type: "assistant", uuid: "assistant-1", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: imageCount ? "image:1" : "hello" }] } });
      }
      this.enqueue({ type: "result", subtype: "success", is_error: false, uuid: "result-" + commandUuid, session_id: this.sessionId, usage: this.resultUsage || {}, total_cost_usd: 0 });
      this.enqueue({ type: "command_lifecycle", command_uuid: commandUuid, state: "completed", uuid: "lifecycle-completed-" + commandUuid, session_id: this.sessionId });
    }
  }
  async interrupt() {}
  async setModel(model) {
    if (model === "invalid-model") throw new Error("Unable to validate model: undefined is not an object (evaluating 'Js.usage.input_tokens')");
    this.model = model;
  }
  async setPermissionMode(mode) {
    if (!this.transportReady) throw new Error("ProcessTransport is not ready for writing");
    this.permissionMode = mode;
  }
  async supportedCommands() { return [{ name: "review", description: "Review changes", argumentHint: "[scope]" }]; }
  async reloadSkills() { return { skills: [{ name: "review", description: "Review changes", argumentHint: "[scope]" }] }; }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

// 默认不挂 getContextUsage，模拟"老版本 SDK 没有这个接口"；
// 打开后按 mode 模拟：both=两档都支持，summary-only=只支持 summary，
// 并把实际被请求的 detail 编进分类名，让测试能从 worker 输出里读回来。
const contextUsageMode = process.env.CLAUDE_FAKE_CONTEXT_USAGE;
if (contextUsageMode) {
  FakeQuery.prototype.getContextUsage = async function (opts) {
    const detail = (opts && opts.detail) || "full";
    if (contextUsageMode === "unsupported") throw new Error("get_context_usage is not supported");
    if (contextUsageMode === "summary-only" && detail !== "summary") throw new Error("detail full is not supported");
    return {
      categories: [
        { name: "detail:" + detail, tokens: 70000, color: "#6b8afd", kind: "used" },
        { name: "Messages", tokens: 0, color: "#3ecf8e", kind: "used" },
        { name: "Free space", tokens: 130000, color: "#888888", kind: "free" },
        { name: "Compaction buffer", tokens: 30000, color: "#f5a623", kind: "buffer" },
      ],
      totalTokens: 70000,
      maxTokens: 200000,
      rawMaxTokens: 184000,
      percentage: 35,
    };
  };
}

export const query = ({ prompt, options }) => new FakeQuery(prompt, options);
export const getSubagentMessages = async (_sessionId, agentId) => {
  if (agentId !== "agent-1" && agentId !== "task-1") return [];
  subagentReadCount += 1;
  return subagentReadCount >= 3 ? [
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "HPP_SUBAGENT_RESULT" }] } },
  ] : [];
};
export const getSessionInfo = async (sessionId) => sessionId === "history-session" ? { sessionId } : undefined;
export const getSessionMessages = async (sessionId) => sessionId === "history-session" ? [
  { type: "user", uuid: "history-user", session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null, message: { role: "user", content: [{ type: "text", text: "old question" }] } },
  { type: "assistant", uuid: "history-assistant", session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null, message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } },
] : [];
`;

const providerConfig = {
  providers: [{
    providerId: "anthropic",
    displayName: "Anthropic",
    baseUrl: "https://gateway.example.com/v1",
    apiKey: "secret-key",
    authMode: "x-api-key",
    endpoint: "anthropic-messages",
    models: [{ id: "claude-test", name: "Claude Test", reasoning: true, imageInput: true }],
  }],
};

async function writeFakeSDK(runtimeRoot: string, version = "7.8.9", nativeVersion = version) {
  const packageDir = join(runtimeRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({
    name: "@anthropic-ai/claude-agent-sdk",
    version,
    type: "module",
    exports: { ".": { import: "./index.mjs" } },
  }), "utf8");
  await writeFile(join(packageDir, "index.mjs"), fakeSDKSource, "utf8");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  let nativePackageName = `claude-agent-sdk-${process.platform}-${arch}`;
  if (process.platform === "linux") {
    let musl = false;
    try { musl = !process.report?.getReport?.().header?.glibcVersionRuntime; } catch { /* use glibc */ }
    nativePackageName = `claude-agent-sdk-linux-${arch}${musl ? "-musl" : ""}`;
  }
  const nativePackageDir = join(runtimeRoot, "node_modules", "@anthropic-ai", nativePackageName);
  await mkdir(nativePackageDir, { recursive: true });
  await Promise.all([
    writeFile(join(nativePackageDir, "package.json"), JSON.stringify({ version: nativeVersion })),
    writeFile(join(nativePackageDir, process.platform === "win32" ? "claude.exe" : "claude"), "binary"),
  ]);
}

function startWorker(runtimeRoot: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [resolve("electron/plugin-backends/claude/worker.mjs")], {
    env: { ...process.env, CLAUDE_AGENT_SDK_PACKAGE_ROOT: runtimeRoot, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: WorkerMessage[] = [];
  const waiters: Array<{
    predicate: (message: WorkerMessage) => boolean;
    resolve: (message: WorkerMessage) => void;
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
  const waitFor = (predicate: (message: WorkerMessage) => boolean, timeoutMs = 4000) =>
    new Promise<WorkerMessage>((resolvePromise, reject) => {
      const existing = messages.find(predicate);
      if (existing) { resolvePromise(existing); return; }
      const waiter = {
        predicate,
        resolve: resolvePromise,
        timeout: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Claude worker response timed out"));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  const send = (message: WorkerMessage) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return { child, messages, waitFor, send };
}

async function stopWorker(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  child.stdin.write(`${JSON.stringify({ id: "dispose", type: "dispose" })}\n`);
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => { child.kill(); resolvePromise(); }, 1000);
    child.once("exit", () => { clearTimeout(timeout); resolvePromise(); });
  });
}

describe("Claude Agent SDK worker", () => {
  let tempRoot = "";
  let runtimeRoot = "";
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hpp-claude-worker-"));
    runtimeRoot = join(tempRoot, "runtime");
    await writeFakeSDK(runtimeRoot);
  });

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stopWorker));
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function initialize(
    sessionFilePath = "new-session",
    isNewSession = true,
    config = providerConfig,
    extraEnv: NodeJS.ProcessEnv = {},
    hostSystemPrompt?: string,
  ) {
    const worker = startWorker(runtimeRoot, extraEnv);
    children.push(worker.child);
    worker.send({
      id: "init",
      type: "init",
      projectPath: tempRoot,
      sessionFilePath,
      isNewSession,
      config,
      hostSystemPrompt,
    });
    await worker.waitFor((message) => message.type === "ready");
    return worker;
  }

  it("accepts any complete SDK version without a hard-coded allowlist", async () => {
    await writeFakeSDK(runtimeRoot, "7.9.0");
    const worker = await initialize();
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: "ready" }));
  });

  it("reports the SDK's precise context usage and drops non-occupied rows", async () => {
    const worker = await initialize("new-session", true, providerConfig, { CLAUDE_FAKE_CONTEXT_USAGE: "both" });
    worker.send({ id: "prompt-ctx", type: "prompt", message: "hello", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-ctx");

    const usage = await worker.waitFor((message) => message.type === "context_usage");
    expect(usage.contextTokens).toBe(70000);
    // maxTokens 才是与 CLI 百分比同口径的有效上限，不是裸窗口 rawMaxTokens。
    expect(usage.contextWindow).toBe(200000);
    // full 才是逐类 count_tokens 数出来的真值，两档都可用时不能退而求其次用 summary。
    expect(usage.precision).toBe("exact");
    // free/buffer 不是"已占用"，不能算进明细（否则色条会假性占满）。
    expect((usage.breakdown as Array<{ label: string }>).map((entry) => entry.label)).toEqual(["detail:full"]);
  });

  it("surfaces the channel's own error when the SDK only reports a model-validation failure", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "此密钥总token已耗尽" }));
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const config = {
        providers: [{
          providerId: "gateway",
          displayName: "Gateway",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "secret-key",
          authMode: "x-api-key",
          endpoint: "anthropic-messages",
          models: [{ id: "claude-test", name: "Claude Test", reasoning: true, imageInput: true }],
        }],
      };
      const worker = await initialize("new-session", true, config);
      worker.send({ id: "prompt-channel-error", type: "prompt", message: "model-validation-failed", permissionMode: "auto" });

      // CLI 只留下一句 "Unable to validate model ..."，但实情是渠道额度耗尽：
      // 错误里必须带上渠道自己的文案，而不是让用户去看 usage.input_tokens。
      const error = await worker.waitFor(
        (message) => message.type === "error" && message.id === "prompt-channel-error",
        8000,
      );
      expect(error.error).toContain("渠道返回：此密钥总token已耗尽");
      expect(error.error).not.toContain("usage.input_tokens");

      // 切模型必须纯本地：只回 model_changed，不发请求、不报错。
      worker.send({ id: "set-model-lazy", type: "setModel", provider: "gateway", modelId: "invalid-model", config });
      await expect(worker.waitFor((message) => message.type === "model_changed" && message.id === "set-model-lazy"))
        .resolves.toMatchObject({ type: "model_changed" });
      expect(worker.messages.some((message) => message.type === "error" && message.id === "set-model-lazy")).toBe(false);

      // 真正发消息时才应用新模型，并把渠道原文报在聊天里。
      worker.send({ id: "prompt-after-switch", type: "prompt", message: "hello", permissionMode: "auto" });
      const switchError = await worker.waitFor(
        (message) => message.type === "error" && message.id === "prompt-after-switch",
        8000,
      );
      expect(switchError.error).toContain("渠道返回：此密钥总token已耗尽");
      expect(switchError.error).not.toContain("usage.input_tokens");
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("falls back to summary with an estimated precision, and stays silent without the API", async () => {
    const summaryOnly = await initialize("summary-only-session", true, providerConfig, { CLAUDE_FAKE_CONTEXT_USAGE: "summary-only" });
    summaryOnly.send({ id: "prompt-ctx-summary", type: "prompt", message: "hello", permissionMode: "full-access" });
    const usage = await summaryOnly.waitFor((message) => message.type === "context_usage");
    expect((usage.breakdown as Array<{ label: string }>)[0].label).toBe("detail:summary");
    // summary 是本地估算，精度必须跟着降级，否则会拿估算冒充精确统计。
    expect(usage.precision).toBe("estimated");

    const legacy = await initialize("legacy-session");
    legacy.send({ id: "prompt-ctx-legacy", type: "prompt", message: "hello", permissionMode: "full-access" });
    await legacy.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-ctx-legacy");
    expect(legacy.messages.some((message) => message.type === "context_usage")).toBe(false);
  });

  it("rejects mismatched native SDK versions", async () => {
    await writeFakeSDK(runtimeRoot, "7.9.0", "7.8.9");
    const worker = startWorker(runtimeRoot);
    children.push(worker.child);
    worker.send({
      id: "init-mismatched-sdk",
      type: "init",
      projectPath: tempRoot,
      sessionFilePath: "new-session",
      isNewSession: true,
      config: providerConfig,
    });
    await expect(worker.waitFor((message) => message.type === "error"))
      .resolves.toMatchObject({ type: "error", id: "init-mismatched-sdk" });
  });

  it("streams text and image prompts with native turn ids", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-1", type: "prompt", message: "photo", images: [{ data: "aW1hZ2U=", mimeType: "image/png" }], permissionMode: "full-access" });
    await expect(worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-1"))
      .resolves.toMatchObject({ type: "prompt_done" });
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "image:1" }));
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: "message_end", nativeTurnId: "assistant-1" }));
    expect(JSON.stringify(worker.messages)).not.toContain("secret-key");
  });

  it("forwards Claude Task lifecycle metadata and suppresses child assistant text", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-subagents", type: "prompt", message: "subagents", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-subagents");
    await worker.waitFor((message) => message.type === "subagent_update" && message.result === "HPP_SUBAGENT_RESULT");

    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "subagent_started",
      toolUseId: "task-tool-1",
      taskId: "task-1",
    }));
    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "subagent_update",
      toolUseId: "task-tool-1",
      taskId: "task-1",
      status: "completed",
      result: "HPP_SUBAGENT_RESULT",
    }));
    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "tool_execution_end",
      toolUseId: "task-tool-1",
      toolUseResult: expect.objectContaining({ agentId: "agent-1" }),
      output: expect.objectContaining({
        agentId: "agent-1",
        status: "completed",
      }),
    }));
    expect(worker.messages).not.toContainEqual(expect.objectContaining({
      type: "text_delta",
      delta: "child text must stay out of the parent stream",
    }));
  });

  it("does not expose an echoed Task input as the subagent result", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-subagent-empty", type: "prompt", message: "subagents-no-result", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-subagent-empty");

    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "tool_execution_end",
      toolUseId: "task-tool-empty",
      output: expect.not.objectContaining({ content: expect.anything() }),
    }));
  });

  it("reports usage per assistant response and only the remainder at prompt_done", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-usage", type: "prompt", message: "usage-progress", permissionMode: "full-access" });
    const done = await worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-usage");

    // 一帧一份 usage：同一条响应的多帧必须去重，否则 token 会被算好几遍。
    const usages = worker.messages.filter((message) => message.type === "token_usage");
    expect(usages).toEqual([
      expect.objectContaining({ inputTokens: 140, outputTokens: 10, cacheInputTokens: 40, contextTokens: 140 }),
      expect.objectContaining({ inputTokens: 200, outputTokens: 20, cacheInputTokens: 40, contextTokens: 200 }),
    ]);
    // 回合结束只补差值（累计 440/50/40 减已上报 340/30/40），不能整份再发一遍。
    expect(done.usage).toEqual({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 });
    // 上下文占用取最后一条响应的输入长度，不是整回合之和。
    expect(done.contextTokens).toBe(200);
  });

  it("never reports a backgrounded Bash task as a subagent", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-bg-bash", type: "prompt", message: "background-bash", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-bg-bash");

    // local_bash 的 task_started/task_notification 混进来会凭空多一张「子 Agent」卡片，
    // 主 Agent 用 TaskStop 收尾时还会显示「已中断」。
    expect(worker.messages.some((message) => String(message.type).startsWith("subagent_"))).toBe(false);
    // Bash 自己的工具结果照常转发。
    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "tool_execution_end",
      toolUseId: "bash-tool-1",
    }));
  });

  it("steers the active Claude command with a priority-now user message", async () => {
    const worker = await initialize();
    worker.send({
      id: "prompt-guidance",
      type: "prompt",
      message: "guidance-old",
      permissionMode: "full-access",
    });
    await worker.waitFor((message) => message.type === "text_delta" && message.delta === "old tail");

    worker.send({ id: "guidance-1", type: "guidance", message: "steer this turn" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-guidance");

    const oldTailIndex = worker.messages.findIndex((message) => (
      message.type === "text_delta" && message.delta === "old tail"
    ));
    const acceptedIndex = worker.messages.findIndex((message) => (
      message.type === "guidance_done" && message.id === "guidance-1"
    ));
    const deliveredIndex = worker.messages.findIndex((message) => (
      message.type === "guidance_delivered" && message.id === "guidance-1"
    ));
    const guidedIndex = worker.messages.findIndex((message) => (
      message.type === "text_delta" && message.delta === "guided:now:guidance-1"
    ));
    const promptDoneIndexes = worker.messages.flatMap((message, index) => (
      message.type === "prompt_done" && message.id === "prompt-guidance" ? [index] : []
    ));

    expect(oldTailIndex).toBeGreaterThanOrEqual(0);
    expect(acceptedIndex).toBeGreaterThan(oldTailIndex);
    expect(deliveredIndex).toBeGreaterThan(acceptedIndex);
    expect(guidedIndex).toBeGreaterThan(deliveredIndex);
    expect(promptDoneIndexes).toHaveLength(1);
    expect(promptDoneIndexes[0]).toBeGreaterThan(guidedIndex);
  });

  it("rejects guidance without an active Claude command", async () => {
    const worker = await initialize();
    worker.send({ id: "guidance-idle", type: "guidance", message: "steer" });
    await expect(worker.waitFor((message) => message.type === "error" && message.id === "guidance-idle"))
      .resolves.toMatchObject({ error: "SESSION_NOT_RUNNING" });
  });

  it("drops pending guidance when the active Claude query is aborted", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-abort-guidance", type: "prompt", message: "guidance-old", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "text_delta" && message.delta === "old tail");

    worker.send({ id: "guidance-aborted", type: "guidance", message: "steer this turn" });
    worker.send({ id: "abort-guidance", type: "abort" });
    await worker.waitFor((message) => message.type === "aborted" && message.id === "abort-guidance");

    expect(worker.messages).not.toContainEqual(expect.objectContaining({
      type: "guidance_delivered",
      id: "guidance-aborted",
    }));
    worker.send({ id: "prompt-after-guidance-abort", type: "prompt", message: "photo", permissionMode: "full-access" });
    await expect(worker.waitFor((message) => (
      message.type === "prompt_done" && message.id === "prompt-after-guidance-abort"
    ))).resolves.toMatchObject({ type: "prompt_done" });
  });

  it("reports Claude's compact boundary as completed before the prompt settles", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-compact", type: "prompt", message: "compact", permissionMode: "full-access" });

    const compacted = await worker.waitFor((message) => message.type === "context_compaction");
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-compact");

    expect(compacted).toMatchObject({ uuid: "compact-1", phase: "completed" });
    expect(worker.messages.indexOf(compacted)).toBeLessThan(
      worker.messages.findIndex((message) => message.type === "prompt_done" && message.id === "prompt-compact"),
    );
  });

  it("fails the active prompt and exits when the SDK query transport ends", async () => {
    const worker = await initialize();
    const exited = new Promise<number | null>((resolvePromise) => {
      worker.child.once("exit", (code) => resolvePromise(code));
    });

    worker.send({ id: "prompt-disconnect", type: "prompt", message: "disconnect", permissionMode: "full-access" });

    await expect(worker.waitFor((message) => message.type === "error" && message.id === "prompt-disconnect"))
      .resolves.toMatchObject({
        type: "error",
        error: "Claude Agent SDK query ended unexpectedly",
      });
    await expect(exited).resolves.toBe(1);
  });

  it("marks the Hpp provider as host-managed with Claude's boolean flag", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-env", type: "prompt", message: "env", permissionMode: "full-access" });
    await expect(worker.waitFor((message) => message.type === "message_end" && message.nativeTurnId === "assistant-env"))
      .resolves.toMatchObject({ text: "1" });
  });

  it("appends Hpp host policy to Claude's native system preset in Plan mode", async () => {
    const worker = await initialize(
      "new-session",
      true,
      providerConfig,
      {},
      "  [HPP] 始终使用简体中文  ",
    );
    worker.send({
      id: "prompt-system",
      type: "prompt",
      message: "system-prompt",
      permissionMode: "auto",
      planModeEnabled: true,
    });

    const message = await worker.waitFor((item) =>
      item.type === "message_end" && item.nativeTurnId === "assistant-system-prompt");
    const systemPrompt = JSON.parse(String(message.text));
    expect(systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
    });
    // host 策略照常注入，后面追加 Task 标题引导；两条都在。
    expect(String(systemPrompt.append)).toContain("[HPP] 始终使用简体中文");
    expect(String(systemPrompt.append)).toContain("description 填 2~6 字的极简中文标题");
    await expect(worker.waitFor((item) => item.type === "prompt_done" && item.id === "prompt-system"))
      .resolves.toMatchObject({ type: "prompt_done" });
  });

  it("isolates Chat Completions behind a local adapter", async () => {
    const chatConfig = {
      providers: [{ ...providerConfig.providers[0], endpoint: "chat-completions", authMode: "bearer" }],
    };
    const worker = await initialize("chat-session", true, chatConfig);
    worker.send({ id: "prompt-adapter-env", type: "prompt", message: "adapter-env", permissionMode: "full-access" });
    const message = await worker.waitFor((item) => item.type === "message_end" && item.nativeTurnId === "assistant-adapter-env");
    expect(JSON.parse(String(message.text))).toEqual({ local: true, isolated: true });
    expect(JSON.stringify(worker.messages)).not.toContain("secret-key");
  });

  it("maps custom questionnaire answers exactly once", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-ask", type: "prompt", message: "ask", permissionMode: "full-access" });
    const request = await worker.waitFor((message) => message.type === "ui_request");
    worker.send({
      id: "ui-1",
      type: "uiResponse",
      response: {
        id: request.requestId,
        cancelled: false,
        result: { answers: [{ kind: "custom", answer: "Custom agent", label: "Custom agent", wasCustom: true }] },
      },
    });
    await expect(worker.waitFor((message) => message.type === "ui_response_done" && message.id === "ui-1"))
      .resolves.toMatchObject({ type: "ui_response_done", id: "ui-1" });
    const answer = await worker.waitFor((message) => message.type === "message_end" && message.nativeTurnId === "assistant-ask");
    expect(answer.text).toBe('{"Which agent?":"Custom agent"}');
  });

  it("returns an error for a UI response without a matching request", async () => {
    const worker = await initialize();
    worker.send({
      id: "ui-missing",
      type: "uiResponse",
      response: { id: "missing-request", text: "answer" },
    });

    await expect(worker.waitFor((message) => message.type === "error" && message.id === "ui-missing"))
      .resolves.toMatchObject({
        type: "error",
        id: "ui-missing",
        error: "Unknown Claude UI request: missing-request",
      });
  });

  it("routes Plan confirmation through the approval interaction", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-approve", type: "prompt", message: "approve", planModeEnabled: true, permissionMode: "auto" });
    const request = await worker.waitFor((message) => message.type === "ui_request" && message.method === "confirm");
    expect(request).toMatchObject({ toolName: "ExitPlanMode", title: "Execute plan?" });
    worker.send({ id: "ui-approve", type: "uiResponse", response: { id: request.requestId, confirmed: true } });
    await expect(worker.waitFor((message) => message.type === "message_end" && message.nativeTurnId === "assistant-approve"))
      .resolves.toMatchObject({ text: "allow" });
  });

  it("maps Edit git diffs and supports interruption", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-edit", type: "prompt", message: "edit", permissionMode: "full-access" });
    const toolResult = await worker.waitFor((message) => message.type === "tool_execution_end");
    expect(toolResult.output).toMatchObject({
      filePath: "src/a.ts",
      gitDiff: { additions: 1, deletions: 1 },
    });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-edit");

    worker.send({ id: "prompt-ask", type: "prompt", message: "ask", permissionMode: "full-access" });
    await worker.waitFor((message) => message.type === "ui_request");
    worker.send({ id: "abort-1", type: "abort" });
    await expect(worker.waitFor((message) => message.type === "aborted" && message.id === "abort-1"))
      .resolves.toMatchObject({ type: "aborted" });
    worker.send({ id: "prompt-after-abort", type: "prompt", message: "photo", permissionMode: "full-access" });
    await expect(worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-after-abort"))
      .resolves.toMatchObject({ type: "prompt_done" });
  });

  it("restores history and materializes deferred forks", async () => {
    const historyWorker = await initialize("history-session", false);
    const history = await historyWorker.waitFor((message) => message.type === "history_snapshot");
    expect(history.messages).toEqual([
      expect.objectContaining({ role: "user", content: "old question", nativeTurnId: "history-user" }),
      expect.objectContaining({ role: "assistant", content: "old answer", nativeTurnId: "history-assistant" }),
    ]);

    const descriptor = `hpp-claude-fork:v1:${Buffer.from(JSON.stringify({
      sourceSessionId: "history-session",
      targetMessageId: "history-assistant",
      newSessionId: "fork-session-id",
    })).toString("base64url")}`;
    const forkWorker = await initialize(descriptor, false);
    forkWorker.send({ id: "fork-prompt", type: "prompt", message: "continue", permissionMode: "plan" });
    await expect(forkWorker.waitFor((message) => message.type === "session_file_path"))
      .resolves.toMatchObject({ sessionFilePath: "fork-session-id" });
  });

  it("starts a new SDK conversation when a persisted placeholder session does not exist", async () => {
    const worker = await initialize("stale-placeholder-session", false);
    worker.send({ id: "prompt-session-mode", type: "prompt", message: "session-mode", permissionMode: "full-access" });
    const message = await worker.waitFor((item) => item.type === "message_end" && item.nativeTurnId === "assistant-session-mode");
    expect(JSON.parse(String(message.text))).toEqual({ sessionId: "stale-placeholder-session" });
    await expect(worker.waitFor((item) => item.type === "session_file_path"))
      .resolves.toMatchObject({ sessionFilePath: "stale-placeholder-session" });
  });

  it("switches supported thinking levels and rejects minimal", async () => {
    const worker = await initialize();
    worker.send({ id: "thinking-high", type: "setThinkingLevel", level: "high" });
    await expect(worker.waitFor((message) => message.type === "thinking_level_changed" && message.id === "thinking-high"))
      .resolves.toMatchObject({ level: "high" });
    worker.send({ id: "thinking-minimal", type: "setThinkingLevel", level: "minimal" });
    await expect(worker.waitFor((message) => message.type === "error" && message.id === "thinking-minimal"))
      .resolves.toMatchObject({ error: "UNSUPPORTED_THINKING_LEVEL" });
  });

  it("lists SDK commands and executes the selected action with slash syntax", async () => {
    const worker = await initialize();
    worker.send({ id: "actions", type: "listActions", reload: true });
    await expect(worker.waitFor((message) => message.type === "actions" && message.id === "actions"))
      .resolves.toMatchObject({
        actions: [{ kind: "skill", name: "review", description: "Review changes", argumentHint: "[scope]" }],
      });
    worker.send({
      id: "action-prompt",
      type: "prompt",
      message: "src",
      action: { kind: "skill", name: "review" },
      permissionMode: "full-access",
    });
    await expect(worker.waitFor((message) => message.type === "message_end" && message.nativeTurnId === "assistant-action"))
      .resolves.toMatchObject({ text: "/review src" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "action-prompt");
    worker.send({ id: "missing-action", type: "prompt", message: "", action: { kind: "skill", name: "missing" } });
    await expect(worker.waitFor((message) => message.type === "error" && message.id === "missing-action"))
      .resolves.toMatchObject({ error: "ACTION_NOT_FOUND" });
  });
});
