import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type WorkerMessage = Record<string, unknown>;

const fakeCodexSource = `
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const logPath = process.env.FAKE_CODEX_LOG;
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = async (message) => {
  if (logPath) await appendFile(logPath, JSON.stringify(message) + "\\n", "utf8");
};

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.0.0-test\\n");
  process.exit(0);
}

const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  await log(message);
  if (message.method === "initialize") {
    write({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    write({ id: "server-time", method: "currentTime/read", params: {} });
    return;
  }
  if (message.method === "model/list") {
    write({ id: message.id, result: { data: [
      { id: "model-default", displayName: "Default Model", isDefault: true, hidden: false, supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
        { reasoningEffort: "xhigh" },
        { reasoningEffort: "max" },
        { reasoningEffort: "ultra" }
      ], inputModalities: ["text", "image"] },
      { id: "model-hidden", displayName: "Hidden", hidden: true, supportedReasoningEfforts: [], inputModalities: ["text"] }
    ], nextCursor: null } });
    return;
  }
  if (message.method === "config/read") {
    if (process.env.FAKE_CODEX_CONFIG_READ_ERROR === "1") {
      write({ id: message.id, error: { code: -32601, message: "Method not found: config/read" } });
      return;
    }
    write({ id: message.id, result: { config: {
      developer_instructions: process.env.FAKE_CODEX_DEVELOPER_INSTRUCTIONS || null,
    } } });
    return;
  }
  if (message.method === "skills/list") {
    write({ id: message.id, result: { data: [{ cwd: process.cwd(), skills: [
      { name: "review", path: "/private/review/SKILL.md", enabled: true, interface: { shortDescription: "Review changes" } },
      { name: "disabled", path: "/private/disabled/SKILL.md", enabled: false }
    ] }] } });
    return;
  }
  if (message.method === "thread/start") {
    write({ id: message.id, result: { thread: { id: "thread-1" } } });
    write({ method: "thread/started", params: { thread: { id: "thread-1" } } });
    return;
  }
  if (message.method === "thread/resume") {
    if (message.params?.threadId === "missing-thread") {
      write({ id: message.id, error: { code: -32600, message: "no rollout found for thread id missing-thread" } });
      return;
    }
    if (message.params?.threadId === "auth-error-thread") {
      write({ id: message.id, error: { code: -32000, message: "authentication failed" } });
      return;
    }
    write({ id: message.id, result: { thread: { id: message.params?.threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    write({ id: message.id, result: { turn: { id: "turn-1" } } });
    write({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    const promptText = message.params?.input?.find((item) => item.type === "text")?.text;
    if (promptText === "disconnect") {
      setImmediate(() => process.exit(7));
      return;
    }
    if (promptText === "fatal") {
      write({ method: "error", params: { message: "fatal turn failure", willRetry: false } });
      return;
    }
    if (promptText === "guidance") {
      // Keep the turn open until turn/steer arrives.
      return;
    }
    if (promptText === "turn-diff") {
      const diff = [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/src/b.ts b/src/b.ts",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -1 +1 @@",
        "-c",
        "+d",
      ].join("\\n");
      write({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff } });
      write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
      return;
    }
    if (promptText === "file-change") {
      const patchOne = [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+first",
      ].join("\\n");
      const patchTwo = [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-first",
        "+second",
      ].join("\\n");
      const item = (patch) => ({ id: "file-change-1", type: "fileChange", status: "inProgress", changes: [{ path: "src/a.ts", kind: "update", patch }] });
      write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: item(patchOne) } });
      write({ method: "item/fileChange/patchUpdated", params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-change-1", changes: item(patchOne).changes } });
      write({ method: "item/fileChange/patchUpdated", params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-change-1", changes: item(patchTwo).changes } });
      write({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "" } });
      write({ method: "turn/diff/updated", params: {
        threadId: "thread-1",
        turnId: "turn-1",
        diff: "diff --git a/src/a.ts b/src/a.ts\\nnew file mode 100644",
      } });
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { ...item(patchTwo), status: "completed" } } });
      write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
      return;
    }
    if (promptText === "file-change-abort") {
      const patch = [
        "diff --git a/src/abort.ts b/src/abort.ts",
        "--- a/src/abort.ts",
        "+++ b/src/abort.ts",
        "@@ -1 +1 @@",
        "-old",
        "+aborted",
      ].join("\\n");
      write({ method: "item/started", params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "file-change-abort-1", type: "fileChange", status: "inProgress", changes: [] },
      } });
      write({ method: "item/fileChange/patchUpdated", params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "file-change-abort-1",
        changes: [{ path: "src/abort.ts", kind: "update", patch }],
      } });
      return;
    }
    if (promptText === "commentary") {
      write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "commentary-1", type: "agentMessage", phase: "commentary", text: "" } } });
      write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "commentary-1", delta: "Working on it" } });
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "commentary-1", type: "agentMessage", phase: "commentary", text: "Working on it" } } });
      write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "final-1", type: "agentMessage", phase: "final_answer", text: "" } } });
      write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "final-1", delta: "Done" } });
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "final-1", type: "agentMessage", phase: "final_answer", text: "Done" } } });
      write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
      return;
    }
    if (promptText === "legacy") {
      write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "legacy-1", type: "agentMessage", phase: null, text: "" } } });
      write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "legacy-1", delta: "Legacy answer" } });
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "legacy-1", type: "agentMessage", phase: null, text: "Legacy answer" } } });
      write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
      return;
    }
    if (promptText === "subagents") {
      write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 900, item: {
        id: "collab-empty-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "thread-1",
        receiverThreadIds: [],
        prompt: "Starting before a receiver id is assigned",
        model: "gpt-5",
        reasoningEffort: "high",
        agentsStates: {},
      } } });
      const spawnItem = {
        id: "collab-spawn-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "thread-1",
        receiverThreadIds: ["agent-thread-1"],
        prompt: "Inspect the backend commentary flow",
        model: "gpt-5",
        reasoningEffort: "high",
        agentsStates: { "agent-thread-1": { status: "pendingInit", message: null } },
      };
      write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1000, item: spawnItem } });
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 1010, item: { ...spawnItem, status: "completed", agentsStates: { "agent-thread-1": { status: "running", message: null } } } } });

      const activityItem = { id: "activity-1", type: "subAgentActivity", kind: "started", agentThreadId: "agent-thread-1", agentPath: "/root/backend_commentary" };
      write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1020, item: activityItem } });
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 1025, item: activityItem } });

      const updateItem = { id: "activity-2", type: "subAgentActivity", kind: "interacted", agentThreadId: "agent-thread-1", agentPath: "/root/backend_commentary" };
      write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1050, item: updateItem } });
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 1055, item: updateItem } });

      const waitItem = {
        id: "collab-wait-1",
        type: "collabAgentToolCall",
        tool: "wait",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: ["agent-thread-1"],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: { "agent-thread-1": { status: "completed", message: "Backend flow verified" } },
      };
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 1100, item: waitItem } });

      const selfActivity = { id: "activity-self", type: "subAgentActivity", kind: "interacted", agentThreadId: "thread-1", agentPath: "/root" };
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 1110, item: selfActivity } });

      const lateSpawnItem = {
        id: "collab-late-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "thread-1",
        receiverThreadIds: [],
        prompt: "Inspect the frontend commentary flow",
        model: "gpt-5",
        reasoningEffort: "medium",
        agentsStates: {},
      };
      write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1200, item: lateSpawnItem } });
      const earlyActivityItem = { id: "activity-early-1", type: "subAgentActivity", kind: "started", agentThreadId: "agent-thread-2", agentPath: "/root/frontend_commentary" };
      write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1210, item: earlyActivityItem } });
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 1215, item: earlyActivityItem } });
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 1220, item: {
        ...lateSpawnItem,
        status: "completed",
        receiverThreadIds: ["agent-thread-2"],
        agentsStates: { "agent-thread-2": { status: "running", message: null } },
      } } });
      write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
      return;
    }
    write({ method: "item/plan/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "plan-1", delta: "draft plan" } });
    write({ method: "thread/compacted", params: { threadId: "thread-1", turnId: "turn-1" } });
    write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "plan-1", type: "plan", text: "draft plan" } } });
    write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
  }
  if (message.method === "turn/steer") {
    // An old Assistant item may start after steer was requested. It must not
    // be mistaken for the guidance boundary.
    write({ method: "item/started", params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "old-tail", type: "agentMessage", phase: null, text: "old tail" },
    } });
    // Exercise the notification-before-RPC-response race. The worker must
    // latch this exact client id, report guidance_done first, then delivery.
    write({ method: "item/started", params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "guidance-user",
        type: "userMessage",
        clientId: message.params?.clientUserMessageId,
        content: message.params?.input || [],
      },
    } });
    write({ id: message.id, result: { turnId: "turn-1" } });
    setTimeout(() => {
      write({ method: "item/started", params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "guided-answer", type: "agentMessage", phase: null, text: "guided output" },
      } });
    }, 10);
  }
});
`;

