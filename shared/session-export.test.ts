import { describe, expect, it } from "vitest";
import {
  buildSearchSnippet,
  buildSessionMarkdown,
  sanitizeExportFileName,
} from "./session-export";

describe("session search snippet", () => {
  it("centres the snippet on the first match and marks truncation", () => {
    const content = `${"前".repeat(80)}关键错误${"后".repeat(80)}`;
    const snippet = buildSearchSnippet(content, "关键错误", 10);
    expect(snippet).toContain("关键错误");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("falls back to the head when the query is missing", () => {
    expect(buildSearchSnippet("短内容", "找不到")).toBe("短内容");
  });
});

describe("session markdown export", () => {
  it("keeps roles, timestamps and skips empty bodies", () => {
    const markdown = buildSessionMarkdown({
      title: "修复登录竞态",
      projectName: "Hpp",
      agentName: "Pi",
      exportedAt: new Date("2026-11-14T10:00:00+08:00").getTime(),
      messages: [
        { role: "user", content: "登录偶发失败，帮我看下", timestamp: new Date("2026-11-14T09:58:00+08:00").getTime() },
        { role: "assistant", content: "", timestamp: Date.now() },
        { role: "assistant", content: "定位到 token 刷新时序。", timestamp: new Date("2026-11-14T09:59:00+08:00").getTime() },
      ],
    });
    expect(markdown).toContain("# 修复登录竞态");
    expect(markdown).toContain("- 项目：Hpp");
    expect(markdown).toContain("- Agent：Pi");
    expect(markdown).toContain("## 用户 · 2026-11-14 09:58");
    expect(markdown).toContain("## 助手 · 2026-11-14 09:59");
    expect(markdown).toContain("定位到 token 刷新时序。");
  });

  it("falls back to a generic title", () => {
    expect(buildSessionMarkdown({ title: "  ", messages: [] })).toContain("# 会话");
  });
});

describe("export file name", () => {
  it("strips path separators and reserved characters", () => {
    expect(sanitizeExportFileName('a/b\\c:d*e?"f"<g>|h')).toBe("a b c d e f g h");
    expect(sanitizeExportFileName("   ")).toBe("会话");
  });
});
