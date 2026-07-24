import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentProcess } from "@/stores/chat-store";
import { ASSISTANT_NARRATION_PROCESS_KIND } from "@shared/process-view";
import { ProcessBlock } from "./ProcessBlock";

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
});
