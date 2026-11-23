import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSubagent, ChatMessage } from "@/stores/chat-store";
import {
  BACKGROUND_SUBAGENT_STALL_MS,
  collectRunningSubagents,
  collectSubagents,
  formatIdleAgo,
  formatSubagentCost,
  formatSubagentModel,
  formatSubagentUsage,
  getSubagentCacheRate,
  getSubagentElapsedMs,
  getSubagentIdleMs,
  isSubagentStalled,
  SUBAGENT_STALL_MS,
  summarizeSubagentCosts,
} from "./subagentMonitorModel";

const subagent = (overrides: Partial<AgentSubagent> = {}): AgentSubagent => ({
  id: "call-1:1",
  label: "Reviewer",
  status: "running",
  message: "正在运行 read 工具",
  startedAt: 1_000,
  lastActivityAt: 1_000,
  ...overrides,
});

const message = (id: string, subagents: AgentSubagent[]): ChatMessage => ({
  id,
  role: "assistant",
  content: "",
  timestamp: 1,
  process: {
    startedAt: 1,
    entries: [{
      id: `${id}-entry`,
      type: "subagent",
      title: "Subagent",
      timestamp: 1,
      subagents,
    }],
  },
});

describe("Subagent 监视窗数据", () => {
  it("只收集运行中/等待中的子任务", () => {
    const running = collectRunningSubagents([
      message("m1", [
        subagent({ id: "a", status: "running" }),
        subagent({ id: "b", status: "pending" }),
        subagent({ id: "c", status: "completed" }),
        subagent({ id: "d", status: "error" }),
      ]),
    ]);

    expect(running.map((item) => item.id)).toEqual(["a", "b"]);
    expect(running[0].messageId).toBe("m1");
    expect(running[0].entryId).toBe("m1-entry");
  });

  // 进度事件会反复更新同一个子任务，后出现的条目才算最新状态。
  it("同一子任务以最后一条进程条目为准", () => {
    const running = collectRunningSubagents([
      message("m1", [subagent({ id: "a", message: "旧活动" })]),
      message("m2", [subagent({ id: "a", message: "新活动", lastActivityAt: 2_000 })]),
    ]);

    expect(running).toHaveLength(1);
    expect(running[0].message).toBe("新活动");
    expect(running[0].messageId).toBe("m2");
  });

  it("会话结束时（任务已终态）不返回任何内容", () => {
    expect(collectRunningSubagents([message("m1", [subagent({ status: "completed" })])])).toEqual([]);
    expect(collectRunningSubagents([])).toEqual([]);
  });

  // 旧数据里残留的占位项永远不会收到终态事件；条目都结束了就别再给它开页签。
  it("条目已结束时忽略残留的 running 子任务", () => {
    const finished = message("m1", [
      subagent({ id: "call-1", label: "Subagent", status: "running" }),
      subagent({ id: "call-1:1", status: "completed" }),
    ]);
    finished.process!.entries[0].state = "completed";
    expect(collectRunningSubagents([finished])).toEqual([]);
  });

  it("耗时按任务自己的 startedAt 算，完成后冻结在 completedAt", () => {
    expect(getSubagentElapsedMs(subagent({ startedAt: 1_000 }), 61_000)).toBe(60_000);
    expect(getSubagentElapsedMs(subagent({ startedAt: 1_000, completedAt: 31_000 }), 99_000)).toBe(30_000);
    // 老后端没有 startedAt：不硬造数字。
    expect(getSubagentElapsedMs({ id: "x", label: "X" }, 9_999)).toBeUndefined();
  });

  it("超过阈值没有活动就判定为可能卡住", () => {
    const running = subagent({ status: "running", lastActivityAt: 1_000 });
    expect(getSubagentIdleMs(running, 1_000 + SUBAGENT_STALL_MS - 1)).toBe(SUBAGENT_STALL_MS - 1);
    expect(isSubagentStalled(running, 1_000 + SUBAGENT_STALL_MS - 1)).toBe(false);
    expect(isSubagentStalled(running, 1_000 + SUBAGENT_STALL_MS)).toBe(true);
    // 已结束的任务不提示卡住。
    expect(isSubagentStalled(subagent({ status: "completed", lastActivityAt: 1_000 }), 999_999)).toBe(false);
  });

  it("最后活动时长的文案分秒/分", () => {
    expect(formatIdleAgo(3_000)).toBe("3 秒前");
    expect(formatIdleAgo(59_000)).toBe("59 秒前");
    expect(formatIdleAgo(8 * 60_000)).toBe("8 分钟前");
    expect(formatIdleAgo(2 * 60 * 60_000)).toBe("2 小时前");
  });
});

