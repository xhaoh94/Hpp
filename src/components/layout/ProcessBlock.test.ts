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
    const chatPanel = readFileSync(resolve("src/components/layout/ChatPanel.tsx"), "utf8");
    const styles = readFileSync(resolve("src/components/layout/ChatPanel.css"), "utf8");
    expect(chatPanel).toContain('<path d="m6 15 6-6 6 6" />');
    expect(chatPanel).not.toContain('<span>{interrupted ? "中断" : "耗时"}</span>');
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
    expect(styles).toContain("chat-thinking-bulb-pulse");
    // 跳转高亮与思考中灯泡一致：亮度脉动，不产生矩形背景或直角扩散边框。
    expect(styles).not.toContain("background-color: color-mix(in srgb, var(--accent-color) 18%");
    expect(styles).not.toContain("box-shadow: 0 0 0 5px");
    expect(styles).not.toContain("transform: scale(1.2)");
  });

  it("sweeps a shimmer across the collapsed thinking preview while running", () => {
    const styles = readFileSync(resolve("src/components/layout/ChatPanel.css"), "utf8");
    // 折叠且思考运行时：预览两行文字上方有一道扫光反复扫过。
    expect(styles).toContain(
      ".chat-process-thinking-row.collapsed .chat-process-thinking-toggle.running + .chat-process-thinking-preview"
    );
    expect(styles).toContain("chat-thinking-text-shimmer");
    expect(styles).toContain("@keyframes chat-thinking-text-shimmer");
    expect(styles).toContain("4s ease-in-out infinite");
    // 只高亮文字笔画本身：背景裁剪到文字，不出现矩形覆盖层或边框。
    expect(styles).toContain("background-clip: text");
    expect(styles).toContain("background-size: 300% 100%");
    // T1：宽高亮带（38%-62%）柔和扫过。
    expect(styles).toContain("var(--text-secondary) 38%");
    expect(styles).toContain("var(--text-secondary) 62%");
    expect(styles).not.toContain(".chat-process-thinking-preview::after");
    // 扫光只作用于折叠态，不影响展开/单行思考。
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

  it("renders live subagent progress, elapsed time and the active subagent's activity", () => {
    const html = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-subagent",
      process: {
        startedAt: 1_000,
        expanded: true,
        entries: [{
          id: "subagent-event",
          type: "subagent" as const,
          title: "正在工作",
          state: "running" as const,
          timestamp: 1_000,
          startedAt: 1_000,
          subagents: [
            { id: "scout", label: "Scout", status: "running" as const, message: "正在读取文件" },
            { id: "reviewer", label: "Reviewer", status: "completed" as const, message: "已完成" },
          ],
        }],
      },
      running: true,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action: () => void) => action(),
    }));

    expect(html).toContain("进度 1/2");
    expect(html).toContain("已运行");
    // 折叠态要能看出谁在干什么，否则并行子任务对用户是黑箱。
    expect(html).toContain("chat-subagent-event-activity");
    expect(html).toContain("Scout：正在读取文件");
    // 已结束的子任务不占用活动位。
    expect(html).not.toContain("Reviewer：已完成");
  });

  it("combines repeated idle notices into one row with the summed duration", () => {
    const durations = [54_000, 137_000, 107_000, 121_000];
    const process: AgentProcess = {
      startedAt: 1_000,
      endedAt: 900_000,
      expanded: true,
      entries: durations.map((duration, index) => {
        const startedAt = 10_000 + index * 200_000;
        return {
          id: `idle-${index}`,
          type: "status" as const,
          title: "Pi 仍在运行，暂时没有新输出",
          toolKind: "stream_idle_notice",
          state: "completed" as const,
          timestamp: startedAt,
          startedAt,
          completedAt: startedAt + duration,
        };
      }),
    };
    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-idle-summary",
      process,
      commentary: [],
      running: false,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action: () => void) => action(),
    }));

    expect(markup.match(/Pi 仍在运行，暂时没有新输出/g)).toHaveLength(1);
    expect(markup).toContain("· 06:59");
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
    // 引导标签为纯图标（CornerDownRight），不带文字。
    const guidanceLabelEnd = expanded.indexOf("</span>", guidanceLabelIndex);
    const guidanceLabelMarkup = expanded.slice(guidanceLabelIndex, guidanceLabelEnd);
    expect(guidanceLabelMarkup).toContain("<svg");
    expect(guidanceLabelMarkup).not.toContain(">引导<");
    expect(expanded).not.toContain(">引导<");
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
      expandThinkingWhileRunning: true,
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
      expandThinkingWhileRunning: true,
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

  it("expands thinking while running when the setting is on", () => {
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "thinking-running-enabled",
        type: "thinking",
        title: "正在思考",
        detail: Array.from({ length: 4 }, (_, i) => `处理中自动展开思考的第 ${i + 1} 行，用于验证开启时展开行为`).join("\n\n"),
        state: "completed",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking-running-enabled",
      process,
      commentary: [],
      running: true,
      expandThinkingWhileRunning: true,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(markup).toContain("chat-process-thinking-row expanded");
    expect(markup).toContain("chat-process-thinking-body");
  });

  it("collapses thinking by default while running", () => {
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "thinking-running-default-collapsed",
        type: "thinking",
        title: "正在思考",
        detail: Array.from({ length: 4 }, (_, i) => `处理中默认折叠思考的第 ${i + 1} 行，用于验证默认折叠行为`).join("\n\n"),
        state: "running",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking-running-default-collapsed",
      process,
      commentary: [],
      running: true,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action) => action(),
    }));

    expect(markup).toContain("chat-process-thinking-row collapsed");
    expect(markup).toContain("chat-process-thinking-preview");
    expect(markup).not.toContain("chat-process-thinking-body");
  });

  it("keeps thinking collapsed after the turn ends when the setting is off", () => {
    // 用户场景：中间插入新对话/新处理过程后，旧 turn 不再是活跃 turn
    // （running=false），此时思考不应自动全部展开。
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "thinking-old-turn",
        type: "thinking",
        title: "正在思考",
        detail: Array.from({ length: 5 }, (_, i) => `旧 turn 的第 ${i + 1} 段思考内容，设置关闭时结束后也应默认折叠`).join("\n\n"),
        state: "completed",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking-old-turn",
      process,
      commentary: [],
      running: false,
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

  it("keeps manually expanded thinking open after the turn ends when the setting is off", () => {
    // 用户手动展开过的思考（expanded === true）优先于设置，结束后仍保持展开。
    const process: AgentProcess = {
      startedAt: 1,
      endedAt: 2,
      expanded: true,
      entries: [{
        id: "thinking-manual-expanded",
        type: "thinking",
        title: "正在思考",
        detail: Array.from({ length: 5 }, (_, i) => `用户手动展开的第 ${i + 1} 段思考内容`).join("\n\n"),
        expanded: true,
        state: "completed",
        timestamp: 10,
      }],
    };

    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-thinking-manual-expanded",
      process,
      commentary: [],
      running: false,
      expandThinkingWhileRunning: false,
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

  it("opens the shared file context menu on right-click of a process file row", () => {
    const source = readFileSync(resolve("src/components/layout/ProcessBlock.tsx"), "utf8");
    expect(source).toContain("<FileContextMenu");
    expect(source).toContain("onContextMenu={(event) => {");
    expect(source).toContain('resolveProjectFilePath(file.file, projectPath || "")');
    expect(source).toContain("setContextMenu(");
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

describe("output detail level rendering", () => {
  const createLevelProcess = (): AgentProcess => ({
    startedAt: 1,
    endedAt: 2,
    expanded: true,
    entries: [
      {
        id: "thinking-1",
        type: "thinking",
        title: "正在思考: 分析改动",
        detail: "需要先确认设置面板的保存路径。",
        expanded: true,
        state: "completed",
        timestamp: 10,
      },
      {
        id: "tool-1",
        type: "tool",
        toolKind: "run_command",
        title: "已运行 npm test",
        detail: "$ npm test\nPASS",
        command: "npm test",
        state: "completed",
        timestamp: 20,
      },
      {
        id: "diff-1",
        type: "diff",
        title: "已修改 2 个文件",
        files: [
          { file: "src/App.tsx", patch: "--- a/src/App.tsx\n+++ b/src/App.tsx\n+changed" },
          { file: "src/index.css", patch: "--- a/src/index.css\n+++ b/src/index.css\n+changed" },
        ],
        state: "completed",
        timestamp: 30,
      },
    ],
  });

  const renderLevel = (outputDetailLevel: "concise" | "standard" | "detailed") =>
    renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: `assistant-${outputDetailLevel}`,
      process: createLevelProcess(),
      commentary: [],
      running: false,
      outputDetailLevel,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action: () => void) => action(),
    }));

  it("keeps every process detail in the detailed level", () => {
    const markup = renderLevel("detailed");
    expect(markup).toContain("需要先确认设置面板的保存路径。");
    // 命令以折叠分组呈现，这里断言分组标题存在（展开内容按需渲染）。
    expect(markup).toContain("已运行 1 条命令");
    expect(markup).toContain("src/App.tsx");
    expect(markup).toContain("src/index.css");
    expect(markup).not.toContain("chat-process-change-summary");
  });

  it("collapses commands, viewed files and changed files into one line in the standard level", () => {
    const markup = renderLevel("standard");
    // 思考照常显示；命令与变更不再逐条列出，而是合并成一行。
    expect(markup).toContain("需要先确认设置面板的保存路径。");
    expect(markup).toContain("chat-process-operation-summary");
    expect(markup).toContain("运行 1 条命令");
    expect(markup).toContain("修改 2 个文件");
    // 不再是原来的命令组标题，也不暴露具体文件名。
    expect(markup).not.toContain("已运行 1 条命令");
    expect(markup).not.toContain("src/App.tsx");
    expect(markup).not.toContain("src/index.css");
    // 折叠行不再重复数量：变更文件在消息底部的 diff 面板里完整显示。
    expect(markup).not.toContain("chat-process-change-summary");
  });

  it("only keeps thinking in the concise level", () => {
    const markup = renderLevel("concise");
    expect(markup).toContain("需要先确认设置面板的保存路径。");
    // 命令、变更文件等操作细节全部隐藏，摘要也不出现。
    expect(markup).not.toContain("已运行 1 条命令");
    expect(markup).not.toContain("运行 1 条命令");
    expect(markup).not.toContain("src/App.tsx");
    expect(markup).not.toContain("src/index.css");
    expect(markup).not.toContain("chat-process-operation-summary");
    expect(markup).not.toContain("chat-process-change-summary");
  });

  it("does not show the empty-events hint when entries are only hidden by the level", () => {
    // 简洁档只保留思考；正在跑命令、还没产出思考时，不能把“条目被过滤”
    // 当成“还没有事件”去显示「等待 agent 事件...」。
    const markup = renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-concise-hidden",
      process: {
        startedAt: 1,
        expanded: true,
        entries: [
          {
            id: "tool-1",
            type: "tool" as const,
            toolKind: "run_command" as const,
            title: "已运行 npm test",
            detail: "$ npm test",
            command: "npm test",
            state: "running" as const,
            timestamp: 10,
          },
        ],
      },
      commentary: [],
      running: true,
      outputDetailLevel: "concise" as const,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action: () => void) => action(),
    }));

    expect(markup).not.toContain("等待 agent 事件...");
    expect(markup).not.toContain("chat-process-empty");
  });
});

