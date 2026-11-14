import { describe, expect, it } from "vitest";

import { shouldCreateSessionDirectly } from "./new-session-flow";

describe("shouldCreateSessionDirectly", () => {
  it("默认工作区不需要弹窗", () => {
    expect(shouldCreateSessionDirectly(true, null)).toBe(true);
  });

  it("不是 Git 仓库时直接建会话", () => {
    expect(shouldCreateSessionDirectly(false, { supported: false })).toBe(true);
  });

  it("有 Git 环境时仍然弹窗让人选 worktree", () => {
    expect(shouldCreateSessionDirectly(false, { supported: true })).toBe(false);
  });

  it("探测失败时退回弹窗，不静默改变行为", () => {
    expect(shouldCreateSessionDirectly(false, null)).toBe(false);
  });
});
