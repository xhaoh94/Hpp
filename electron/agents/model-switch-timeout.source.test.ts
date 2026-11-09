import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const managerSource = read("./agent-manager.ts");
const piBackendSource = read("../plugin-backends/pi/backend.ts");

const readConstant = (source: string, name: string) => {
  const match = new RegExp(`${name}\\s*=\\s*([\\d_]+)`).exec(source);
  return Number((match?.[1] || "").replace(/_/g, ""));
};

describe("切模型与上下文压缩的超时口径", () => {
  // 后端等压缩的时间比 RPC 超时长 = 前端先判失败、后端稍后才把模型切掉，
  // UI 不落盘也不对齐思考等级，模型状态直接分叉。
  it("切模型 RPC 的超时长于后端等压缩的上限", () => {
    const modelSwitchTimeout = readConstant(managerSource, "AGENT_MODEL_SWITCH_TIMEOUT_MS");
    const compactionWait = readConstant(piBackendSource, "PI_COMPACTION_MODEL_WAIT_MS");

    expect(modelSwitchTimeout).toBeGreaterThan(compactionWait);
  });

  it("setModel 处理器用的是专用的切模型超时", () => {
    const handler = managerSource.slice(
      managerSource.indexOf('ipcMain.handle("agent:setModel"'),
      managerSource.indexOf('ipcMain.handle("agent:setThinkingLevel"'),
    );

    expect(handler).toContain("AGENT_MODEL_SWITCH_TIMEOUT_MS");
    expect(handler).not.toContain("AGENT_BACKEND_CALL_TIMEOUT_MS");
  });

  // 同步等到底：不再由后端自己判超时后抛 SESSION_BUSY，否则前端看到的是
  // 「切换超时」而后端随后仍完成了切换。
  it("pi 切模型同步等压缩结束，不自己判超时", () => {
    const setModel = piBackendSource.slice(
      piBackendSource.indexOf("async setModel"),
      piBackendSource.indexOf("async setThinkingLevel"),
    );

    expect(setModel).toContain("await this.waitForCompactionIdle();");
    expect(setModel).not.toContain("SESSION_BUSY");
    expect(setModel).not.toContain("PI_COMPACTION_MODEL_WAIT_MS");
  });

  // 列模型不能无界等待：压缩期间拉目录必须能放弃，否则会话初始化被拖死。
  it("列模型仍保留有界等待", () => {
    expect(piBackendSource).toContain("this.waitForCompactionIdle(PI_COMPACTION_MODEL_WAIT_MS)");
  });
});