describe("consecutive thinking is merged in every output level", () => {
  const thinking = (id: string, detail: string, timestamp: number) => ({
    id,
    type: "thinking" as const,
    title: "正在思考",
    detail,
    expanded: true,
    state: "completed" as const,
    timestamp,
  });

  const renderLevel = (
    outputDetailLevel: "concise" | "standard" | "detailed",
    entries: AgentProcess["entries"],
    commentary: Array<{ id: string; content: string; timestamp: number; isStreaming?: boolean }> = [],
  ) =>
    renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: `assistant-${outputDetailLevel}-merge`,
      process: { startedAt: 1, endedAt: 2, expanded: true, entries },
      commentary,
      running: false,
      outputDetailLevel,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action: () => void) => action(),
    }));

  const thinkingRowCount = (markup: string) => markup.split("chat-process-thinking-row").length - 1;

  for (const level of ["concise", "standard", "detailed"] as const) {
    it(`renders one thinking row for consecutive thinking (${level})`, () => {
      const markup = renderLevel(level, [
        thinking("t1", "第一段思考。", 10),
        thinking("t2", "第二段思考。", 20),
        thinking("t3", "第三段思考。", 30),
      ]);

      // 三段连续思考连成一条：只出现一个思考行，但内容都在。
      expect(thinkingRowCount(markup)).toBe(1);
      expect(markup).toContain("第一段思考。");
      expect(markup).toContain("第二段思考。");
      expect(markup).toContain("第三段思考。");
    });
  }

  it("keeps separate thinking rows when body text sits between them", () => {
    const markup = renderLevel("detailed", [
      thinking("t1", "写代码前的思考。", 10),
      thinking("t2", "紧挨着的第二段。", 20),
      thinking("t3", "正文之后的思考。", 40),
    ], [
      { id: "c1", content: "这是正文输出。", timestamp: 30, isStreaming: false },
    ]);

    // 正文把它切成了两组：前两段合并、第三段独立。
    expect(thinkingRowCount(markup)).toBe(2);
    expect(markup).toContain("这是正文输出。");
    expect(markup).toContain("写代码前的思考。");
    expect(markup).toContain("紧挨着的第二段。");
    expect(markup).toContain("正文之后的思考。");
  });

  it("does not merge thinking across a file-view entry in detailed mode", () => {
    const markup = renderLevel("detailed", [
      thinking("t1", "读文件前的思考。", 10),
      {
        id: "read-1",
        type: "tool" as const,
        toolKind: "read_file",
        title: "已读取 1 个文件",
        files: [{ file: "src/App.tsx", action: "read" }],
        state: "completed" as const,
        timestamp: 20,
      },
      thinking("t2", "读文件后的思考。", 30),
    ]);

    // 查看文件是分界点：两段思考必须分开，文件条目本身照常显示。
    expect(thinkingRowCount(markup)).toBe(2);
    expect(markup).toContain("读文件前的思考。");
    expect(markup).toContain("读文件后的思考。");
    expect(markup).toContain("src/App.tsx");

    // 真正的约束：两段思考不能出现在同一个思考行里（跨条目合并会违反这里）。
    const thinkingRows = markup.split('class="chat-process-thinking-row');
    expect(thinkingRows).toHaveLength(3);
    expect(thinkingRows[1]).toContain("读文件前的思考。");
    expect(thinkingRows[1]).not.toContain("读文件后的思考。");
    expect(thinkingRows[2]).toContain("读文件后的思考。");
    expect(thinkingRows[2]).not.toContain("读文件前的思考。");
  });
});

