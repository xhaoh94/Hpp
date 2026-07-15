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
      { id: "model-default", displayName: "Default Model", isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], inputModalities: ["text", "image"] },
      { id: "model-hidden", displayName: "Hidden", hidden: true, supportedReasoningEfforts: [], inputModalities: ["text"] }
    ], nextCursor: null } });
    return;
  }
  if (message.method === "thread/start") {
    write({ id: message.id, result: { thread: { id: "thread-1" } } });
    write({ method: "thread/started", params: { thread: { id: "thread-1" } } });
    return;
  }
  if (message.method === "turn/start") {
    write({ id: message.id, result: { turn: { id: "turn-1" } } });
    write({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    write({ method: "item/plan/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "plan-1", delta: "draft plan" } });
    write({ method: "thread/compacted", params: { threadId: "thread-1", turnId: "turn-1" } });
    write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "plan-1", type: "plan", text: "draft plan" } } });
    write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
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

const startWorker = (commandPath: string, root: string, logPath: string) => {
  const child = spawn(process.execPath, [resolve("electron/plugin-backends/codex/worker.mjs")], {
    env: {
      ...process.env,
      CODEX_PATH: commandPath,
      CODEX_HOME: join(root, "codex-home"),
      FAKE_CODEX_LOG: logPath,
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
        models: [{ id: "model-default", name: "Default Model", provider: "codex", reasoning: true, supportsImages: true }],
      });
    await expect.poll(async () => readFile(logPath, "utf8")).toContain('"id":"server-time","result":{"currentTimeAt":');
  });

  it("streams plan deltas and context compaction notifications", async () => {
    const worker = startWorker(commandPath, tempRoot, logPath);
    children.push(worker.child);
    worker.send({ id: "init", type: "init", projectPath: tempRoot });
    await worker.waitFor((message) => message.type === "ready");
    worker.send({ id: "prompt-1", type: "prompt", message: "plan", planModeEnabled: true, permissionMode: "plan" });

    await expect(worker.waitFor((message) => message.type === "stream_delta" && message.delta === "draft plan"))
      .resolves.toMatchObject({ type: "stream_delta", delta: "draft plan" });
    await expect(worker.waitFor((message) => message.type === "context_compaction"))
      .resolves.toMatchObject({ type: "context_compaction" });
    await expect(worker.waitFor((message) => message.type === "prompt_done" && message.id === "prompt-1"))
      .resolves.toMatchObject({ type: "prompt_done", id: "prompt-1" });
  });
});
