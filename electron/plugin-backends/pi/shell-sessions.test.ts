import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error Hpp worker extension is intentionally shipped as ESM.
import { createShellSessions } from "./shell-sessions.mjs";

// shell-sessions 只依赖 fork 出来的 host 协议，测试用假 host 覆盖生命周期分支；
// 真 pty 的行为由最后一个用例和 shell-pty-host 自己的协议验证。
const FAKE_HOST_SOURCE = String.raw`
let behavior = "";
let ending = false;
const post = (message) => { if (process.connected) process.send(message); };
const finish = (exitCode, error) => {
  if (ending) return;
  ending = true;
  if (process.connected) process.send({ type: "end", exitCode, error }, () => process.exit(0));
  else process.exit(0);
};
process.on("message", (message) => {
  if (ending || !message || typeof message !== "object") return;
  if (message.type === "start") {
    behavior = String(message.shell || "");
    if (behavior === "fail") return finish(7, "无法启动终端");
    if (behavior === "slow") return void setTimeout(() => post({ type: "ready" }), 300);
    if (behavior === "hang-stop") {
      post({ type: "ready" });
      setInterval(() => {}, 1000);
      return;
    }
    if (behavior === "emit") {
      post({ type: "ready" });
      post({ type: "output", text: "line-one\r\n" });
      return finish(0);
    }
    if (behavior === "flood") {
      post({ type: "ready" });
      post({ type: "output", text: "a".repeat(70000) });
      return finish(0);
    }
    if (behavior === "ansi") {
      post({ type: "ready" });
      // 故意把一条 CSI 拆到两个数据块里：尾部碎片必须先扣住再清理。
      post({ type: "output", text: "\u001b[?25" });
      post({ type: "output", text: "lhello\u001b]0;title\u0007\r\n\u001b[1;32mgreen\u001b[0m\tend" });
      return finish(0);
    }
    if (behavior === "exit3") {
      post({ type: "ready" });
      post({ type: "output", text: "boom" });
      return finish(3);
    }
    post({ type: "ready" });
    return;
  }
  if (message.type === "input") return post({ type: "output", text: message.text });
  if (message.type === "stop") {
    if (behavior === "hang-stop") return;
    return finish(0);
  }
});
process.on("disconnect", () => process.exit(0));
`;

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: { sessionId: string; cursor: number; running: boolean; exitCode?: number; dropped: number };
  isError?: boolean;
};