describe("concise level keeps user-authored and interactive entries (regression)", () => {
  const renderConcise = (entries: AgentProcess["entries"]) =>
    renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: "assistant-concise-essential",
      process: { startedAt: 1, endedAt: 2, expanded: true, entries },
      commentary: [],
      running: false,
      outputDetailLevel: "concise",
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onOpenImage: vi.fn(),
      onPreserveScroll: (action: () => void) => action(),
    }));

  it("never hides a user guidance message in concise mode", () => {
    const markup = renderConcise([
      { id: "t1", type: "thinking", title: "正在思考", detail: "先看看代码。", state: "completed", expanded: true, timestamp: 10 },
      {
        id: "guidance-1",
        type: "info",
        kind: "user_guidance",
        toolKind: "guidance_message",
        title: "引导",
        detail: "改成用缓存",
        state: "completed",
        timestamp: 20,
      },
      { id: "t2", type: "thinking", title: "正在思考", detail: "好，按引导改。", state: "completed", expanded: true, timestamp: 30 },
    ]);

    // 用户自己发的引导必须可见，否则对话内容就丢了。
    expect(markup).toContain("chat-process-guidance-row");
    expect(markup).toContain("改成用缓存");
    // 并且它仍然是思考之间的分界点。
    expect(markup.split("chat-process-thinking-row").length - 1).toBe(2);
    expect(markup).toContain("先看看代码。");
    expect(markup).toContain("好，按引导改。");
  });

  it("never hides a questionnaire entry in concise mode", () => {
    const markup = renderConcise([
      { id: "q1", type: "question", title: "需要你确认", detail: "选哪个方案？", state: "running", timestamp: 10 },
    ]);

    expect(markup).toContain("需要你确认");
  });

  it("never hides an error entry in concise mode", () => {
    const markup = renderConcise([
      { id: "e1", type: "error", title: "命令执行失败", detail: "exit 1", state: "error", timestamp: 10 },
    ]);

    expect(markup).toContain("命令执行失败");
  });

  it("still hides plain process detail in concise mode", () => {
    const markup = renderConcise([
      { id: "t1", type: "thinking", title: "正在思考", detail: "先看看代码。", state: "completed", expanded: true, timestamp: 10 },
      { id: "cmd-1", type: "tool", toolKind: "run_command", title: "已运行 1 条命令", detail: "npm test", state: "completed", timestamp: 20 },
    ]);

    // 命令这类过程细节在「简洁」下依然不显示。
    expect(markup).not.toContain("npm test");
    expect(markup).toContain("先看看代码。");
  });
});

