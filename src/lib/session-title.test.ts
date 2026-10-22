import { describe, expect, it } from "vitest";
import {
  SESSION_TITLE_MAX_CHARS,
  createDefaultSessionTitle,
  isPlaceholderSessionTitle,
  resolveSessionTitle,
  toSessionTitle,
} from "./session-title";

describe("session title helpers", () => {
  it("builds the placeholder title used for brand-new sessions", () => {
    const title = createDefaultSessionTitle(new Date(2026, 0, 2, 3, 4, 5));
    expect(title.startsWith("新会话 - ")).toBe(true);
    expect(isPlaceholderSessionTitle(title)).toBe(true);
  });

  it("treats only untouched placeholder titles as replaceable", () => {
    expect(isPlaceholderSessionTitle("新会话")).toBe(true);
    expect(isPlaceholderSessionTitle("  新会话 - 2025/10/15 21:26 ")).toBe(true);
    expect(isPlaceholderSessionTitle("")).toBe(true);
    expect(isPlaceholderSessionTitle("修复侧栏会话标题")).toBe(false);
    expect(isPlaceholderSessionTitle("分叉 - 修复侧栏会话标题")).toBe(false);
    expect(isPlaceholderSessionTitle("引导")).toBe(false);
  });

  it("replaces the placeholder with the first user message preview", () => {
    expect(resolveSessionTitle("新会话 - 2025/10/15 21:26", "优化会话加载")).toBe("优化会话加载");
    expect(resolveSessionTitle("新会话 - 2025/10/15 21:26", "   ")).toBe("新会话 - 2025/10/15 21:26");
  });

  it("keeps an already meaningful title", () => {
    expect(resolveSessionTitle("修复侧栏会话标题", "新的请求")).toBe("修复侧栏会话标题");
    expect(resolveSessionTitle("分叉 - 修复侧栏会话标题", "新的请求")).toBe("分叉 - 修复侧栏会话标题");
  });

  it("compacts and truncates long previews", () => {
    expect(toSessionTitle("第一行\n\n第二行")).toBe("第一行 第二行");
    const long = "长".repeat(SESSION_TITLE_MAX_CHARS + 10);
    const title = toSessionTitle(long);
    expect(title.endsWith("...")).toBe(true);
    expect(title.length).toBe(SESSION_TITLE_MAX_CHARS);
  });
});
