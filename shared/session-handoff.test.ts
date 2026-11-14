import { describe, expect, it } from "vitest";
import { buildSessionHandoff } from "./session-handoff";

describe("session handoff summary", () => {
  it("keeps the goal, recent speech, touched files and the last conclusion", () => {
    const summary = buildSessionHandoff({
      title: "修复登录竞态",
      projectName: "Hpp",
      agentName: "Pi",
      messages: [
        { role: "user", content: "登录偶发失败，帮我修掉", timestamp: 1 },
        { role: "assistant", content: "定位到 token 刷新时序。", diffs: [{ file: "src/auth/refresh.ts", status: "modified" }, { file: "src/auth/login.ts", status: "added" }] },
        { role: "user", content: "顺手补个测试", uiGenerated: true },
        { role: "user", content: "记得跑一遍全部测试" },
        { role: "assistant", content: "已修复并补齐测试。" },
      ],
    });

    expect(summary).toContain("# 会话交接：修复登录竞态");
    expect(summary).toContain("- 项目：Hpp");
    expect(summary).toContain("登录偶发失败，帮我修掉");
    expect(summary).toContain("记得跑一遍全部测试");
    // 问卷/UI 应答不算真实发言。
    expect(summary).not.toContain("顺手补个测试");
    expect(summary).toContain("src/auth/refresh.ts（修改）");
    expect(summary).toContain("src/auth/login.ts（新增）");
    expect(summary).toContain("已修复并补齐测试。");
    expect(summary).toContain("不要重复已完成的工作");
  });

  it("handles an empty conversation without crashing", () => {
    const summary = buildSessionHandoff({ title: "", messages: [] });
    expect(summary).toContain("# 会话交接：未命名会话");
    expect(summary).toContain("（没有可用的用户发言）");
  });

  it("clips very long messages", () => {
    const summary = buildSessionHandoff({
      title: "长文",
      messages: [{ role: "user", content: "啊".repeat(2000) }],
    });
    expect(summary).toContain("…");
    expect(summary.length).toBeLessThan(2000);
  });
});
