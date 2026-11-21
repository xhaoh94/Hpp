import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const backend = readFileSync(new URL("./backend.ts", import.meta.url), "utf8");

/**
 * 压缩（摘要）请求会把压缩前的整段历史发给模型，它自己上报的 token_usage
 * 输入量 ≈ 压缩前的上下文大小。如果把这个读数当成「当前上下文占用」，
 * 上下文圆环就会停在压缩前的大小，看起来像「显示压缩、实际没压缩」。
 *
 * 所以摘要消息的 usage 必须带 `compaction: true` 标记：只计入 Token 统计，
 * 不刷新上下文占用（渲染层 agentEventDispatcher / 主进程压缩控制器都认这个标记）。
 */
describe("OpenCode 压缩请求的用量", () => {
  it("上报时打上 compaction 标记", () => {
    expect(backend).toContain("private emitPartTokenUsageDelta(part: UnknownRecord, fromCompaction = false)");
    expect(backend).toContain("...(fromCompaction ? { compaction: true } : {})");
  });

  it("摘要消息分支明确传 true", () => {
    expect(backend).toContain("this.emitPartTokenUsageDelta(part, true);");
    expect(backend).toContain("this.emitPartTokenUsageDelta(part, this.isCompactionMessageId(partMessageId));");
  });
});

/**
 * 主进程的智能压缩靠 usedTokens / contextWindow 算比例。OpenCode 的用量事件
 * （1.x 的 part.tokens、2.x 的 step.ended）都不带窗口 —— 后端必须自己补，
 * 少这一份就是「用量一直在涨、阈值永远不触发」且完全没有日志的静默失效。
 */
describe("OpenCode 用量事件的上下文窗口", () => {
  it("两条 token_usage 路径都补窗口", () => {
    expect(backend).toContain("const contextWindow = this.resolveContextWindow();");
    expect(backend).toContain("...(contextWindow ? { contextWindow } : {}),");
    // 反向断言：不能再退回「必须有 currentModelId + 目录已加载」才算窗口的写法。
    expect(backend).not.toContain(
      "item.provider === this.currentProviderId && item.id === this.currentModelId",
    );
  });

  it("currentModel 缺失时用运行中步骤上报的模型兜底", () => {
    expect(backend).toContain("private activeResponseModel");
    expect(backend).toContain("this.rememberResponseModel(info);");
    expect(backend).toContain("this.lookupContextWindow(this.activeResponseModel?.provider, this.activeResponseModel?.id)");
  });
});

/**
 * 2.x 的 /compact 只是「受理」，真正执行是一次独立 execution，结束信号只走 SSE。
 * Hpp 的 SSE 随回合开关，空闲时早断了 —— compact() 必须自己开流并等结束事件，
 * 否则请求发出去、压缩也真跑了，界面却永远停在「压缩中」。
 */
describe("OpenCode 2.x 的压缩收尾", () => {
  it("空闲压缩自己开事件流并等结束事件", () => {
    expect(backend).toContain("await this.startSSEListener();");
    expect(backend).toContain("const settled = this.waitCompactionSettled(175_000);");
    expect(backend).toContain("const failure = await settled;");
    // 反向断言：不能再「POST 完就直接返回」。
    expect(backend).not.toContain('if (this.protocol.id !== "v2") this.emitCompactionFinished(compactionId);\n  }');
  });

  it("结束事件先断流再收尾，让 idle 探测立刻看到空闲", () => {
    expect(backend).toContain("if (!this.turnActive) this.stopSSEListener();");
    expect(backend).toContain("this.settleCompaction(failure);");
  });
});
