import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_STALL_MS, type MonitoredSubagent } from "./subagentMonitorModel";
import { SubagentMonitorView } from "./SubagentMonitor";

const subagent = (overrides: Partial<MonitoredSubagent> = {}): MonitoredSubagent => ({
  id: "s1",
  label: "Reviewer",
  status: "running",
  message: "正在运行 read 工具",
  model: "deepseek-chat",
  startedAt: 1_000,
  lastActivityAt: 61_000,
  messageId: "m1",
  entryId: "e1",
  ...overrides,
});

function render(options: {
  subagents: MonitoredSubagent[];
  now?: number;
  open?: boolean;
  selectedId?: string | null;
}) {
  return renderToStaticMarkup(createElement(SubagentMonitorView, {
    subagents: options.subagents,
    now: options.now ?? 121_000,
    open: options.open ?? false,
    selectedId: options.selectedId ?? null,
    onToggle: vi.fn(),
    onClose: vi.fn(),
    onSelect: vi.fn(),
  }));
}

describe("SubagentMonitor", () => {
  it("没有运行中的子任务时完全不渲染", () => {
    expect(render({ subagents: [] })).toBe("");
  });

  // 默认收起：只给胶囊，不铺开详情，避免挡聊天。
  it("收起时只渲染胶囊与总耗时", () => {
    const html = render({ subagents: [subagent(), subagent({ id: "s2", label: "Scout", startedAt: 10_000 })] });

    expect(html).toContain("个 Subagent 运行中");
    expect(html).toContain("subagent-monitor-pill");
    expect(html).toContain("2m"); // now(121s) - min(startedAt=1s)
    expect(html).not.toContain("subagent-monitor-panel");
  });

  it("展开后显示任务列表、当前活动与实时输出", () => {
    const html = render({
      subagents: [
        subagent({ liveOutput: "正在读取 src/lib/foo.ts" }),
        subagent({ id: "s2", label: "Scout", status: "pending", startedAt: undefined, completedAt: undefined }),
      ],
      open: true,
    });

    expect(html).toContain("subagent-monitor-panel");
    expect(html).toContain("Reviewer");
    expect(html).toContain("Scout");
    expect(html).toContain("正在运行 read 工具");
    expect(html).toContain("正在读取 src/lib/foo.ts");
    expect(html).toContain("deepseek-chat");
  });

  it("超过阈值没有活动时标出可能卡住", () => {
    const stalled = render({
      subagents: [subagent({ lastActivityAt: 1_000 })],
      now: 1_000 + SUBAGENT_STALL_MS + 1_000,
      open: true,
    });
    expect(stalled).toContain("可能已卡住");
    expect(stalled).toContain("subagent-monitor-dot stalled");

    const healthy = render({
      subagents: [subagent({ lastActivityAt: 1_000 })],
      now: 1_000 + SUBAGENT_STALL_MS - 1_000,
      open: true,
    });
    expect(healthy).not.toContain("可能已卡住");
  });

  it("选中的任务不在列表里时回落到第一个", () => {
    const html = render({
      subagents: [subagent({ id: "s1", label: "Reviewer" })],
      selectedId: "gone",
      open: true,
    });
    expect(html).toContain("Reviewer");
  });
});
