import { describe, expect, it } from "vitest";
import {
  buildDiffsFromToolEvent,
  normalizeQuestionProcessEvent,
  withoutToolDiffPayload,
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

  it("preserves Pi file-read errors from the tool result", () => {
    expect(normalizeToolEvent("tool_end", {
      toolName: "read",
      toolCallId: "pi-read-1",
      args: { path: "src/missing.ts" },
      result: { content: [{ type: "text", text: "File not found" }] },
      isError: true,
    })).toMatchObject({
      type: "tool_end",
      toolKind: "read_file",
      filePath: "src/missing.ts",
      isError: true,
      errorText: "File not found",
      detail: "File not found",
      files: [{ file: "src/missing.ts", action: "read" }],
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
        statusExplicit: false,
      }],
    });
  });

  it("does not expose diffs from failed tool results", () => {
    expect(buildDiffsFromToolEvent({
      filePath: "src/App.tsx",
      patch: "@@ -1 +1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
      isError: true,
    })).toEqual([]);
  });

  it("unescapes JSON-escaped newlines in single-string provider patches", () => {
    // droid 的结构化 tool_result 可能携带字面 \n 的补丁；不反转义的话
    // 补丁解析不出 hunk，审核弹窗拿不到可用差异，局部撤销会静默失效。
    expect(normalizeToolEvent("tool_end", {
      name: "Edit",
      args: { file_path: "src/a.ts" },
      result: { filePath: "src/a.ts", patch: "@@ -1 +1 @@\\n-old\\n+new" },
    })).toMatchObject({
      filePath: "src/a.ts",
      patch: "@@ -1 +1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
    });
    // 多行补丁内容里恰好包含字面 \n 文本时不能误伤。
    const multiline = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+const s = "a\\nb";';
    expect(normalizeToolEvent("tool_end", {
      name: "Edit",
      args: { file_path: "src/a.ts" },
      result: { filePath: "src/a.ts", patch: multiline },
    })).toMatchObject({ patch: multiline });
  });

  it("normalizes Claude Code gitDiff and structuredPatch outputs", () => {
    const gitPatch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";
    expect(normalizeToolEvent("tool_end", {
      name: "Edit",
      args: { file_path: "src/a.ts" },
      result: { filePath: "src/a.ts", gitDiff: { patch: gitPatch } },
    })).toMatchObject({ filePath: "src/a.ts", patch: gitPatch, additions: 1, deletions: 1 });

    expect(normalizeToolEvent("tool_end", {
      name: "Write",
      result: {
        filePath: "src/b.ts",
        structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+created"] }],
      },
    })).toMatchObject({
      filePath: "src/b.ts",
      patch: "@@ -0,0 +1,1 @@\n+created",
      additions: 1,
      deletions: 0,
    });
    expect(buildDiffsFromToolEvent(normalizeToolEvent("tool_end", {
      name: "Write",
      result: {
        filePath: "src/b.ts",
        structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+created"] }],
      },
    }))).toMatchObject([{
      file: "src/b.ts",
      status: undefined,
      statusExplicit: false,
    }]);
  });

  it("preserves an explicitly reported file lifecycle status", () => {
    const patch = "@@ -0,0 +1,1 @@\n+created";
    const payload = normalizeToolEvent("tool_end", {
      name: "Write",
      result: { filePath: "src/new.ts", patch, status: "added" },
    });
    expect(payload).toMatchObject({ status: "added", statusExplicit: true });
    expect(payload.files).toMatchObject([{
      file: "src/new.ts",
      status: "added",
      statusExplicit: true,
    }]);
    expect(buildDiffsFromToolEvent(payload)).toMatchObject([{
      file: "src/new.ts",
      status: "added",
      statusExplicit: true,
    }]);
    expect(buildDiffsFromToolEvent(normalizeToolEvent("tool_end", {
      name: "Write",
      result: { filePath: "src/empty.ts", status: "added" },
    }))).toEqual([{
      file: "src/empty.ts",
      patch: "",
      additions: 0,
      deletions: 0,
      status: "added",
      statusExplicit: true,
    }]);
  });

  it("removes diff payloads from tool timeline events", () => {
    expect(withoutToolDiffPayload({
      type: "tool_end",
      patch: "@@ -1 +1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
      status: "modified",
      statusExplicit: true,
      filePath: "src/a.ts",
      files: [{
        file: "src/a.ts",
        action: "edited",
        patch: "@@ -1 +1 @@\n-old\n+new",
        additions: 1,
        deletions: 1,
        status: "modified",
        statusExplicit: true,
      }],
    })).toEqual({
      type: "tool_end",
      filePath: "src/a.ts",
      files: [{ file: "src/a.ts", action: undefined }],
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

  it("preserves a command's non-zero exit code", () => {
    expect(normalizeToolEvent("tool_end", {
      name: "bash",
      args: { command: "rg missing" },
      result: { stdout: "", exit_code: 1 },
      isError: true,
    })).toMatchObject({
      toolKind: "run_command",
      command: "rg missing",
      exitCode: 1,
      isError: true,
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
