import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import type { AgentProcess } from "@/stores/chat-store";
import { createComposerDocument } from "@shared/composer-document";
import { ASSISTANT_NARRATION_PROCESS_KIND } from "@shared/process-view";
import {
  formatIdleDuration,
  getStickyButtonStackHeight,
  getStickyAdjustedScrollTop,
  getStickyVisualCorrectionScrollTop,
  isRenderedContentOverLineLimit,
  isThinkingPastStickyBoundary,
  ProcessBlock,
} from "./ProcessBlock";

const createProcess = (expanded: boolean, includeAgentNarration = false): AgentProcess => ({
  startedAt: 1,
  endedAt: 2,
  expanded,
  entries: [
    {
      id: "status-1",
      type: "status",
      title: "Codex is processing",
      state: "completed",
      timestamp: 10,
    },
    ...(includeAgentNarration ? [{
      id: "agent-narration-1",
      type: "info" as const,
      kind: ASSISTANT_NARRATION_PROCESS_KIND,
      title: "任意标题",
      detail: "其他 Agent 发出的运行中说明。",
      state: "completed" as const,
      timestamp: 15,
    }] : []),
  ],
});

const renderProcess = (expanded: boolean) => renderToStaticMarkup(createElement(ProcessBlock, {
  messageId: "assistant-1",
  process: createProcess(expanded),
  commentary: [{
    id: "commentary-1",
    content: "我先检查项目里的发布脚本。",
    timestamp: 20,
    isStreaming: false,
  }],
  onToggle: vi.fn(),
  onToggleEntry: vi.fn(),
  onOpenFile: vi.fn(),
  onPreserveScroll: (action) => action(),
}));

