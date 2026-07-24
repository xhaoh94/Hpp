import { describe, expect, it } from "vitest";
import type { AgentProcessEntry, AgentProcessFile } from "@/stores/chat-store";
import {
  createProcessEntryMerger,
  mergeProcessEntries,
  mergeProcessFiles,
} from "./processEntryMerge";

const processEntry = (patch: Partial<AgentProcessEntry>): AgentProcessEntry => ({
  id: "entry",
  type: "status",
  title: "status",
  timestamp: 1000,
  ...patch,
});

const fileEntry = (file: string, patch: Partial<AgentProcessFile> = {}): AgentProcessFile => ({
  file,
  action: "edited",
  additions: 0,
  deletions: 0,
  ...patch,
});

describe("processEntryMerge", () => {
  it("merges duplicate file entries by normalized path", () => {
    const files = mergeProcessFiles([
      fileEntry("src\\App.tsx", { label: "App.tsx", additions: 2, deletions: 1 }),
      fileEntry("src/app.tsx", { additions: 3, deletions: 0 }),
      fileEntry("src/Chat.tsx", { additions: 1, deletions: 4 }),
    ]);

    expect(files).toEqual([
      expect.objectContaining({
        file: "src/app.tsx",
        label: "App.tsx",
        additions: 5,
        deletions: 1,
      }),
      expect.objectContaining({
        file: "src/Chat.tsx",
        label: "Chat.tsx",
        additions: 1,
        deletions: 4,
      }),
    ]);
  });

  it("merges consecutive file tool entries with the same kind and state", () => {
    const entries = [
      processEntry({
        id: "read-1",
        type: "tool",
        toolKind: "read_file",
        state: "running",
        title: "read 1",
        files: [fileEntry("src/a.ts", { action: "read" })],
      }),
      processEntry({
        id: "read-2",
        type: "tool",
        toolKind: "read_file",
        state: "running",
        title: "read 2",
        files: [fileEntry("src/b.ts", { action: "read" })],
      }),
      processEntry({
        id: "cmd",
        type: "tool",
        toolKind: "run_command",
        state: "running",
        title: "npm test",
      }),
    ];

    expect(mergeProcessEntries(entries)).toEqual([
      expect.objectContaining({
        id: "read-2",
        title: "正在读取 2 个文件",
        files: [
          expect.objectContaining({ file: "src/a.ts" }),
          expect.objectContaining({ file: "src/b.ts" }),
        ],
      }),
      expect.objectContaining({ id: "cmd", title: "npm test" }),
    ]);
  });

  it("does not merge file tools across state or kind boundaries", () => {
    const entries = [
      processEntry({
        id: "read-running",
        type: "tool",
        toolKind: "read_file",
        state: "running",
        files: [fileEntry("src/a.ts", { action: "read" })],
      }),
      processEntry({
        id: "read-completed",
        type: "tool",
        toolKind: "read_file",
        state: "completed",
        files: [fileEntry("src/b.ts", { action: "read" })],
      }),
      processEntry({
        id: "edit-completed",
        type: "tool",
        toolKind: "edit_file",
        state: "completed",
        files: [fileEntry("src/c.ts", { action: "edited" })],
      }),
    ];

    expect(mergeProcessEntries(entries).map((entry) => entry.id)).toEqual([
      "read-running",
      "read-completed",
      "edit-completed",
    ]);
  });

  it("merges adjacent file warnings without turning them into successful reads", () => {
    const entries = [
      processEntry({
        id: "warning-1",
        type: "tool",
        toolKind: "read_file",
        state: "warning",
        title: "读取文件未成功",
        detail: "a.ts not found",
        files: [fileEntry("src/a.ts", { action: "read" })],
      }),
      processEntry({
        id: "warning-2",
        type: "tool",
        toolKind: "read_file",
        state: "warning",
        title: "读取文件未成功",
        detail: "b.ts not found",
        files: [fileEntry("src/b.ts", { action: "read" })],
      }),
    ];

    expect(mergeProcessEntries(entries)).toEqual([
      expect.objectContaining({
        id: "warning-2",
        state: "warning",
        title: "读取文件未成功",
        detail: "a.ts not found\n\nb.ts not found",
        files: [
          expect.objectContaining({ file: "src/a.ts" }),
          expect.objectContaining({ file: "src/b.ts" }),
        ],
      }),
    ]);
  });

  it("groups adjacent subagent lifecycle rows with the same result", () => {
    const entries = [
      processEntry({
        id: "agent-a",
        type: "subagent",
        title: "已开始工作",
        state: "completed",
        subagents: [{ id: "thread-a", label: "Backend", status: "running" }],
      }),
      processEntry({
        id: "agent-b",
        type: "subagent",
        title: "已开始工作",
        state: "completed",
        subagents: [{ id: "thread-b", label: "Frontend", status: "running" }],
      }),
    ];

    expect(mergeProcessEntries(entries)).toEqual([
      expect.objectContaining({
        id: "agent-a",
        type: "subagent",
        subagents: [
          expect.objectContaining({ id: "thread-a", label: "Backend" }),
          expect.objectContaining({ id: "thread-b", label: "Frontend" }),
        ],
      }),
    ]);
  });

  it("keeps individual subagent updates as separate timeline rows", () => {
    const entries = [
      processEntry({
        id: "update-a",
        type: "subagent",
        title: "已更新",
        state: "completed",
        action: "interacted",
        subagents: [{ id: "thread-a", label: "Backend", status: "completed" }],
      }),
      processEntry({
        id: "update-b",
        type: "subagent",
        title: "已更新",
        state: "completed",
        action: "interacted",
        subagents: [{ id: "thread-b", label: "Frontend", status: "completed" }],
      }),
    ];

    expect(mergeProcessEntries(entries).map((entry) => entry.id)).toEqual(["update-a", "update-b"]);
  });

  it("incrementally matches full merge and reuses unchanged prefix entries", () => {
    const merger = createProcessEntryMerger();
    const status = processEntry({ id: "status", title: "status" });
    const readOne = processEntry({
      id: "read-1",
      type: "tool",
      toolKind: "read_file",
      state: "running",
      files: [fileEntry("src/a.ts", { action: "read" })],
    });
    const firstEntries = [status, readOne];
    const firstMerged = merger(firstEntries);

    const readTwo = processEntry({
      id: "read-2",
      type: "tool",
      toolKind: "read_file",
      state: "running",
      files: [fileEntry("src/b.ts", { action: "read" })],
    });
    const secondEntries = [status, readOne, readTwo];
    const secondMerged = merger(secondEntries);

    expect(secondMerged).toEqual(mergeProcessEntries(secondEntries));
    expect(secondMerged[0]).toBe(firstMerged[0]);
    expect(secondMerged[1]).toEqual(expect.objectContaining({
      id: "read-2",
      title: "正在读取 2 个文件",
    }));
  });

  it("incrementally recomputes a truncated merge group", () => {
    const merger = createProcessEntryMerger();
    const readOne = processEntry({
      id: "read-1",
      type: "tool",
      toolKind: "read_file",
      state: "running",
      files: [fileEntry("src/a.ts", { action: "read" })],
    });
    const readTwo = processEntry({
      id: "read-2",
      type: "tool",
      toolKind: "read_file",
      state: "running",
      files: [fileEntry("src/b.ts", { action: "read" })],
    });
    const readThree = processEntry({
      id: "read-3",
      type: "tool",
      toolKind: "read_file",
      state: "running",
      files: [fileEntry("src/c.ts", { action: "read" })],
    });

    merger([readOne, readTwo, readThree]);
    const truncatedEntries = [readOne, readTwo];

    expect(merger(truncatedEntries)).toEqual(mergeProcessEntries(truncatedEntries));
  });
});
