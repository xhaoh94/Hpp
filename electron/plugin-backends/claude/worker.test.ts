import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type WorkerMessage = Record<string, unknown>;

const fakeSDKSource = `
const persistedSessions = new Set(["history-session"]);

class FakeQuery {
  constructor(prompt, options) {
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
      const content = Array.isArray(user.message.content) ? user.message.content : [];
      const text = content.filter((part) => part.type === "text").map((part) => part.text).join("");
      const imageCount = content.filter((part) => part.type === "image").length;
      if (text === "ask") {
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
      } else if (text.startsWith("/review")) {
        this.enqueue({ type: "assistant", uuid: "assistant-action", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }] } });
      } else {
        this.enqueue({ type: "stream_event", uuid: "stream-1", session_id: this.sessionId, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: imageCount ? "image:1" : "hello" } } });
        this.enqueue({ type: "assistant", uuid: "assistant-1", session_id: this.sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: imageCount ? "image:1" : "hello" }] } });
      }
      this.enqueue({ type: "result", subtype: "success", is_error: false, uuid: "result-1", session_id: this.sessionId, usage: {}, total_cost_usd: 0 });
    }
  }
  async interrupt() {}
  async setModel(model) { this.model = model; }
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

export const query = ({ prompt, options }) => new FakeQuery(prompt, options);
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

async function writeFakeSDK(runtimeRoot: string) {
  const packageDir = join(runtimeRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({
    name: "@anthropic-ai/claude-agent-sdk",
    version: "0.3.215",
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
    writeFile(join(nativePackageDir, "package.json"), JSON.stringify({ version: "0.3.215" })),
    writeFile(join(nativePackageDir, process.platform === "win32" ? "claude.exe" : "claude"), "binary"),
  ]);
}

function startWorker(runtimeRoot: string) {
  const child = spawn(process.execPath, [resolve("electron/plugin-backends/claude/worker.mjs")], {
    env: { ...process.env, CLAUDE_AGENT_SDK_PACKAGE_ROOT: runtimeRoot },
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

  async function initialize(sessionFilePath = "new-session", isNewSession = true, config = providerConfig) {
    const worker = startWorker(runtimeRoot);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot, sessionFilePath, isNewSession, config });
    await worker.waitFor((message) => message.type === "ready");
    return worker;
  }

  it("streams text and image prompts with native turn ids", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-1", type: "prompt", message: "photo", images: [{ data: "aW1hZ2U=", mimeType: "image/png" }], permissionMode: "full-access" });
    await expect(worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-1"))
      .resolves.toMatchObject({ type: "prompt_done" });
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "image:1" }));
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: "message_end", nativeTurnId: "assistant-1" }));
    expect(JSON.stringify(worker.messages)).not.toContain("secret-key");
  });

  it("marks the Hpp provider as host-managed with Claude's boolean flag", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-env", type: "prompt", message: "env", permissionMode: "full-access" });
    await expect(worker.waitFor((message) => message.type === "message_end" && message.nativeTurnId === "assistant-env"))
      .resolves.toMatchObject({ text: "1" });
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
    const answer = await worker.waitFor((message) => message.type === "message_end" && message.nativeTurnId === "assistant-ask");
    expect(answer.text).toBe('{"Which agent?":"Custom agent"}');
  });

  it("routes Plan confirmation through the approval interaction", async () => {
    const worker = await initialize();
    worker.send({ id: "prompt-approve", type: "prompt", message: "approve", permissionMode: "plan" });
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
