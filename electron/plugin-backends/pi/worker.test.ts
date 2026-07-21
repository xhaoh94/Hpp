import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type WorkerMessage = Record<string, unknown>;

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
  activeTools = ["read", "ask_user_question"];

  constructor(sessionManager, modelRegistry) {
    this.sessionManager = sessionManager;
    this.modelRegistry = modelRegistry;
  }

  async bindExtensions({ uiContext }) { this.uiContext = uiContext; }
  subscribe(listener) { this.listener = listener; return () => { this.listener = null; }; }
  getActiveToolNames() { return [...this.activeTools]; }
  setActiveToolsByName(names) { this.activeTools = [...names]; }
  getAllTools() { return this.activeTools.map((name) => ({ name })); }
  setThinkingLevel() {}
  async setModel() {}
  async steer() {}
  dispose() {}

  prompt(message) {
    this.activeRun = this.runPrompt(message).finally(() => { this.activeRun = null; });
    return this.activeRun;
  }

  async runPrompt(message) {
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
export const ModelRegistry = { create: () => ({
  getAvailable: () => [],
  find: () => undefined,
  getError: () => undefined,
  hasConfiguredAuth: () => true,
}) };
export const SettingsManager = { create: () => ({}) };
export class DefaultResourceLoader {
  async reload() {}
  getSkills() { return { skills: [{ name: "review", description: "Review changes" }] }; }
  getPrompts() { return { prompts: [{ name: "release", description: "Prepare release", usage: "[version]" }] }; }
  getExtensions() { return { extensions: [{ commands: [{ name: "inspect", description: "Inspect project" }] }] }; }
}
export const SessionManager = FakeSessionManager;
export const createAgentSession = async ({ sessionManager, modelRegistry }) => ({
  session: new FakeSession(sessionManager, modelRegistry),
});
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

const startWorker = (runtimeRoot: string, agentDir: string) => {
  const workerPath = resolve("electron/plugin-backends/pi/worker.mjs");
  const child = spawn(process.execPath, [workerPath], {
    env: { ...process.env, PI_SDK_PACKAGE_ROOT: runtimeRoot, PI_CODING_AGENT_DIR: agentDir },
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
  const waitFor = (predicate: (message: WorkerMessage) => boolean, timeoutMs = 10000) =>
    new Promise<WorkerMessage>((resolvePromise, reject) => {
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

    const completed = await worker.waitFor((message) => message.type === "tool_execution_end");
    expect(completed.result).toMatchObject({
      cancelled: false,
      answers: [{ selected: ["Pi"], values: ["pi"] }],
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