describe("standard level operation summary details", () => {
  const buildProcess = (): AgentProcess => ({
    startedAt: 1,
    endedAt: 2,
    expanded: true,
    entries: [
      {
        id: "cmd-1",
        type: "tool" as const,
        toolKind: "run_command" as const,
        title: "已运行 1 条命令",
        command: "npm test",
        state: "completed" as const,
        timestamp: 10,
      },
      {
        id: "read-1",
        type: "tool" as const,
        toolKind: "read_file" as const,
        title: "已读取 1 个文件",
        files: [{ file: "src/viewed.ts", action: "read" as const }],
        state: "completed" as const,
        timestamp: 20,
      },
      {
        id: "diff-1",
        type: "diff" as const,
        title: "变更",
        files: [{ file: "src/changed.ts" }],
        state: "completed" as const,
        timestamp: 30,
      },
    ],
  });

  const render = (outputDetailLevel: "standard" | "detailed") =>
    renderToStaticMarkup(createElement(ProcessBlock, {
      messageId: `assistant-summary-${outputDetailLevel}`,
      process: buildProcess(),
      commentary: [],
      running: false,
      outputDetailLevel,
      onToggle: vi.fn(),
      onToggleEntry: vi.fn(),
      onOpenFile: vi.fn(),
      onPreserveScroll: (action: () => void) => action(),
    }));

  it("defaults to the collapsed summary line", () => {
    const markup = render("standard");
    expect(markup).toContain("运行 1 条命令");
    expect(markup).toContain("修改 1 个文件");
    expect(markup).toContain("查看 1 个文件");
    expect(markup).not.toContain("已修改 src/changed.ts");
  });
});
