import { describe, expect, it } from "vitest";
import {
  getAgentActionDisplayDescription,
  isAgentActionInvocation,
  sanitizeAgentActionCatalog,
} from "./agent-actions";

describe("agent actions", () => {
  it("sanitizes catalogs without carrying native paths or contents", () => {
    expect(sanitizeAgentActionCatalog([{
      kind: "skill",
      name: " review ",
      description: " Check changes ",
      argumentHint: " [scope] ",
      path: "C:\\secret\\SKILL.md",
      content: "private instructions",
    }, {
      kind: "skill",
      name: "review",
    }, {
      kind: "command",
      name: "release",
    }])).toEqual([{
      kind: "skill",
      name: "review",
      description: "Check changes",
      argumentHint: "[scope]",
    }, {
      kind: "command",
      name: "release",
    }]);
  });

  it("validates compact action invocations", () => {
    expect(isAgentActionInvocation({ kind: "skill", name: "review" })).toBe(true);
    expect(isAgentActionInvocation({ kind: "tool", name: "review" })).toBe(false);
    expect(isAgentActionInvocation({ kind: "command", name: "" })).toBe(false);
  });

  it("localizes known Claude actions without changing custom Agent descriptions", () => {
    expect(getAgentActionDisplayDescription("claude", {
      name: "doctor",
      description: "Health-check the Claude Code setup",
      argumentHint: "[scope]",
    })).toBe("检查 Claude Code 的安装和配置，并诊断常见问题。（参数：[scope]）");
    expect(getAgentActionDisplayDescription("codex", {
      name: "doctor",
      description: "Check this custom setup",
    })).toBe("Check this custom setup");
  });
});
