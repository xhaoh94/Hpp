import { describe, expect, it } from "vitest";
import {
  getProcessGroupState,
  getVisibleProcessEntries,
  groupProcessEntries,
  isCommandProcessEntry,
  isProcessInterrupted,
  splitCommandDetail,
  type ProcessEntryView,
} from "./process-view";

const entry = (patch: Partial<ProcessEntryView> & Pick<ProcessEntryView, "id" | "type" | "title">): ProcessEntryView => patch;

describe("shared process view model", () => {
  it("recognizes, groups, and splits consecutive commands", () => {
    const entries = [
      entry({ id: "one", type: "tool", title: "正在运行 git", detail: "$ git status\nclean", state: "completed" }),
      entry({ id: "two", type: "tool", title: "command", toolKind: "run_command", command: "npm test", state: "running" }),
      entry({ id: "three", type: "status", title: "完成", state: "completed" }),
    ];
    expect(isCommandProcessEntry(entries[0])).toBe(true);
    expect(groupProcessEntries(entries).map((group) => group.kind)).toEqual(["commands", "entry"]);
    expect(splitCommandDetail(entries[0])).toEqual({ command: "git status", output: "clean" });
    expect(getProcessGroupState(entries.slice(0, 2))).toBe("running");
  });

  it("filters body-output markers and reports interruption", () => {
    const entries = [
      entry({ id: "body", type: "info", title: "正文输出" }),
      entry({ id: "stop", type: "status", title: "用户已手动中断", state: "interrupted" }),
    ];
    expect(getVisibleProcessEntries(entries).map((item) => item.id)).toEqual(["stop"]);
    expect(isProcessInterrupted(entries)).toBe(true);
  });
});
