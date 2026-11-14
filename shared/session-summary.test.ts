import { describe, expect, it } from "vitest";

import { buildSessionHandoff } from "./session-handoff";
import {
  buildSessionSummary,
  renderSessionHandoffFromBody,
  renderSessionSummaryBody,
} from "./session-summary";

const input = {
  title: "修复登录竞态",
  projectName: "Hpp",
  agentName: "Pi",
  sourceSessionId: "session-1",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messages: [
    { role: "user", content: "登录偶发失败，帮我修掉", timestamp: 1 },
    {
      role: "assistant",
      content: "定位到 token 刷新时序。",
      diffs: [{ file: "src/auth/refresh.ts", status: "modified", additions: 12, deletions: 3 }],
    },
    { role: "user", content: "顺手补个测试", uiGenerated: true },
    { role: "user", content: "记得跑一遍全部测试" },
    { role: "assistant", content: "已修复并补齐测试。" },
  ],
};

describe("unified session summary", () => {
  it("renders one body shared by references and handoff export", () => {
    const summary = buildSessionSummary(input);
    const body = renderSessionSummaryBody(summary);
    const handoff = buildSessionHandoff(input);

    expect(body).toContain("- 项目：Hpp");
    expect(body).toContain("- 原 Agent：Pi");
    expect(body).toContain("## 目标");
    expect(body).toContain("登录偶发失败，帮我修掉");
    expect(body).toContain("## 最近进展");
    expect(body).toContain("记得跑一遍全部测试");
    expect(body).not.toContain("顺手补个测试");
    expect(body).toContain("src/auth/refresh.ts（修改，+12 -3）");
    expect(body).toContain("## 当前结论");
    expect(body).toContain("已修复并补齐测试。");
    expect(handoff).toContain(body);
    expect(renderSessionHandoffFromBody(summary.title, body)).toBe(handoff);
  });

  it("keeps the handoff heading and footer while reusing the same body", () => {
    const summary = buildSessionSummary(input);
    const handoff = buildSessionHandoff(input);
    expect(handoff.startsWith("# 会话交接：修复登录竞态\n\n")).toBe(true);
    expect(handoff.endsWith("不要重复已完成的工作。\n")).toBe(true);
    expect(handoff).toContain(renderSessionSummaryBody(summary));
  });
});
