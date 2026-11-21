import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const opencode = read("./opencode/backend.ts");
const claudeWorker = read("./claude/worker.mjs");
const codexWorker = read("./codex/worker.mjs");
const controller = read("../agents/context-compaction-controller.ts");

/**
 * 压缩「等不到结束事件」时的收尾语义。
 *
 * 三家后端都是 worker/RPC 模式：命令本身有 180s 超时。如果等了 3 分钟还没等到
 * 结束事件，说明压缩其实没跑成（CLI 卡住、上游挂死、事件流断开）。
 * 这时候绝不能：
 * 1. 给界面补一条「已完成」——用户会以为压缩成功，实际上下文一点没少；
 * 2. 让主进程的压缩控制器继续按「正在压缩」屏蔽用量读数——该会话的阈值从此静默失效。
 */
describe("压缩超时不能伪造完成", () => {
  it("OpenCode 的超时走失败分支，而不是只打一条 warn", () => {
    expect(opencode).toContain("if (failure) throw new Error(failure);");
    // 反向断言：超时曾经只 warn 就返回，界面会一直停在「压缩中」。
    expect(opencode).not.toContain('if (failure) console.warn("[opencode] compaction did not complete:", failure);');
  });

  it("Claude 的兜底超时如实报失败", () => {
    expect(claudeWorker).toContain("const settleTimeoutMs = 165_000;");
    expect(claudeWorker).toContain('finishManualCompaction(');
    expect(claudeWorker).toContain("压缩超时：Claude Code 未在");
    // 反向断言：不能再把「没等到 boundary」当成完成。
    expect(claudeWorker).not.toContain('if (manualCompactSettle) {\n          finishManualCompaction("completed");');
  });

  it("Codex 的兜底超时如实报失败", () => {
    expect(codexWorker).toContain("const settleTimeoutMs = 165_000;");
    expect(codexWorker).toContain('send({ type: "context_compaction", id: compactionId, phase: "failed", detail });');
    // 反向断言：不能再「超时也放行，直接发 completed」。
    expect(codexWorker).not.toContain("超时也放行，避免界面一直卡住");
  });

  it("两家的兜底都要早于宿主的 180s 命令超时", () => {
    expect(claudeWorker).not.toContain("5 * 60 * 1000");
    // 165s < 180s：失败原因来自后端自己，而不是宿主的通用超时。
    expect(claudeWorker).toContain("settleTimeoutMs");
    expect(codexWorker).toContain("settleTimeoutMs");
  });
});

describe("压缩失败后要解除用量压制", () => {
  it("控制器在 compact() 失败时清掉 compactionActive", () => {
    const catchBlock = controller.slice(controller.indexOf(".catch((error: unknown) => {"));
    expect(catchBlock.slice(0, 900)).toContain("state.compactionActive = false;");
  });
});