describe("子任务消耗摘要", () => {
  it("拼出 token / 缓存命中 / 轮次", () => {
    expect(formatSubagentUsage({
      inputTokens: 12_000,
      outputTokens: 3_400,
      cacheReadTokens: 10_440,
      totalTokens: 15_400,
      turns: 3,
    })).toBe("15.4k token · 缓存 87% · 3 轮");
  });

  it("后端只报 input/output 时自己算总数", () => {
    // pi 的 usage 没有 totalTokens，不补的话只会显示轮次
    expect(formatSubagentUsage({ inputTokens: 512, outputTokens: 128, turns: 1 }))
      .toBe("640 token · 1 轮");
  });

  it("没有缓存数据时不写缓存率，空用量返回空串", () => {
    expect(formatSubagentUsage({ inputTokens: 800 })).toBe("800 token");
    expect(formatSubagentUsage({})).toBe("");
    expect(formatSubagentUsage(undefined)).toBe("");
  });

  it("缓存率落在 0..1 且没有输入时为 undefined", () => {
    expect(getSubagentCacheRate({ inputTokens: 100, cacheReadTokens: 250 })).toBe(1);
    expect(getSubagentCacheRate({ inputTokens: 4, cacheReadTokens: 1 })).toBe(0.25);
    expect(getSubagentCacheRate({ outputTokens: 10 })).toBeUndefined();
    expect(getSubagentCacheRate(undefined)).toBeUndefined();
  });

  it("模型名原样展示，不加方括号，空值不占位", () => {
    expect(formatSubagentModel("codebuddy/gpt-5")).toBe("codebuddy/gpt-5");
    expect(formatSubagentModel("gpt-5")).toBe("gpt-5");
    expect(formatSubagentModel("  ")).toBe("");
    expect(formatSubagentModel(undefined)).toBe("");
  });
});

