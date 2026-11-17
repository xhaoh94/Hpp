import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOpLog,
  getOpLogSnapshot,
  pushOpLog,
  subscribeOpLog,
} from "./git-op-log-store";

describe("process-scoped git operation log store", () => {
  beforeEach(() => clearOpLog());

  it("keeps pushed entries until explicitly cleared", () => {
    pushOpLog({ title: "提交", tone: "success", message: "已提交" });
    const first = getOpLogSnapshot();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: 1, title: "提交" });
    expect(first[0].time).toMatch(/^\d{2}:\d{2}:\d{2}$/);

    pushOpLog({ title: "推送", tone: "success", message: "已推送" });
    expect(getOpLogSnapshot()).toHaveLength(2);
    // 同一条日志重新 push 时 id 仍递增，不会撞 key。
    expect(getOpLogSnapshot()[1].id).toBe(2);

    clearOpLog();
    expect(getOpLogSnapshot()).toEqual([]);
  });

  it("notifies subscribers on push and clear, with a stable snapshot between changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOpLog(listener);
    const snapshot = getOpLogSnapshot();
    expect(getOpLogSnapshot()).toBe(snapshot);

    pushOpLog({ title: "x", tone: "success", message: "x" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getOpLogSnapshot()).not.toBe(snapshot);

    clearOpLog();
    expect(listener).toHaveBeenCalledTimes(2);
    // 已经空了再 clear 不发通知，避免无意义重渲染。
    clearOpLog();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    pushOpLog({ title: "y", tone: "success", message: "y" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("caps the log so a long session does not grow without bound", () => {
    for (let index = 0; index < 230; index += 1) {
      pushOpLog({ title: `op-${index}`, tone: "success", message: "" });
    }
    const log = getOpLogSnapshot();
    expect(log).toHaveLength(200);
    expect(log[0].title).toBe("op-30");
    expect(log[log.length - 1].title).toBe("op-229");
  });
});
