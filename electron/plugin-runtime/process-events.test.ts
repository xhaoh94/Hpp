import { describe, expect, it } from "vitest";
import {
  normalizeQuestionProcessEvent,
  normalizeToolEvent,
  unwrapToolText,
} from "./process-events";

describe("process event normalization", () => {
  it("unwraps nested tool text content", () => {
    expect(unwrapToolText(JSON.stringify({
      content: [
        { type: "text", text: "hello" },
        "world",
      ],
    }))).toBe("hello\nworld");

    expect(unwrapToolText({ stdout: "ok", stderr: "warn" })).toBe("ok\nwarn");
  });

  it("normalizes file tool events with paths and file entries", () => {
    expect(normalizeToolEvent("tool_start", {
      toolName: "read_file",
      toolCallId: "call-1",
      args: { path: "src/App.tsx" },
    })).toMatchObject({
      type: "tool_start",
      toolName: "read_file",
      toolCallId: "call-1",
      toolKind: "read_file",
      filePath: "src/App.tsx",
      files: [{
        file: "src/App.tsx",
        label: "App.tsx",
        action: "read",
      }],
    });
  });

  it("extracts patch metadata from edit tool results", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/App.tsx",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    expect(normalizeToolEvent("tool_end", {
      name: "apply_patch",
      result: { details: { patch } },
    })).toMatchObject({
      type: "tool_end",
      toolKind: "edit_file",
      filePath: "src/App.tsx",
      patch,
      additions: 1,
      deletions: 1,
      files: [{
        file: "src/App.tsx",
        action: "edited",
        patch,
        additions: 1,
        deletions: 1,
        status: "modified",
      }],
    });
  });

  it("builds command details from command args and output text", () => {
    expect(normalizeToolEvent("tool_end", {
      name: "bash",
      args: { command: "npm test" },
      result: { stdout: "passed" },
    })).toMatchObject({
      toolKind: "run_command",
      command: "npm test",
      outputText: "passed",
      detail: "$ npm test\npassed",
    });
  });

  it("normalizes Execute-style tools from any agent as commands", () => {
    expect(normalizeToolEvent("tool_start", {
      name: "execute-cli",
      parameters: { command: "git status" },
    })).toMatchObject({
      toolKind: "run_command",
      command: "git status",
      detail: "$ git status",
    });
  });

  it("normalizes question process events from nested detail params", () => {
    const questions = [{ id: "choice", question: "Pick one" }];
    const options = [{ label: "A" }, { label: "B" }];

    expect(normalizeQuestionProcessEvent({
      id: "request-1",
      method: "request_user_input",
      detail: {
        message: "Pick one",
        params: { questions, options },
      },
    })).toMatchObject({
      type: "process_event",
      entryType: "question",
      kind: "question",
      requestId: "request-1",
      method: "request_user_input",
      title: "正在询问用户: Pick one",
      detail: "Pick one",
      prompt: "Pick one",
      questions,
      options,
      state: "running",
    });
  });
});
