import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/types";
import { uiText } from "@/i18n/text";
import {
  activateSessionRuntimeTurn,
  buildInferredPlanSteps,
  compareAgentTurnRevisions,
  createSessionRuntime,
  getContextCompactionPresentation,
  getThinkingPreviewMarkdown,
  getToolSummary,
  getUIResponsePayload,
  markSessionRuntimeTurnSettled,
  mergeRuntimeChangeFile,
  normalizePlanStepsFromEvent,
  normalizePlanStepsFromToolResult,
  resetSessionRuntimeAfterTurn,
  summarizeRuntimeChanges,
} from "./agentEventUtils";

describe("agentEventUtils", () => {
  it("resets the stream idle baseline after a turn settles", () => {
    const runtime = createSessionRuntime();
    runtime.streamIdleSince = 45_000;
    runtime.streamIdleNoticeEntryId = "idle-notice";

    resetSessionRuntimeAfterTurn(runtime);

    expect(runtime.streamIdleSince).toBeNull();
    expect(runtime.streamIdleNoticeEntryId).toBeNull();
  });

  it("orders host lifecycle revisions and rejects older settled turns", () => {
    expect(compareAgentTurnRevisions("plugin-backend-1:2", "plugin-backend-1:1")).toBe(1);
    expect(compareAgentTurnRevisions("plugin-backend-1:1", "plugin-backend-1:2")).toBe(-1);
    expect(compareAgentTurnRevisions("plugin-backend-2:1", "plugin-backend-1:2")).toBeNull();

    const runtime = createSessionRuntime();
    expect(activateSessionRuntimeTurn(runtime, { revision: "plugin-backend-1:2" })).toBe(true);
    markSessionRuntimeTurnSettled(runtime, "completed");
    expect(activateSessionRuntimeTurn(runtime, { revision: "plugin-backend-1:1" })).toBe(false);
    expect(activateSessionRuntimeTurn(runtime, { revision: "plugin-backend-1:3" })).toBe(true);
  });

  it("treats a recreated backend instance as a new revision scope", () => {
    const oldRevision = "plugin-backend-1:old-instance:5";
    const recreatedRevision = "plugin-backend-1:new-instance:1";
    expect(compareAgentTurnRevisions(recreatedRevision, oldRevision)).toBeNull();

    const runtime = createSessionRuntime();
    expect(activateSessionRuntimeTurn(runtime, { revision: oldRevision })).toBe(true);
    markSessionRuntimeTurnSettled(runtime, "completed");
    expect(activateSessionRuntimeTurn(runtime, { revision: recreatedRevision })).toBe(true);
    expect(runtime.activeTurnRevision).toBe(recreatedRevision);
  });

  it("rejects conflicting user identities within the same lifecycle revision", () => {
    const runtime = createSessionRuntime();
    expect(activateSessionRuntimeTurn(runtime, {
      revision: "plugin-backend-1:instance:1",
      userMessageId: "current-user-message",
    })).toBe(true);

    expect(activateSessionRuntimeTurn(runtime, {
      revision: "plugin-backend-1:instance:1",
      userMessageId: "late-user-message",
    })).toBe(false);
    expect(runtime.activeTurnUserMessageId).toBe("current-user-message");
  });

  it("rejects a late host revision for a user message already settled by send failure", () => {
    const runtime = createSessionRuntime();
    expect(activateSessionRuntimeTurn(runtime, { userMessageId: "failed-user-message" })).toBe(true);
    markSessionRuntimeTurnSettled(runtime, "error");

    expect(activateSessionRuntimeTurn(runtime, {
      revision: "plugin-backend-1:1",
      userMessageId: "failed-user-message",
    })).toBe(false);
    expect(runtime.turnEventState).toBe("settled");
  });

  it("shows turn-start compaction inside the process and idle compaction as a divider", () => {
    expect(getContextCompactionPresentation("started", true, null)).toBe("process");
    expect(getContextCompactionPresentation("started", false, null)).toBe("divider");
    expect(getContextCompactionPresentation("completed", false, "process")).toBe("process");
    expect(getContextCompactionPresentation("completed", false, null)).toBe("divider");
  });

  it("builds inferred steps without a modify step until files change", () => {
    const runtime = createSessionRuntime();

    expect(buildInferredPlanSteps(runtime)).toBeNull();

    expect(buildInferredPlanSteps(runtime, "analyze")).toMatchObject([
      { id: "inferred-analyze", title: "分析请求", status: "running" },
      { id: "inferred-operate", title: "执行操作", status: "pending" },
      { id: "inferred-verify", title: "验证总结", status: "pending" },
    ]);

    expect(buildInferredPlanSteps(runtime, "operate")).toMatchObject([
      { id: "inferred-analyze", status: "completed" },
      { id: "inferred-operate", status: "running" },
      { id: "inferred-verify", status: "pending" },
    ]);

    expect(buildInferredPlanSteps(runtime, "modify")).toMatchObject([
      { id: "inferred-analyze", status: "completed" },
      { id: "inferred-operate", status: "completed" },
      { id: "inferred-modify", title: "修改文件", status: "running" },
      { id: "inferred-verify", status: "pending" },
    ]);
  });

  it("places terminal failure on the active inferred step", () => {
    const runtime = createSessionRuntime();

    buildInferredPlanSteps(runtime, "modify");

    expect(buildInferredPlanSteps(runtime, "failed")).toMatchObject([
      { id: "inferred-analyze", status: "completed" },
      { id: "inferred-operate", status: "completed" },
      { id: "inferred-modify", status: "failed" },
      { id: "inferred-verify", status: "pending" },
    ]);
  });

  it("adds modify step when change summary sees files", () => {
    const runtime = createSessionRuntime();

    expect(mergeRuntimeChangeFile(runtime, {
      file: "src/App.tsx",
      additions: 3,
      deletions: 1,
      changeKey: "patch-1",
    })).toBe(true);

    expect(mergeRuntimeChangeFile(runtime, {
      file: "src/App.tsx",
      additions: 3,
      deletions: 1,
      changeKey: "patch-1",
    })).toBe(false);

    expect(summarizeRuntimeChanges(runtime)).toEqual({
      filesChanged: 1,
      additions: 3,
      deletions: 1,
    });

    expect(buildInferredPlanSteps(runtime, "operate")?.map((step) => step.id)).toEqual([
      "inferred-analyze",
      "inferred-operate",
      "inferred-modify",
      "inferred-verify",
    ]);
  });

  it("does not generate inferred steps when native plan steps are active", () => {
    const runtime = createSessionRuntime();
    runtime.nativePlanSteps = true;

    expect(buildInferredPlanSteps(runtime, "analyze")).toBeNull();
  });

  it("reads detailed Codex plan tasks from the step field", () => {
    expect(normalizePlanStepsFromEvent({
      type: "plan_update",
      steps: [
        { step: "Locate the Todo data source and renderer", status: "in_progress" },
        { step: "Fix the plan field mapping and preserve compatibility", status: "pending" },
      ],
    } as AgentEvent)).toEqual([
      {
        id: "step-0-Locate the Todo data sou",
        title: "Locate the Todo data source and renderer",
        status: "running",
      },
      {
        id: "step-1-Fix the plan field mappi",
        title: "Fix the plan field mapping and preserve compatibility",
        status: "pending",
      },
    ]);
  });

  it("reads Pi extension task snapshots from tool result details", () => {
    expect(normalizePlanStepsFromToolResult({
      type: "tool_end",
      toolName: "todo",
      result: {
        content: [{ type: "text", text: "Created #1: inspect the renderer" }],
        details: {
          tasks: [
            { id: 1, subject: "Inspect the renderer", status: "in_progress" },
            { id: 2, subject: "Add compatibility tests", status: "pending" },
          ],
        },
      },
    } as AgentEvent)).toEqual([
      { id: "1", title: "Inspect the renderer", status: "running" },
      { id: "2", title: "Add compatibility tests", status: "pending" },
    ]);

    expect(normalizePlanStepsFromToolResult({
      type: "tool_end",
      toolName: "search",
      result: { items: [{ title: "A search result" }] },
    } as AgentEvent)).toEqual([]);
  });

  it("normalizes confirm UI responses with localized negative answers", () => {
    expect(getUIResponsePayload({
      sessionId: "s1",
      requestId: "r1",
      method: "confirm",
      text: "否",
    })).toMatchObject({
      sessionId: "s1",
      type: "extension_ui_response",
      id: "r1",
      method: "confirm",
      confirmed: false,
      cancelled: false,
    });

    expect(getUIResponsePayload({
      sessionId: "s1",
      method: "confirm",
      text: " yes ",
    })).toMatchObject({
      sessionId: "s1",
      method: "confirm",
      confirmed: true,
    });
  });

  it("keeps line breaks and inline Markdown in the thinking preview", () => {
    expect(getThinkingPreviewMarkdown(
      "**Planning**\n\n- inspect files\n- compare settings\n\n`renderScale`",
    )).toBe("**Planning**\n\n- inspect files");
  });

  it("keeps headings, lists, quotes, and code blocks so the preview matches the expanded body", () => {
    expect(getThinkingPreviewMarkdown(
      "# 标题\n\n> 引用内容\n\n1. 第一项\n2. 第二项\n\n---\n\n正文",
    )).toBe("# 标题\n\n> 引用内容");
  });

  it("keeps fenced code blocks in the thinking preview", () => {
    expect(getThinkingPreviewMarkdown(
      "思路：\n\n```js\nconst a = 1\n```\n\n完成",
    )).toBe("思路：\n\n```js\nconst a = 1\n```");
  });

  it("completes a code block that starts at the preview boundary", () => {
    expect(getThinkingPreviewMarkdown(
      "先看这里\n```js\nconst a = 1\nconst b = 2\n```\n后面的内容",
    )).toBe("先看这里\n```js\nconst a = 1\nconst b = 2\n```");
  });

  it("keeps a code block that starts on the first preview line complete", () => {
    expect(getThinkingPreviewMarkdown(
      "```ts\nconst x: number = 1\n```\n\n结束语",
    )).toBe("```ts\nconst x: number = 1\n```");
  });

  it("does not extend the preview for a code block beyond the two-line boundary", () => {
    expect(getThinkingPreviewMarkdown(
      "第一行\n第二行\n```js\nconst a = 1\n```",
    )).toBe("第一行\n第二行");
  });

  it("truncates oversized code blocks but keeps them closed", () => {
    const codeLines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const result = getThinkingPreviewMarkdown(`开头\n\`\`\`js\n${codeLines.join("\n")}\n\`\`\``);
    expect(result).toBe(
      `开头\n\`\`\`js\n${codeLines.slice(0, 12).join("\n")}\n\`\`\``,
    );
    expect(result!.split("\n").length).toBeLessThan(20);
  });

  it("keeps blank lines between kept paragraphs so collapsed rendering matches expanded", () => {
    expect(getThinkingPreviewMarkdown(
      "第一段\n\n第二段\n\n第三段\n\n第四段",
    )).toBe("第一段\n\n第二段");
  });

  it("falls back to the thinking label and truncates long preview lines", () => {
    expect(getThinkingPreviewMarkdown("   \n\n  ")).toBe(uiText.process.thinking);
    expect(getThinkingPreviewMarkdown("x".repeat(500))).toBe(`${"x".repeat(240)}...`);
  });

  it("summarizes tool events for files, commands, and failures", () => {
    expect(getToolSummary({
      type: "tool",
      toolKind: "read_file",
      filePath: "src/App.tsx",
    } as AgentEvent, true)).toBe("正在读取 1 个文件");

    expect(getToolSummary({
      type: "tool",
      toolKind: "run_command",
      toolName: "npm test",
    } as AgentEvent, false)).toBe("已运行 npm test");

    expect(getToolSummary({
      type: "tool",
      toolKind: "write_file",
      isError: true,
    } as AgentEvent, false)).toBe("写入文件未成功");

    expect(getToolSummary({
      type: "tool",
      toolKind: "run_command",
      isError: true,
      exitCode: 1,
    } as AgentEvent, false)).toBe("命令返回非零退出码 1");
  });
});