const writeFakeCodex = async (root: string) => {
  const serverPath = join(root, "fake-codex.mjs");
  await writeFile(serverPath, fakeCodexSource, "utf8");
  if (process.platform === "win32") {
    const commandPath = join(root, "fake-codex.cmd");
    await writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${serverPath}" %*\r\n`, "utf8");
    return commandPath;
  }
  const commandPath = join(root, "fake-codex");
  await writeFile(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${serverPath}" "$@"\n`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
};

const startWorker = (commandPath: string, root: string, logPath: string, extraEnv: NodeJS.ProcessEnv = {}) => {
  const child = spawn(process.execPath, [resolve("electron/plugin-backends/codex/worker.mjs")], {
    env: {
      ...process.env,
      CODEX_PATH: commandPath,
      CODEX_HOME: join(root, "codex-home"),
      FAKE_CODEX_LOG: logPath,
      ...extraEnv,
    },
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
  const waitFor = (predicate: (message: WorkerMessage) => boolean, timeoutMs = 5000) =>
    new Promise<WorkerMessage>((resolvePromise, reject) => {
      const existing = messages.find(predicate);
      if (existing) {
        resolvePromise(existing);
        return;
      }
      const waiter = {
        predicate,
        resolve: resolvePromise,
        reject,
        timeout: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Codex worker response timed out"));
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
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
};

describe("Codex worker protocol", () => {
  let tempRoot = "";
  let commandPath = "";
  let logPath = "";
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hpp-codex-worker-"));
    await mkdir(join(tempRoot, "codex-home"), { recursive: true });
    commandPath = await writeFakeCodex(tempRoot);
    logPath = join(tempRoot, "app-server.log");
  });

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stopWorker));
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("uses the app-server model catalog and handles current time requests", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "models", type: "getModels" });

    await expect(worker.waitFor((message) => message.id === "models" && message.type === "models"))
      .resolves.toMatchObject({
        models: [{
          id: "model-default",
          name: "Default Model",
          provider: "codex",
          reasoning: true,
          supportsImages: true,
          supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        }],
      });
    await expect.poll(async () => readFile(logPath, "utf8")).toContain('"id":"server-time","result":{"currentTimeAt":');
  });

  it.each(["max", "ultra"])("passes the native %s effort through to Codex", async (level) => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    worker.send({ id: `thinking-${level}`, type: "setThinkingLevel", level });
    await worker.waitFor((message) => (
      message.type === "thinking_level_changed" && message.id === `thinking-${level}`
    ));
    worker.send({ id: `prompt-${level}`, type: "prompt", message: `reasoning-${level}` });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === `prompt-${level}`);

    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.find((call) => call.method === "thread/start")?.params?.config)
      .toMatchObject({ model_reasoning_effort: level });
    expect(calls.find((call) => call.method === "turn/start")?.params)
      .toMatchObject({
        effort: level,
        collaborationMode: { settings: { reasoning_effort: level } },
      });
  });

  it("returns an error for a UI response without a matching request", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
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
        error: "Unknown Codex UI request: missing-request",
      });
  });

  it("streams plan deltas and context compaction notifications", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath, {
      FAKE_CODEX_DEVELOPER_INSTRUCTIONS: "Keep the user's configured guidance.",
    });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot, hostSystemPrompt: "[HPP 语言规则] 始终使用简体中文" });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({
      id: "prompt-1",
      type: "prompt",
      message: "plan",
      planModeEnabled: true,
      permissionMode: "ask",
    });

    await expect(worker.waitFor((message) => message.type === "stream_delta" && message.delta === "draft plan"))
      .resolves.toMatchObject({ type: "stream_delta", delta: "draft plan" });
    await expect(worker.waitFor((message) => message.type === "context_compaction"))
      .resolves.toMatchObject({ type: "context_compaction" });
    await expect(worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-1"))
      .resolves.toMatchObject({ type: "prompt_done", id: "prompt-1" });
    const compactionIndex = worker.messages.findIndex((message) => message.type === "context_compaction");
    const agentEndIndex = worker.messages.findIndex((message) => message.type === "agent_end");
    expect(compactionIndex).toBeGreaterThanOrEqual(0);
    expect(agentEndIndex).toBeGreaterThan(compactionIndex);
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.find((call) => call.method === "thread/start")?.params?.config).toMatchObject({
      collaboration_mode: "Plan",
      include_collaboration_mode_instructions: true,
      developer_instructions: "Keep the user's configured guidance.\n\n[HPP 语言规则] 始终使用简体中文",
    });
    expect(calls.find((call) => call.method === "thread/start")?.params)
      .toMatchObject({
        developerInstructions: "Keep the user's configured guidance.\n\n[HPP 语言规则] 始终使用简体中文",
      });
    const turnStart = calls.find((call) => call.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      collaborationMode: {
        mode: "plan",
        settings: {
          developer_instructions: expect.stringContaining("[HPP 语言规则] 始终使用简体中文"),
        },
      },
    });
    expect(turnStart?.params?.input?.find((item: { type?: string }) => item.type === "text")?.text)
      .not.toContain("[HPP 语言规则]");
  });

  it("supports the turn-level aggregated diff notification", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    worker.send({ id: "turn-diff-prompt", type: "prompt", message: "turn-diff" });
    const diff = await worker.waitFor((message) => message.type === "diff_update");
    expect(diff.diffs).toEqual([
      expect.objectContaining({ file: "src/a.ts", patch: expect.stringContaining("+b") }),
      expect.objectContaining({ file: "src/b.ts", patch: expect.stringContaining("+d") }),
    ]);
    expect(worker.messages.filter((message) => message.type === "diff_update")).toHaveLength(1);
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "turn-diff-prompt");
  });

  it("emits only the latest file-change snapshot and keeps tool_end diff-free", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");

    worker.send({ id: "file-change-prompt", type: "prompt", message: "file-change" });
    const diff = await worker.waitFor((message) => message.type === "diff_update");

    expect(diff.diffs).toEqual([expect.objectContaining({
      file: "src/a.ts",
      patch: expect.stringContaining("+second"),
    })]);
    expect(String(diff.diffs?.[0]?.patch || "")).not.toContain("+first");
    expect(worker.messages.filter((message) => message.type === "diff_update")).toHaveLength(1);
    const toolEnd = worker.messages.find((message) => message.type === "tool_end");
    expect(toolEnd?.files).toEqual([{ file: "src/a.ts", label: "a.ts" }]);
    expect(toolEnd).not.toHaveProperty("patch");

    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "file-change-prompt");
  });

  it("flushes an already observed file change when the turn is aborted", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "abort-file-change-prompt", type: "prompt", message: "file-change-abort" });
    await worker.waitFor((message) => message.type === "tool_start" && message.toolCallId === "file-change-abort-1");

    worker.send({ id: "abort-file-change", type: "abort" });
    await worker.waitFor((message) => message.type === "aborted");
    const diff = worker.messages.find((message) => message.type === "diff_update");
    expect(diff?.diffs).toEqual([expect.objectContaining({
      file: "src/abort.ts",
      patch: expect.stringContaining("+aborted"),
    })]);
  });

  it("confirms guidance at its matching user item across the RPC race", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "prompt-guidance", type: "prompt", message: "guidance" });
    await worker.waitFor((message) => (
      message.type === "turn_metadata" && message.nativeTurnId === "turn-1"
    ));

    worker.send({ id: "guidance-1", type: "guidance", message: "steer this turn" });
    await worker.waitFor((message) => message.type === "stream_delta" && message.delta === "guided output");

    const oldTailIndex = worker.messages.findIndex((message) => (
      message.type === "stream_delta" && message.delta === "old tail"
    ));
    const acceptedIndex = worker.messages.findIndex((message) => (
      message.type === "guidance_done" && message.id === "guidance-1"
    ));
    const deliveredIndex = worker.messages.findIndex((message) => (
      message.type === "guidance_delivered" && message.id === "guidance-1"
    ));
    const guidedOutputIndex = worker.messages.findIndex((message) => (
      message.type === "stream_delta" && message.delta === "guided output"
    ));
    expect(oldTailIndex).toBeGreaterThanOrEqual(0);
    expect(acceptedIndex).toBeGreaterThan(oldTailIndex);
    expect(deliveredIndex).toBeGreaterThan(acceptedIndex);
    expect(guidedOutputIndex).toBeGreaterThan(deliveredIndex);
    expect(worker.messages.filter((message) => message.type === "guidance_delivered")).toHaveLength(1);

    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.find((call) => call.method === "turn/steer")?.params).toMatchObject({
      expectedTurnId: "turn-1",
      clientUserMessageId: "guidance-1",
      input: [{ type: "text", text: "steer this turn", text_elements: [] }],
    });
  });

  it("falls back to native host developer instructions when config/read is unavailable", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath, {
      FAKE_CODEX_CONFIG_READ_ERROR: "1",
    });
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({
      id: "host-prompt",
      type: "prompt",
      message: "Keep this user message unchanged.",
      hostSystemPrompt: "HPP_HOST_GUIDANCE",
    });

    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "host-prompt");
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.find((call) => call.method === "thread/start")?.params?.config)
      .toMatchObject({ developer_instructions: "HPP_HOST_GUIDANCE" });
    expect(calls.find((call) => call.method === "thread/start")?.params)
      .toMatchObject({ developerInstructions: "HPP_HOST_GUIDANCE" });
    const turnStart = calls.find((call) => call.method === "turn/start");
    expect(turnStart?.params?.input).toContainEqual({
      type: "text",
      text: "Keep this user message unchanged.",
      text_elements: [],
    });
    expect(JSON.stringify(turnStart?.params?.input)).not.toContain("HPP_HOST_GUIDANCE");
  });

  it("resumes an existing thread without creating a replacement", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot, sessionFilePath: "existing-thread" });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({
      id: "resume-prompt",
      type: "prompt",
      message: "plan",
      hostSystemPrompt: "HPP_HOST_GUIDANCE",
    });

    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "resume-prompt");
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
    expect(calls.find((call) => call.method === "thread/resume")?.params?.config)
      .toMatchObject({ developer_instructions: "HPP_HOST_GUIDANCE" });
    expect(calls.find((call) => call.method === "thread/resume")?.params)
      .toMatchObject({ developerInstructions: "HPP_HOST_GUIDANCE" });
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    expect(calls.find((call) => call.method === "turn/start")?.params?.threadId).toBe("existing-thread");
  });

  it("replaces a thread whose rollout is missing and sends the prompt once", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot, sessionFilePath: "missing-thread" });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "recovery-prompt", type: "prompt", message: "plan" });

    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "recovery-prompt");
    expect(worker.messages).toContainEqual({
      type: "session_file_path",
      sessionFilePath: "thread-1",
      threadId: "thread-1",
    });
    expect(worker.messages.some((message) =>
      message.type === "process_event" && message.title === "Codex request failed"
    )).toBe(false);
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    expect(calls.find((call) => call.method === "turn/start")?.params?.threadId).toBe("thread-1");
  });

  it("does not replace a thread when resume fails for another reason", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot, sessionFilePath: "auth-error-thread" });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "failed-prompt", type: "prompt", message: "plan" });

    await expect(worker.waitFor((message) =>
      message.type === "process_event" && message.title === "Codex request failed"
    )).resolves.toMatchObject({ detail: "authentication failed", state: "error" });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "failed-prompt");
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(0);
  });

  it("terminalizes a prompt when the internal app-server exits", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "disconnect-prompt", type: "prompt", message: "disconnect" });

    await expect(worker.waitFor((message) => (
      message.type === "process_event" && message.title === "Codex app-server disconnected"
    ))).resolves.toMatchObject({ state: "error" });
    await expect(worker.waitFor((message) => (
      message.type === "prompt_done" && message.id === "disconnect-prompt"
    ))).resolves.toMatchObject({ type: "prompt_done" });
    await expect(worker.waitFor((message) => message.type === "agent_disconnected"))
      .resolves.toMatchObject({ detail: expect.stringContaining("output pipe closed") });
  });

  it("terminalizes a fatal server error without waiting for turn/completed", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "fatal-prompt", type: "prompt", message: "fatal" });

    await expect(worker.waitFor((message) => (
      message.type === "process_event" && message.title === "Codex error"
    ))).resolves.toMatchObject({ state: "error" });
    await expect(worker.waitFor((message) => (
      message.type === "prompt_done" && message.id === "fatal-prompt"
    ))).resolves.toMatchObject({ type: "prompt_done" });
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: "stream_end", force: true }));
    expect(worker.messages).toContainEqual({ type: "agent_end" });
  });

  it("separates commentary from the final response", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "commentary-prompt", type: "prompt", message: "commentary" });

    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "commentary-prompt");
    expect(worker.messages).toContainEqual({
      type: "commentary_delta",
      itemId: "commentary-1",
      delta: "Working on it",
    });
    expect(worker.messages).toContainEqual({
      type: "commentary_end",
      itemId: "commentary-1",
      content: "Working on it",
    });
    expect(worker.messages).toContainEqual({ type: "stream_delta", delta: "Done" });
    expect(worker.messages).toContainEqual({ type: "stream_end", content: "Done", force: true });
    expect(worker.messages).not.toContainEqual({ type: "stream_delta", delta: "Working on it" });
  });

  it("keeps phase-less agent messages on the final response stream", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "legacy-prompt", type: "prompt", message: "legacy" });

    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "legacy-prompt");
    expect(worker.messages).toContainEqual({ type: "stream_delta", delta: "Legacy answer" });
    expect(worker.messages).toContainEqual({ type: "stream_end", content: "Legacy answer", force: true });
    expect(worker.messages.some((message) => message.type === "commentary_delta")).toBe(false);
  });

  it("normalizes collab tools and sub-agent activity without generic tool duplicates", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "subagent-prompt", type: "prompt", message: "subagents" });

    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "subagent-prompt");
    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "subagent_event",
      id: "collab-spawn-1",
      toolCallId: "collab-spawn-1",
      phase: "started",
      action: "spawnAgent",
      tool: "spawnAgent",
      title: "已开始工作",
      state: "running",
      timestamp: 1000,
      startedAt: 1000,
      subagents: [{
        id: "agent-thread-1",
        label: "Agent agent-th",
        status: "pending",
        model: "gpt-5",
      }],
    }));
    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "subagent_event",
      id: "collab-spawn-1",
      phase: "completed",
      state: "running",
      timestamp: 1000,
      startedAt: 1000,
      completedAt: 1010,
      collabStatus: "completed",
    }));
    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "subagent_event",
      id: "collab-spawn-1",
      sourceActivityId: "activity-1",
      phase: "completed",
      action: "started",
      activityKind: "started",
      title: "已开始工作",
      state: "running",
      timestamp: 1000,
      startedAt: 1000,
      activityTimestamp: 1020,
      activityCompletedAt: 1025,
      subagents: [{
        id: "agent-thread-1",
        label: "Backend commentary",
        status: "running",
        model: "gpt-5",
        path: "/root/backend_commentary",
      }],
    }));
    expect(worker.messages.some((message) => message.type === "subagent_event" && message.id === "activity-1")).toBe(false);
    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "subagent_event",
      id: "activity-2",
      action: "interacted",
      title: "已更新",
      state: "completed",
      subagents: [expect.objectContaining({ status: "completed" })],
    }));
    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "subagent_event",
      id: "collab-wait-1",
      action: "wait",
      title: "已完成",
      state: "completed",
      timestamp: 1100,
      completedAt: 1100,
      subagents: [expect.objectContaining({
        id: "agent-thread-1",
        label: "Backend commentary",
        status: "completed",
        message: "Backend flow verified",
      })],
    }));
    expect(worker.messages.some((message) => message.type === "subagent_event" && message.id === "activity-self")).toBe(false);
    expect(worker.messages.some((message) => message.type === "subagent_event" && message.id === "collab-empty-1")).toBe(false);
    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: "subagent_event",
      id: "activity-early-1",
      toolCallId: "collab-late-1",
      action: "spawnAgent",
      title: "已开始工作",
      state: "running",
      timestamp: 1200,
      completedAt: 1220,
      subagents: [{
        id: "agent-thread-2",
        label: "Frontend commentary",
        status: "running",
        model: "gpt-5",
        path: "/root/frontend_commentary",
      }],
    }));
    expect(worker.messages.some((message) => message.type === "subagent_event" && message.id === "collab-late-1")).toBe(false);
    expect(worker.messages.some((message) =>
      (message.type === "tool_start" || message.type === "tool_end") &&
      (message.toolCallId === "collab-spawn-1" || message.toolCallId === "collab-wait-1")
    )).toBe(false);
  });

  it("lists native skills without paths and sends the native skill input", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "actions", type: "listActions", reload: true });
    const catalog = await worker.waitFor((message) => message.id === "actions" && message.type === "actions");
    expect(catalog.actions).toEqual([{ kind: "skill", name: "review", description: "Review changes" }]);
    expect(JSON.stringify(catalog)).not.toContain("SKILL.md");

    worker.send({
      id: "skill-prompt",
      type: "prompt",
      message: "src",
      action: { kind: "skill", name: "review" },
      permissionMode: "full-access",
    });
    await worker.waitFor((message) => message.type === "prompt_done" && message.id === "skill-prompt");
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const turnStart = calls.find((call) => call.method === "turn/start" && call.params?.clientUserMessageId === "skill-prompt");
    expect(turnStart.params.input).toEqual([
      { type: "skill", name: "review", path: "/private/review/SKILL.md" },
      { type: "text", text: "src", text_elements: [] },
    ]);
    worker.send({ id: "missing-skill", type: "prompt", message: "", action: { kind: "skill", name: "missing" } });
    await expect(worker.waitFor((message) => message.type === "process_event" && message.detail === "ACTION_NOT_FOUND"))
      .resolves.toMatchObject({ state: "error" });
  });
});
