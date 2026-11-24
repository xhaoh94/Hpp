import { createRequire } from "node:module";

// 每个终端独享一个进程。ConPTY 的线程和管道随进程退出释放，标准输出也不会进入 Pi 的 RPC 通道。
const require = createRequire(import.meta.url);
const exitNow = () => process.exit(0);
let terminal;
let ending = false;

function post(message) {
  if (!process.connected) return;
  try { process.send(message); } catch { /* 父进程已经走了 */ }
}

function finish(exitCode, signal, error) {
  if (ending) return;
  ending = true;
  let sent = false;
  try {
    if (process.connected) {
      process.send({ type: "end", exitCode, signal, error }, exitNow);
      sent = true;
    }
  } catch {
    // 通道已关，直接退出。
  }
  if (!sent) exitNow();
  // 发送回调在管道已关闭时不一定会触发，兜底保证 host 不会挂住。
  else setTimeout(exitNow, 1000).unref?.();
}

function stop() {
  if (!terminal) return finish(1);
  try {
    terminal.kill();
  } catch (error) {
    finish(1, undefined, error?.message);
    return;
  }
  // kill 之后 onExit 迟迟不来（子进程忽略信号、ConPTY 回收慢）时强制退出，
  // 否则父进程只能等兜底的强杀，每个终端都会多留一个进程。
  setTimeout(() => finish(1, undefined, "终端未在预期时间内退出。"), 2000).unref?.();
}

process.on("message", (message) => {
  if (ending || !message || typeof message !== "object") return;
  try {
    if (message.type === "start" && !terminal) {
      terminal = require("@lydell/node-pty").spawn(message.shell, message.args, {
        cwd: message.cwd, env: message.env, cols: 120, rows: 40, name: "xterm-256color",
      });
      terminal.onData((text) => {
        if (ending) return;
        post({ type: "output", text });
      });
      terminal.onExit(({ exitCode, signal }) => finish(exitCode, signal));
      post({ type: "ready" });
    } else if (message.type === "input") terminal?.write(message.text);
    else if (message.type === "stop") stop();
  } catch (error) { finish(1, undefined, error.message); }
});
process.once("disconnect", () => { if (!ending) stop(); });