describe("subagent monitor panel layout", () => {
  const css = readFileSync(resolve(process.cwd(), "src/components/layout/SubagentMonitor.css"), "utf8");
  const rule = (selector: string) => css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));

  it("pins the task list above the scrolling detail so long output cannot hide it", () => {
    expect(rule(".subagent-monitor-body")).toContain("flex: 1");
    expect(rule(".subagent-monitor-body")).toContain("min-height: 0");
    // 列表固定、详情吃掉剩余空间；滚动交给 detail-scroll 子元素。
    expect(rule(".subagent-monitor-list")).toContain("flex: 0 0 auto");
    expect(rule(".subagent-monitor-detail")).toContain("flex: 1");
    expect(rule(".subagent-monitor-detail-scroll")).toContain("overflow-y: auto");
  });

  it("keeps list rows single-line with only label and elapsed time", () => {
    const monitor = readFileSync(resolve(process.cwd(), "src/components/layout/SubagentMonitor.tsx"), "utf8");
    // 列表项不再渲染 token 统计（详情区仍有）。
    const listBlock = monitor.slice(monitor.indexOf("<ul className=\"subagent-monitor-list\">"), monitor.indexOf("</ul>"));
    expect(listBlock).not.toContain("subagent-monitor-item-main");
    expect(listBlock).not.toContain("subagent-monitor-item-usage");
    expect(listBlock).toContain("subagent-monitor-item-label");
    expect(listBlock).not.toContain("subagent-monitor-item-time");
    // 页签自动换行、所有子任务可见，不横向滚动（滚动条时隐时现会抖）。
    expect(rule(".subagent-monitor-list")).toContain("flex-wrap: wrap");
    expect(rule(".subagent-monitor-list")).not.toContain("overflow-x");
    expect(rule(".subagent-monitor-item")).toContain("width: auto");
    expect(css).not.toContain(".subagent-monitor-item-main");
    expect(css).not.toContain(".subagent-monitor-item-usage");
  });

  it("keeps a dynamic panel height but pins meta above the detail body", () => {
    // 动态高度（内容少时不留空白），max-height 封顶；抖动靠各行固定高度解决。
    expect(rule(".subagent-monitor-panel")).toContain("max-height: min(");
    expect(rule(".subagent-monitor-panel")).not.toContain("\n  height: min(");
    // 固定 meta（消耗/最后活动）不随内容滚。
    const monitor = readFileSync(resolve(process.cwd(), "src/components/layout/SubagentMonitor.tsx"), "utf8");
    expect(monitor).toContain('className="subagent-monitor-detail-meta"');
    expect(monitor).toContain('className="subagent-monitor-detail-scroll"');
    const metaBlock = monitor.slice(monitor.indexOf('<div className="subagent-monitor-detail-meta">'), monitor.indexOf('className="subagent-monitor-detail-scroll"'));
    expect(metaBlock).toContain("最后活动");
    expect(rule(".subagent-monitor-detail-meta")).toContain("flex: 0 0 auto");
    // 滚动职责只在 scroll 子元素，detail 自身不滚。
    expect(rule(".subagent-monitor-detail")).not.toContain("overflow-y");
  });

  it("pins activity and output to single lines, drops tab time, and marks completed green", () => {
    const monitor = readFileSync(resolve(process.cwd(), "src/components/layout/SubagentMonitor.tsx"), "utf8");
    // 页签不再显示运行时间（CSS 里可能留着旧规则，查 JSX 列表块即可）。
    const listBlock = monitor.slice(monitor.indexOf("<ul className=\"subagent-monitor-list\">"), monitor.indexOf("</ul>"));
    expect(listBlock).not.toContain("subagent-monitor-item-time");
    // activity 固定单行、取最后一行非空文字。
    expect(rule(".subagent-monitor-activity")).toContain("white-space: nowrap");
    expect(monitor).toContain("activityLines[activityLines.length - 1]");
    // 输出默认单行预览，点击展开渲染 Markdown。
    expect(monitor).toContain('import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer"');
    expect(monitor).toContain('className={`subagent-monitor-output ${outputExpanded ? "expanded" : ""}`}');
    expect(monitor).toContain("setOutputExpanded((v) => !v)");
    expect(monitor).toContain("<MarkdownRenderer content={selected.liveOutput} deferHighlight />");
    expect(monitor).toContain("subagent-monitor-output-line");
    expect(rule(".subagent-monitor-output-line")).toContain("white-space: nowrap");
    expect(rule(".subagent-monitor-output.expanded")).toContain("max-height: 220px");
    // md 样式在输出区内 scoped 压小，不动全局 .md-content。
    expect(rule(".subagent-monitor-output .md-content")).toContain("font-size: 11px");
    // 已完成的圆点是绿色。
    expect(rule(".subagent-monitor-dot.completed")).toContain("#22c55e");
  });

  it("shows the concrete task title instead of the fixed agent label", () => {
    const monitor = readFileSync(resolve(process.cwd(), "src/components/layout/SubagentMonitor.tsx"), "utf8");
    const block = readFileSync(resolve(process.cwd(), "src/components/layout/ProcessBlock.tsx"), "utf8");
    // 页签 + 详情头 + 聊天胶囊三处都用同一个标题出口（title 也要压缩），label 退到 title 提示。
    expect(monitor).toContain('className="subagent-monitor-item-label" title={subagent.label}');
    expect(monitor).toContain("{getSubagentDisplayTitle(subagent)}");
    expect(monitor).toContain("{getSubagentDisplayTitle(selected)}");
    expect(block).toContain("{getSubagentDisplayTitle(subagent)}");
    expect(block).toContain("subagent.label,\n  formatSubagentStatusLabel(subagent.status, subagent.stopReason),");
    // 胶囊的原生 title 不塞 message：长输出走点击展开（markdown 渲染），
    // 塞回 title 就会退回「一大坨源码」的系统 tooltip。
    expect(block).not.toContain("subagent.message,\n].filter(Boolean)");
  });

  it("closes on outside click without treating panel scroll as outside", () => {
    const monitor = readFileSync(resolve(process.cwd(), "src/components/layout/SubagentMonitor.tsx"), "utf8");
    // 两个 ref 覆盖胶囊与浮层；只在 open 时挂 mousedown，点两者之外才关。
    expect(monitor).toContain("const pillRef = useRef<HTMLButtonElement | null>(null)");
    expect(monitor).toContain("const panelRef = useRef<HTMLDivElement | null>(null)");
    expect(monitor).toContain('document.addEventListener("mousedown", handleMouseDown)');
    expect(monitor).toContain("pillRef.current?.contains(target) || panelRef.current?.contains(target)");
    expect(monitor).toContain("if (!open) return;");
    // 没有 scroll/resize 关闭逻辑（详情区要能滚）。
    expect(monitor).not.toContain('window.addEventListener("scroll"');
    expect(monitor).not.toContain('window.addEventListener("resize"');
  });

  it("后台任务按模型汇总消耗", () => {
    const all = collectSubagents([
      message("m1", [
        subagent({ id: "a", model: "pool/fast", status: "completed", usage: { inputTokens: 100, cacheReadTokens: 40, outputTokens: 20, cost: 0.001 } }),
        subagent({ id: "b", model: "pool/fast", status: "completed", usage: { inputTokens: 50, cacheReadTokens: 0, outputTokens: 10, cost: 0.002 } }),
        subagent({ id: "c", model: "pool/deep", status: "completed", usage: { inputTokens: 10, outputTokens: 5, cost: 0.02 } }),
      ]),
    ]);
    const costs = summarizeSubagentCosts(all);
    expect(costs[0]).toMatchObject({
      model: "pool/deep",
      tasks: 1,
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.02,
    });
    expect(costs[1]).toMatchObject({
      model: "pool/fast",
      tasks: 2,
      inputTokens: 150,
      cacheReadTokens: 40,
      outputTokens: 30,
      cost: 0.003,
    });
    expect(formatSubagentCost(0.003)).toBe("$0.0030");
    expect(formatSubagentCost(1.234)).toBe("$1.23");
    expect(formatSubagentCost(0)).toBe("");
  });

  it("后台任务的停滞阈值放宽到 10 分钟", () => {
    const background = subagent({ status: "running", background: true, startedAt: 1, lastActivityAt: 1 });
    expect(isSubagentStalled(background, SUBAGENT_STALL_MS + 1)).toBe(false);
    expect(isSubagentStalled(background, BACKGROUND_SUBAGENT_STALL_MS + 1)).toBe(true);
    const foreground = subagent({ status: "running", startedAt: 1, lastActivityAt: 1 });
    expect(isSubagentStalled(foreground, SUBAGENT_STALL_MS + 1)).toBe(true);
  });
});