describe("Pi 后台终端会话", () => {
  let root = "";
  let hostPath = "";
  const active: Array<{ stopAll: () => void; killAll: () => void }> = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hpp-shell-sessions-"));
    hostPath = join(root, "fake-pty-host.mjs");
    await writeFile(hostPath, FAKE_HOST_SOURCE, "utf8");
  });

  afterEach(async () => {
    for (const sessions of active.splice(0)) {
      try { sessions.killAll(); } catch { /* ignore */ }
    }
    // Windows 上 fork 出来的 host 退出和目录锁释放之间有一小段延迟。
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  const create = (options: Record<string, unknown> = {}) => {
    const sessions = createShellSessions({ hostPath, ...options });
    active.push(sessions);
    return sessions;
  };

  const readAll = async (sessions: any, id: string, attempts = 30) => {
    const texts: string[] = [];
    let last: ToolResult | undefined;
    for (let index = 0; index < attempts; index += 1) {
      last = await sessions.interact({ id, action: "read", waitMs: 100 }) as ToolResult;
      texts.push(last.content[0].text);
      if (!last.details.running) break;
    }
    return { details: last!.details, isError: last!.isError === true, text: texts.join("\n") };
  };

  it("starts a terminal, reads its output once and keeps a stable cursor", async () => {
    const sessions = create();
    const started = await sessions.start("emit", [], process.cwd(), process.env) as ToolResult;
    const id = started.details.sessionId;
    expect(id).toBeTruthy();
    expect(started.content[0].text).toContain("shell_session");

    const first = await readAll(sessions, id);
    expect(first.text).toContain("line-one");
    expect(first.details).toMatchObject({ sessionId: id, cursor: "line-one\r\n".length, running: false, dropped: 0 });

    // 默认游标停在上次读取的位置：再读只会有状态行，不会重复输出。
    const repeated = await sessions.interact({ id, action: "read", waitMs: 0 }) as ToolResult;
    expect(repeated.content[0].text).toContain(`游标 ${first.details.cursor}`);
    expect(repeated.content[0].text).not.toContain("line-one");
  });

  it("echoes writes and waits for output before answering", async () => {
    const sessions = create();
    const { details } = await sessions.start("echo", [], root, process.env) as ToolResult;
    const written = await sessions.interact({ id: details.sessionId, action: "write", text: "ls -la\r", waitMs: 1500 }) as ToolResult;
    expect(written.content[0].text).toContain("ls -la");
    expect(written.details.cursor).toBeGreaterThan(0);

    const replayed = await sessions.interact({ id: details.sessionId, action: "read", cursor: 0, waitMs: 0 }) as ToolResult;
    expect(replayed.content[0].text).toContain("ls -la");
    await expect(sessions.interact({ id: details.sessionId, action: "read", cursor: 9999 }))
      .rejects.toThrow("无效的终端输出游标");
    await expect(sessions.interact({ id: "missing", action: "read" })).rejects.toThrow("没有这个终端 ID");
  });

  it("reports a host that fails to spawn and drops the session", async () => {
    const sessions = create();
    await expect(sessions.start("fail", [], root, process.env)).rejects.toThrow("无法启动终端");
  });

  it("stops the terminal when the tool call is aborted before it is ready", async () => {
    const sessions = create();
    const controller = new AbortController();
    const started = sessions.start("slow", [], root, process.env, undefined, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(started).rejects.toThrow("已中止");
  });

  it("applies the tool timeout to the terminal lifetime", async () => {
    const sessions = create();
    const { details } = await sessions.start("echo", [], root, process.env, 0.05) as ToolResult;
    const read = await readAll(sessions, details.sessionId);
    expect(read.text).toContain("已超时");
    expect(read.details.running).toBe(false);
  });

  it("does not mark an explicit stop as a failure but keeps non-zero exits as errors", async () => {
    const sessions = create();
    const stopped = await sessions.start("echo", [], root, process.env) as ToolResult;
    const read = await sessions.interact({ id: stopped.details.sessionId, action: "stop", waitMs: 1000 }) as ToolResult;
    expect(read.details.running).toBe(false);
    expect(read.isError).not.toBe(true);
    expect(read.content[0].text).toContain("已停止");

    const failed = await sessions.start("exit3", [], root, process.env) as ToolResult;
    const failedRead = await readAll(sessions, failed.details.sessionId);
    expect(failedRead.details.exitCode).toBe(3);
    expect(failedRead.isError).toBe(true);
    expect(failedRead.text).toContain("boom");
  });

  it("strips terminal escape sequences even when they are split across chunks", async () => {
    const sessions = create();
    const { details } = await sessions.start("ansi", [], root, process.env) as ToolResult;
    const read = await readAll(sessions, details.sessionId);
    expect(read.text).toContain("hello");
    expect(read.text).toContain("green");
    expect(read.text).toContain("end");
    expect(read.text).not.toContain("\u001b");
    expect(read.text).not.toContain("[?25");
    expect(read.text).not.toContain("]0;title");
  });

  it("keeps the tail of long output and reports how much was dropped", async () => {
    const sessions = create();
    const { details } = await sessions.start("flood", [], root, process.env) as ToolResult;
    const read = await sessions.interact({ id: details.sessionId, action: "read", waitMs: 1000 }) as ToolResult;
    expect(read.details.dropped).toBe(4464);
    expect(read.content[0].text).toContain("较早的 4464 个字符已移出缓冲。");
    expect(read.content[0].text.length).toBeLessThan(70_000);
  });

  it("prunes the oldest finished sessions but keeps the newest readable", async () => {
    const sessions = create({ retainedSessions: 2 });
    const ids: string[] = [];
    for (const behavior of ["emit", "emit", "emit"]) {
      // eslint-disable-next-line no-await-in-loop
      const { details } = await sessions.start(behavior, [], root, process.env) as ToolResult;
      ids.push(details.sessionId);
      // 每个终端都等它真正退出：不同 host 是不同进程，结束消息的先后没有保证。
      // eslint-disable-next-line no-await-in-loop
      await readAll(sessions, details.sessionId);
    }
    await expect(sessions.interact({ id: ids[0], action: "read" })).rejects.toThrow("没有这个终端 ID");
    await expect(sessions.interact({ id: ids[2], action: "read" })).resolves.toMatchObject({ details: { sessionId: ids[2] } });
  });

  it("force-kills a host that ignores stop so dispose never leaks terminals", async () => {
    const sessions = create({ stopGraceMs: 50 });
    const { details } = await sessions.start("hang-stop", [], root, process.env) as ToolResult;
    expect(() => sessions.stopAll()).not.toThrow();
    const read = await readAll(sessions, details.sessionId);
    expect(read.details.running).toBe(false);
  });

  it("runs the real pty host and returns plain text", async () => {
    const sessions = createShellSessions();
    active.push(sessions);
    const { details } = await sessions.start(
      process.execPath,
      ["-e", "process.stdout.write('pty-real-output')"],
      process.cwd(),
      process.env,
      20,
    ) as ToolResult;
    const read = await readAll(sessions, details.sessionId, 60);
    expect(read.text).toContain("pty-real-output");
    expect(read.details.running).toBe(false);
    expect(read.details.exitCode).toBe(0);
    expect(read.text).not.toContain("\u001b");
  }, 20000);
});
