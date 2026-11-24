import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const defaultHostPath = fileURLToPath(new URL("./shell-pty-host.mjs", import.meta.url));
// 每个终端保留的尾部输出（字符）。游标是合并后的字符位置，和这里保持一致。
const outputLimit = 64 * 1024;
const defaultRetainedSessions = 64;
const defaultStopGraceMs = 3000;

const STOP_REASONS = {
  abort: "已中止",
  timeout: "已超时",
  stop: "已停止",
  dispose: "会话已停止",
};

// ConPTY / pty 会把光标、清屏、OSC 标题等控制序列一起写进数据流。模型读的是文本，
// 这些转义只会占 token（Windows 上 ConPTY 每次启动都会带 ?9001h、?1004h）。
const escapeSequence = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[P^_][^\u001b]*(?:\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// 跨数据块被截断的转义序列先扣住尾巴，等下一块补齐再清理，避免输出里留下
// "[?25h" 这类碎片；超过上限就放弃等待，按普通文本处理。
const partialEscape = /\u001b(?:\[[0-?]*[ -/]*|][^\u0007\u001b]*|[P^_][^\u001b]*)?$/;
const maxPendingEscape = 2048;

const stripTerminalEscapes = (text) => text.replace(escapeSequence, "").replace(controlCharacters, "");

const splitPendingEscape = (text) => {
  const partial = text.match(partialEscape)?.[0] || "";
  if (!partial || partial.length > maxPendingEscape) return [text, ""];
  return [text.slice(0, text.length - partial.length), partial];
};

/** 每个 Pi worker 独占其终端，游标是合并后的终端输出字符位置。 */
export function createShellSessions(options = {}) {
  const hostPath = options.hostPath || defaultHostPath;
  const retainedSessions = options.retainedSessions ?? defaultRetainedSessions;
  const stopGraceMs = options.stopGraceMs ?? defaultStopGraceMs;
  const sessions = new Map();

  function scheduleForceKill(entry) {
    if (entry.done || entry.forceKillTimer) return;
    // host 卡在 kill 上（子进程忽略信号、ConPTY 回收慢）时兜底，别把终端和
    // IPC 句柄一起留着：dispose 后旧 worker 的终端必须真的消失。
    entry.forceKillTimer = setTimeout(() => {
      entry.forceKillTimer = undefined;
      if (entry.done) return;
      try { entry.child.kill(); } catch { /* 已经不在了 */ }
    }, stopGraceMs);
    entry.forceKillTimer.unref?.();
  }

  function stop(entry, reason) {
    if (entry.done || entry.stopping) return;
    entry.stopping = reason;
    // send 在 IPC 已断开时会抛 ERR_IPC_CHANNEL_CLOSED；单个终端出错不能
    // 中断 stopAll（disposeSession 靠它收尾整场会话）。
    try {
      if (entry.child.connected) entry.child.send({ type: "stop" }, () => {});
    } catch {
      // 通道已关，交给下面的强制回收。
    }
    scheduleForceKill(entry);
  }

  function wake(entry) {
    for (const resolveWait of entry.waiters) resolveWait();
  }

  function prune() {
    const drained = [...sessions.values()].filter((item) => item.done);
    while (drained.length > retainedSessions) {
      const oldest = drained.shift();
      sessions.delete(oldest.id);
    }
  }

  function appendOutput(entry, chunk) {
    const [text, pending] = splitPendingEscape(entry.pending + chunk);
    entry.pending = pending;
    const cleaned = stripTerminalEscapes(text);
    if (!cleaned) return;
    entry.end += cleaned.length;
    entry.buffer = (entry.buffer + cleaned).slice(-outputLimit);
    wake(entry);
  }

  async function start(shell, args, cwd, env, timeout, signal) {
    signal?.throwIfAborted();
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647)) {
      throw new Error("终端超时必须是有效的正秒数。");
    }
    const child = fork(hostPath, [], { cwd, execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const id = randomUUID();
    const entry = { child, id, buffer: "", pending: "", end: 0, cursor: 0, done: false, waiters: new Set() };
    sessions.set(id, entry);
    // 超时属于终端生命周期：宿主中途退出（dispose）前一直有效。
    const timer = timeout ? setTimeout(() => stop(entry, STOP_REASONS.timeout), timeout * 1000) : undefined;
    const cancel = () => stop(entry, STOP_REASONS.abort);
    const detachAbort = () => signal?.removeEventListener("abort", cancel);
    try {
      await new Promise((ready, reject) => {
        function finish(code, error) {
          if (entry.done) return;
          entry.done = true;
          entry.exitCode = code;
          entry.error = error || entry.stopping;
          clearTimeout(timer);
          if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
          entry.forceKillTimer = undefined;
          detachAbort();
          reject(new Error(entry.error || "终端在启动期间退出。"));
          wake(entry);
          // 结束的会话保留尾部输出，供后续回合读取。
          prune();
        }
        child.on("message", (event) => {
          if (!event || typeof event !== "object") return;
          if (event.type === "ready") ready();
          else if (event.type === "end") finish(event.signal ? 128 + event.signal : event.exitCode, event.error);
          else if (event.type === "output" && typeof event.text === "string") appendOutput(entry, event.text);
        });
        child.once("error", (error) => finish(1, error.message));
        // 用 close 而不是 exit：IPC 消息可能晚于 exit 事件到达，否则一次正常的
        // 非零退出会被当成「终端进程意外退出」。
        child.once("close", (code) => finish(code || 1, entry.stopping ? undefined : "终端进程意外退出。"));
        signal?.addEventListener("abort", cancel, { once: true });
        child.send({ type: "start", shell, args, cwd, env }, (error) => { if (error) finish(1, error.message); });
      });
    } catch (error) {
      sessions.delete(id);
      if (!entry.done) {
        stop(entry, STOP_REASONS.abort);
      } else {
        // 已经回过 end 但进程没退（发送回调失败、ConPTY 回收慢）时兜底。
        const cleanup = setTimeout(() => { try { entry.child.kill(); } catch { /* 已经退出 */ } }, stopGraceMs);
        cleanup.unref?.();
      }
      throw error;
    }
    // 工具调用结束后再看 signal 只会误杀本来要长期运行的后台终端。
    detachAbort();
    return { content: [{ type: "text", text: `终端已启动。使用 shell_session 读取输出、写入或停止。ID ${id}` }], details: { sessionId: id } };
  }

  function send(entry, message) {
    if (!entry.child.connected) return Promise.reject(new Error("该终端已关闭。"));
    return new Promise((resolve, reject) => {
      try {
        entry.child.send(message, (error) => {
          if (error) reject(new Error("该终端已关闭。"));
          else resolve();
        });
      } catch {
        reject(new Error("该终端已关闭。"));
      }
    });
  }

  async function waitForOutput(entry, from, waitMs, signal) {
    const wait = Math.min(30000, Math.max(0, Number(waitMs ?? 1000) || 0));
    if (entry.done || entry.end !== from || wait <= 0) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        entry.waiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, wait);
      entry.waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }

  async function interact({ id, action, text, cursor, waitMs }, signal) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("当前会话没有这个终端 ID。");
    signal?.throwIfAborted();
    const from = cursor ?? entry.cursor;
    if (!Number.isSafeInteger(from) || from < 0 || from > entry.end) throw new Error("无效的终端输出游标。");
    if (action === "write") {
      if (entry.done || entry.stopping || !entry.child.connected) throw new Error("该终端已关闭。");
      if (typeof text !== "string" || !text.length) throw new Error("请输入要写入终端的文本。");
      await send(entry, { type: "input", text });
    } else if (action === "stop") stop(entry, STOP_REASONS.stop);
    else if (action !== "read") throw new Error("未知的终端操作。");

    await waitForOutput(entry, from, waitMs, signal);
    signal?.throwIfAborted();
    const oldest = entry.end - entry.buffer.length;
    const dropped = Math.max(0, oldest - from);
    const output = entry.buffer.slice(Math.max(0, from - oldest));
    entry.cursor = Math.max(entry.cursor, entry.end);
    const status = entry.done ? `已退出（${entry.exitCode}）` : entry.stopping || "运行中";
    // 用户主动 stop / 会话回收不算失败：退出码在 Windows 上是 1，报成错误会让
    // 模型误以为操作失败。
    const userClosed = entry.stopping === STOP_REASONS.stop || entry.stopping === STOP_REASONS.dispose;
    const failed = entry.done && entry.exitCode !== 0 && !userClosed;
    return {
      content: [{ type: "text", text: [`终端 ${id} ${status}，游标 ${entry.end}`, entry.error,
        dropped ? `较早的 ${dropped} 个字符已移出缓冲。` : "", output].filter(Boolean).join("\n") }],
      details: { sessionId: id, cursor: entry.end, running: !entry.done, exitCode: entry.exitCode, dropped },
      ...(failed ? { isError: true } : {}),
    };
  }

  function stopAll() {
    for (const entry of [...sessions.values()]) {
      try { stop(entry, STOP_REASONS.dispose); } catch { /* 单个终端失败不能阻断会话回收 */ }
    }
  }

  /** worker 被终止 / 崩溃时同步回收，PTY 随 host 进程消失。 */
  function killAll() {
    for (const entry of sessions.values()) {
      if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
      entry.forceKillTimer = undefined;
      try { entry.child.kill(); } catch { /* 已经退出 */ }
    }
    sessions.clear();
  }

  return { start, interact, stopAll, killAll };
}