describe("ProcessBlock", () => {
  it("keeps the thinking-row callback ref stable across sticky-state renders", () => {
    const source = readFileSync(resolve("src/components/layout/ProcessBlock.tsx"), "utf8");
    expect(source).toContain("const thinkingRowRef = useCallback");
    expect(source).toContain("ref={thinkingRowRef}");
    expect(source).not.toContain("ref={(el) => onThinkingRowRef?.(entry.id, el)}");
  });

  it("subtracts the active sticky stack when calculating a jump target", () => {
    expect(getStickyAdjustedScrollTop(300, 500, 100, 44)).toBe(636);
    expect(getStickyAdjustedScrollTop(10, 20, 100, 44)).toBe(0);
  });

  it("corrects the final target against the sticky controls' visual bottom", () => {
    expect(getStickyVisualCorrectionScrollTop(500, 94, 62)).toBe(512);
    expect(getStickyVisualCorrectionScrollTop(10, 20, 100)).toBe(0);
  });

  it("renders multiple sticky-thinking locators in document order", () => {
    const source = readFileSync(resolve("src/components/layout/ProcessBlock.tsx"), "utf8");
    const styles = readFileSync(resolve("src/components/layout/ChatPanel.css"), "utf8");
    expect(source).toContain("const sortedStuckThinkingIds = useMemo");
    expect(source).toContain("chat-process-sticky-thinking-list");
    expect(source).toContain("定位到第 ${index + 1} 条思考");
    expect(styles).toContain("--chat-process-thinking-button-width: 44px");
    expect(styles).toContain("--chat-content-horizontal-gutter: 104px");
    expect(styles).toContain("width: calc(100% - var(--chat-content-horizontal-gutter))");
    expect(styles).not.toContain("--chat-content-max-width");
    expect(styles).toContain("margin-left: calc(0px - var(--chat-process-thinking-rail-width))");
    expect(styles).not.toContain("padding-left: var(--chat-process-thinking-rail-width)");
    expect(styles).not.toContain("max-height: min(30vh, 160px)");
  });

  it("keeps the compact process locator in the same left rail as thinking locators", () => {
    const source = readFileSync(resolve("src/components/layout/ProcessBlock.tsx"), "utf8");
    const styles = readFileSync(resolve("src/components/layout/ChatPanel.css"), "utf8");
    expect(source).toContain('<path d="m6 15 6-6 6 6" />');
    expect(source).not.toContain('<span>{interrupted ? "中断" : "耗时"}</span>');
    const processLocatorStyles = styles.slice(
      styles.indexOf(".chat-process-sticky-toggle {"),
      styles.indexOf(".chat-process-sticky-toggle:hover"),
    );
    expect(processLocatorStyles).toContain("width: var(--chat-process-thinking-button-width)");
    expect(processLocatorStyles).toContain("margin-left: calc(0px - var(--chat-process-thinking-rail-width))");
  });

  it("only keeps an expanded thinking entry while its body crosses the sticky boundary", () => {
    expect(isThinkingPastStickyBoundary(79, 240, 80, true)).toBe(true);
    expect(isThinkingPastStickyBoundary(-500, 79, 80, true)).toBe(false);
    expect(isThinkingPastStickyBoundary(81, 240, 80, true)).toBe(false);
    expect(isThinkingPastStickyBoundary(79, 240, 80, false)).toBe(false);
  });

  it("only enables thinking locators for content taller than ten rendered lines", () => {
    expect(isRenderedContentOverLineLimit(230, 23)).toBe(false);
    expect(isRenderedContentOverLineLimit(230.1, 23)).toBe(true);
    expect(isRenderedContentOverLineLimit(460, 23, 20)).toBe(false);
    expect(isRenderedContentOverLineLimit(461, 23, 20)).toBe(true);
  });

  it("gates the process return-to-top locator behind the same ten-line limit", () => {
    const source = readFileSync(resolve("src/components/layout/ProcessBlock.tsx"), "utf8");
    expect(source).toContain("const messageWrap = processWrap?.closest<HTMLElement>(\".chat-msg-wrapper\") || null;");
    expect(source).toContain("const assistantBodyMetrics = getRenderedContentMetrics(");
    expect(source).toContain("const totalContentLines = (expandedRef.current ? renderedProcessLines : 0) +");
    expect(source).toContain("const processStuckNow = messageContentOverTenLines && !!toggle");
    expect(source).toContain("messageWrap.getBoundingClientRect().bottom > processBoundary");
  });

  it("keeps the process locator sticky until the complete assistant message has scrolled past", () => {
    const markup = renderProcess(false);
    const stickyIndex = markup.indexOf('class="chat-process-sticky"');
    const processWrapIndex = markup.indexOf('class="chat-process-wrap"');
    expect(stickyIndex).toBeGreaterThanOrEqual(0);
    expect(processWrapIndex).toBeGreaterThan(stickyIndex);
    expect(markup.match(/data-process-message-id="assistant-1"/g)).toHaveLength(2);

    const styles = readFileSync(resolve("src/components/layout/ChatPanel.css"), "utf8");
    const stickyStyles = styles.slice(
      styles.indexOf(".chat-process-sticky {"),
      styles.indexOf(".chat-process-sticky-inner"),
    );
    expect(stickyStyles).toContain("position: sticky");
    expect(stickyStyles).toContain("margin-bottom: -8px");
  });

  it("includes every thinking locator that remains above the jump target", () => {
    expect(getStickyButtonStackHeight([])).toBe(0);
    expect(getStickyButtonStackHeight([28])).toBe(28);
    expect(getStickyButtonStackHeight([28, 28, 30])).toBe(94);
  });

  it("restarts a breathing highlight on the thinking row after a locator jump", () => {
    const source = readFileSync(resolve("src/components/layout/ProcessBlock.tsx"), "utf8");
    const styles = readFileSync(resolve("src/components/layout/ChatPanel.css"), "utf8");
    expect(source).toContain('row.classList.add("jump-highlight")');
    expect(source).toContain("void row.offsetWidth");
    expect(source).toContain("getStickyVisualBottom(container, target)");
    expect(source).toContain("requestAnimationFrame(() => {");
    expect(source).toContain('behavior: "auto"');
    expect(source).not.toContain("STICKY_NEAR_JUMP_DISTANCE");
    expect(styles).toContain(".chat-process-thinking-row.jump-highlight");
    expect(styles).toContain("chat-thinking-bulb-breathe");
    expect(styles).not.toContain("transform: scale(1.2)");
  });

  it("formats idle durations as a stable mm:ss value", () => {
    expect(formatIdleDuration(0)).toBe("00:00");
    expect(formatIdleDuration(45_900)).toBe("00:45");
    expect(formatIdleDuration(3_661_000)).toBe("61:01");
  });

  it("shows and freezes the idle duration only for stream idle notices", () => {
    const renderNotice = (toolKind: string) => renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: `assistant-${toolKind}`,
      process: {
        startedAt: 1_000,
        endedAt: 50_000,
        expanded: true,
        entries: [{
          id: toolKind,
          type: "status" as const,
          title: "Pi 仍在运行，暂时没有新输出",
          toolKind,
          state: "completed" as const,
          timestamp: 1_000,
          startedAt: 2_000,
          completedAt: 47_900,
        }],
      },
      running: false,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action: () => void) => action(),
    }));

    expect(renderNotice("stream_idle_notice")).toContain("· 00:45");
    expect(renderNotice("stream_idle_notice")).not.toContain("已停滞");
    expect(renderNotice("already_running_notice")).not.toContain("· 00:45");
  });

  it("collapses commentary together with process entries", () => {
    const collapsed = renderProcess(false);
    expect(collapsed).not.toContain("我先检查项目里的发布脚本。");
    expect(collapsed).not.toContain("Codex is processing");

    const expanded = renderProcess(true);
    expect(expanded).toContain("我先检查项目里的发布脚本。");
    expect(expanded).toContain("Codex is processing");
  });

  it("collapses generic narration emitted by other agents", () => {
    const renderAgentProcess = (expanded: boolean) => renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "other-agent-assistant-1",
      process: createProcess(expanded, true),
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(renderAgentProcess(false)).not.toContain("其他 Agent 发出的运行中说明。");
    expect(renderAgentProcess(true)).toContain("其他 Agent 发出的运行中说明。");
  });

  it("renders guidance as a user bubble inside the collapsible process", () => {
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "guidance-1",
        type: "info",
        kind: "user_guidance",
        toolKind: "guidance_message",
        title: "引导",
        detail: "继续检查",
        guidanceDocument: createComposerDocument([
          { id: "text-1", type: "text", text: "继续检查 " },
          { id: "file-1", type: "path", name: "README.md", path: "README.md", kind: "file" },
        ]),
        timestamp: 10,
        state: "completed",
      }],
    };
    const props = {
      messageId: "assistant-guidance",
      process,
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onOpenImage: vi.fn(),
      onPreserveScroll: (action: () => void) => action(),
    };

    const expanded = renderToStaticMarkup(createElement(ProcessBlock, props));
    expect(expanded).toContain("chat-process-guidance-row");
    expect(expanded).toContain("chat-bubble user chat-process-guidance-bubble");
    const guidanceLabelIndex = expanded.indexOf('class="chat-process-guidance-label"');
    const guidanceBubbleIndex = expanded.indexOf('class="chat-bubble user chat-process-guidance-bubble"');
    expect(guidanceLabelIndex).toBeGreaterThan(-1);
    expect(guidanceBubbleIndex).toBeGreaterThan(guidanceLabelIndex);
    expect(expanded).toContain("引导");
    expect(expanded).toContain("继续检查");
    expect(expanded).toContain("README.md");
    expect(expanded).not.toContain("收到引导");

    const collapsed = renderToStaticMarkup(createElement(ProcessBlock, {
      ...props,
      process: { ...process, expanded: false },
    }));
    expect(collapsed).not.toContain("chat-process-guidance-row");
    expect(collapsed).not.toContain("继续检查");
  });

  it("renders thinking directly as Markdown without its title or per-entry disclosure", () => {
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "thinking-markdown",
        type: "thinking",
        title: "正在思考: Planning",
        detail: "**Planning**\n\n- inspect files\n- compare settings\n\n`renderScale`",
        expanded: true,
        state: "completed",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking",
      process,
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(markup).toContain("chat-process-thinking-toggle");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("chat-process-output chat-process-thinking-output");
    expect(markup).toContain("<strong>Planning</strong>");
    expect(markup).toContain("<ul>");
    expect(markup).toContain("md-inline-code");
    expect(markup).not.toContain("**Planning**");
    expect(markup).not.toContain("正在思考: Planning");
    expect(markup).not.toContain("chat-process-entry completed thinking");

    const collapsedMarkup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking-collapsed",
      process: {
        ...process,
        entries: process.entries.map((entry) => ({ ...entry, expanded: false })),
      },
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(collapsedMarkup).toContain('aria-expanded="false"');
    expect(collapsedMarkup).toContain("chat-process-thinking-preview");
    // The collapsed state still renders the single-line Markdown preview,
    // so inline Markdown such as bold is preserved.
    expect(collapsedMarkup).toContain("<strong>Planning</strong>");
    expect(collapsedMarkup).not.toContain("正在思考: Planning");

    const overallCollapsedMarkup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking-overall-collapsed",
      process: { ...process, expanded: false },
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(overallCollapsedMarkup).not.toContain("chat-process-thinking-row");
    expect(overallCollapsedMarkup).not.toContain("<strong>Planning</strong>");
  });

  it("expands multi-line thinking fully without a line cap", () => {
    const longThinking = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 段思考内容`).join("\n\n");
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "thinking-long",
        type: "thinking",
        title: "正在思考",
        detail: longThinking,
        expanded: true,
        state: "completed",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking-long",
      process,
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    // Expanded thinking renders its full body without a line cap or a
    // "显示更多" toggle.
    expect(markup).toContain("chat-process-thinking-body");
    expect(markup).toContain("chat-process-output chat-process-thinking-output");
    expect(markup).not.toContain("limited");
    expect(markup).not.toContain("显示更多");
  });

  it("does not cap single-line thinking", () => {
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "thinking-single",
        type: "thinking",
        title: "正在思考",
        detail: "我正在检查项目文件",
        expanded: true,
        state: "completed",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking-single",
      process,
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(markup).toContain("chat-process-thinking-row expanded single-line");
    expect(markup).not.toContain("chat-process-thinking-body");
    expect(markup).not.toContain("limited");
  });

  it("keeps the collapsed thinking preview without the line cap", () => {
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "thinking-collapsed",
        type: "thinking",
        title: "正在思考",
        detail: Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 段思考内容`).join("\n\n"),
        expanded: false,
        state: "completed",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking-collapsed",
      process,
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(markup).toContain("chat-process-thinking-preview");
    expect(markup).not.toContain("chat-process-thinking-body");
    expect(markup).not.toContain("limited");
  });

  it("collapses thinking by default while running when the setting is off", () => {
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "thinking-running",
        type: "thinking",
        title: "正在思考",
        detail: Array.from({ length: 6 }, (_, i) => `这是第 ${i + 1} 段较长的思考内容，用于验证处理中折叠行为`).join("\n\n"),
        state: "completed",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking-running",
      process,
      commentary: [],
      running: true,
      expandThinkingWhileRunning: false,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(markup).toContain("chat-process-thinking-row collapsed");
    expect(markup).toContain("chat-process-thinking-preview");
    expect(markup).not.toContain("chat-process-thinking-body");
  });

  it("expands thinking while running by default", () => {
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "thinking-running-default",
        type: "thinking",
        title: "正在思考",
        detail: Array.from({ length: 4 }, (_, i) => `处理中自动展开思考的第 ${i + 1} 行，用于验证默认展开行为`).join("\n\n"),
        state: "completed",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking-running-default",
      process,
      commentary: [],
      running: true,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(markup).toContain("chat-process-thinking-row expanded");
    expect(markup).toContain("chat-process-thinking-body");
  });

  it("renders single-line thinking without toggle button", () => {
    const shortThinking = "我正在检查项目文件";
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "thinking-single-line",
        type: "thinking",
        title: "正在思考",
        detail: shortThinking,
        expanded: true,
        state: "completed",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-single-line",
      process,
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    // Single-line thinking should use static span, not button
    expect(markup).toContain("chat-process-thinking-toggle static");
    // The thinking toggle itself should be a span, not a button
    expect(markup).toContain('<span class="chat-process-thinking-toggle static">');
    expect(markup).not.toContain('<button class="chat-process-thinking-toggle"');
    // Should still show the content with markdown renderer
    expect(markup).toContain("chat-process-output chat-process-thinking-output");
    // Should have single-line class
    expect(markup).toContain("single-line");
    // Should not have aria-expanded (no toggle behavior)
    expect(markup).not.toContain('aria-expanded');
  });

  it("surfaces a command's non-zero exit as a warning", () => {
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "command-warning",
        type: "tool",
        title: "命令返回非零退出码 1",
        toolKind: "run_command",
        command: "rg missing",
        exitCode: 1,
        state: "warning",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-warning",
      process,
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(markup).toContain("chat-command-group warning");
    expect(markup).toContain("命令返回非零退出码 1");
  });

  it("makes listed directories available for navigation", () => {
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "listed-directory",
        type: "tool",
        title: "已查看 1 个目录",
        state: "completed",
        timestamp: 10,
        files: [{ file: "src/components", label: "components", action: "listed" }],
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-listed-directory",
      process,
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(markup).toContain('class="chat-process-file-name openable"');
    expect(markup).toContain("components");
    expect(markup).not.toContain("chat-process-file-action");
    expect(markup.match(/已查看/g)).toHaveLength(1);
  });

  it.each([
    ["read_file", "已读取 2 个文件", "read"],
    ["write_file", "已写入 2 个文件", "written"],
    ["edit_file", "已编辑 2 个文件", "edited"],
  ] as const)("lists %s targets without repeating the action label", (toolKind, title, action) => {
    const actionLabel = title.slice(0, 3);
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: toolKind,
        type: "tool",
        title,
        toolKind,
        state: "completed",
        timestamp: 10,
        files: [
          { file: "src/first.lua", label: "first.lua", action },
          { file: "src/second.lua", label: "second.lua", action },
        ],
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: `assistant-${toolKind}`,
      process,
      commentary: [],
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (preservedAction: () => void) => preservedAction(),
    }));

    expect(markup).toContain("first.lua");
    expect(markup).toContain("second.lua");
    expect(markup).not.toContain("chat-process-file-action");
    expect(markup.split(actionLabel)).toHaveLength(2);
  });

  it("settles stale running entries and hides the waiting placeholder after the turn ends", () => {
    const process: AgentProcess = {
      startedAt: 1_000,
      expanded: true,
      entries: [{
        id: "stale-running",
        type: "tool",
        title: "still running",
        state: "running",
        timestamp: 2_000,
      }],
    };
    const settledMarkup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-stale",
      process,
      commentary: [],
      running: false,
      fallbackEndedAt: 2_000,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action: () => void) => action(),
    }));
    const emptyMarkup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-empty",
      process: { ...process, entries: [] },
      commentary: [],
      running: false,
      fallbackEndedAt: 2_000,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action: () => void) => action(),
    }));

    expect(settledMarkup).not.toContain("chat-process-entry-spinner");
    expect(settledMarkup).toContain("chat-process-entry completed tool");
    expect(emptyMarkup).not.toContain("chat-process-empty");
  });
});
