import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const controllerSource = readFileSync(
  resolve(process.cwd(), "electron/agents/context-compaction-controller.ts"),
  "utf8",
);
const managerSource = readFileSync(resolve(process.cwd(), "electron/agents/agent-manager.ts"), "utf8");
const preloadSource = readFileSync(resolve(process.cwd(), "electron/preload.ts"), "utf8");
const chatPanelSource = readFileSync(
  resolve(process.cwd(), "src/components/layout/ChatPanel.tsx"),
  "utf8",
);
const ipcTypesSource = readFileSync(resolve(process.cwd(), "src/types/index.ts"), "utf8");

/**
 * 自动压缩要「用量 / 窗口」两个数。窗口只有渲染层一定知道（模型目录），
 * 后端上报的用量事件不一定带 —— 缺这一份就是「用量一直在涨、阈值永远不触发」
 * 且没有任何日志的静默失效。所以渲染层必须把窗口同步给主进程。
 */
describe("上下文窗口的渲染层兜底", () => {
  it("渲染层把模型目录里的窗口同步给主进程", () => {
    expect(chatPanelSource).toContain("window.electronAPI.agentSyncContextWindow");
    expect(chatPanelSource).toContain("currentModel?.contextWindow");
    // 同一个窗口不重复发：按「会话 + 渠道 + 模型 + 窗口」去重。
    expect(chatPanelSource).toContain("syncedContextWindowRef");
    expect(preloadSource).toContain('ipcRenderer.invoke("agent:syncSessionContextWindow"');
    expect(ipcTypesSource).toContain("agentSyncContextWindow:");
    expect(managerSource).toContain('ipcMain.handle("agent:syncSessionContextWindow"');
  });

  it("主进程只补窗口，不拿它当触发条件", () => {
    expect(managerSource).toContain("setSessionContextWindow(");
    expect(controllerSource).toContain("setSessionContextWindow(sessionId: string, value: unknown)");
    // 反向断言：补窗口不能顺手评估/压缩。触发点只认回合边界或新读数。
    const method = controllerSource.slice(
      controllerSource.indexOf("setSessionContextWindow(sessionId: string, value: unknown)"),
    );
    const body = method.slice(0, method.indexOf("\n  }\n"));
    // 先确认截到的确实是这个方法体，否则下面的反向断言会空跑。
    expect(body).toContain("state.contextWindow = contextWindow;");
    expect(body).not.toContain("tryCompact");
    expect(body).not.toContain("updateLatch");
  });

  it("切模型的瞬间不把旧目录的窗口写进新作用域", () => {
    // 渲染层会把 model 一起带上；主进程发现与会话已知模型不一致就丢弃。
    expect(chatPanelSource).toContain("provider: currentModel.provider");
    expect(managerSource).toContain("current.provider !== scoped.provider || current.id !== scoped.id");
  });
});

/**
 * 手动中断（aborted）是「回合结束」的一种，但终止事件同步发出时宿主那份
 * isIdle() 缓存还没翻成 true，而且中断之后不会再有 backend_idle。
 * 只判一次就等于这次中断永远不触发压缩。
 */
describe("中断之后的自动压缩", () => {
  it("后端还没空闲时继续等，而不是直接放弃", () => {
    expect(controllerSource).toContain("scheduleIdleRetry(sessionId, state)");
    expect(controllerSource).toContain("IDLE_RETRY_MAX_ATTEMPTS");
    // 反向断言：不能再「不 idle 就直接 return」。
    expect(controllerSource).not.toContain("if (!backend.isIdle()) return;");
  });

  it("新回合开始就停手，等那一回合结束再判定", () => {
    expect(controllerSource).toContain("state.idleRetryAttempt = 0;");
    expect(controllerSource).toContain("if (state.turnActive || state.compacting || !state.armed) return;");
  });

  it("会话关闭 / 运行时重置时清掉计时器", () => {
    // 两个计时器都要清：等空闲的重试、以及压缩看门狗。
    const forgetBody = controllerSource.slice(
      controllerSource.indexOf("forget(sessionId: string): void"),
      controllerSource.indexOf("private resetUsage("),
    );
    expect(forgetBody).toContain("this.clearIdleRetry(state);");
    expect(forgetBody).toContain("this.clearCompactionWatchdog(state);");

    const resetBody = controllerSource.slice(
      controllerSource.indexOf("reset(): void"),
      controllerSource.indexOf("private getState("),
    );
    expect(resetBody).toContain("this.clearIdleRetry(state);");
    expect(resetBody).toContain("this.clearCompactionWatchdog(state);");
  });
});
