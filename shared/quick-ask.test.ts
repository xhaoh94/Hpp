import { describe, expect, it } from "vitest";
import { pickQuickAskTarget, toElectronAccelerator } from "./quick-ask";

describe("quick ask accelerator", () => {
  it("maps display modifiers to electron accelerators", () => {
    expect(toElectronAccelerator("Ctrl+Shift+Space")).toBe("CommandOrControl+Shift+Space");
    expect(toElectronAccelerator("Cmd+Alt+K")).toBe("Command+Alt+K");
    expect(toElectronAccelerator("alt+f1")).toBe("Alt+F1");
  });

  it("rejects single-key and malformed combos", () => {
    // 单键注册会吞掉整个系统的该按键，必须拒绝。
    expect(toElectronAccelerator("Space")).toBeNull();
    expect(toElectronAccelerator("Ctrl+")).toBeNull();
    expect(toElectronAccelerator("Ctrl+Whatever")).toBeNull();
  });
});

describe("quick ask target", () => {
  const projects = {
    activeSessionId: "s2",
    projects: [
      {
        id: "p1",
        name: "Hpp",
        sessions: [
          { id: "s1", title: "旧会话", lastActiveAt: "2026-11-10T10:00:00.000Z", closed: true },
          { id: "s2", title: "当前会话", lastActiveAt: "2026-11-12T10:00:00.000Z" },
        ],
      },
      {
        id: "p2",
        name: "UxGame",
        sessions: [{ id: "s3", title: "最近活跃", lastActiveAt: "2026-11-14T10:00:00.000Z" }],
      },
    ],
  };

  it("prefers the persisted active session and skips closed ones", () => {
    expect(pickQuickAskTarget(projects)).toMatchObject({
      sessionId: "s2",
      sessionTitle: "当前会话",
      projectId: "p1",
      projectName: "Hpp",
    });
  });

  it("falls back to the most recently active open session", () => {
    expect(pickQuickAskTarget({ ...projects, activeSessionId: "gone" })).toMatchObject({
      sessionId: "s3",
      projectName: "UxGame",
    });
  });

  it("returns null when nothing is open", () => {
    expect(pickQuickAskTarget({ projects: [] })).toBeNull();
    expect(pickQuickAskTarget(null)).toBeNull();
  });
});
