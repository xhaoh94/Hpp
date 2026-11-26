import { describe, expect, it } from "vitest";
import { filterEnabledAgents } from "./agents";

const agents = [{ id: "pi" }, { id: "codex" }, { id: "codebuddy" }];

describe("filterEnabledAgents", () => {
  it("未保存过启用列表时保持旧行为：全部显示", () => {
    expect(filterEnabledAgents(agents, undefined)).toEqual(agents);
    expect(filterEnabledAgents(agents, null)).toEqual(agents);
  });

  it("保存过启用列表后只显示勾选的 Agent（未勾选的新插件不出现）", () => {
    expect(filterEnabledAgents(agents, ["pi", "codex"]).map((agent) => agent.id)).toEqual(["pi", "codex"]);
  });

  it("启用列表里的未知 id 不会造出幽灵按钮", () => {
    expect(filterEnabledAgents(agents, ["pi", "ghost"]).map((agent) => agent.id)).toEqual(["pi"]);
  });

  it("全部取消勾选时返回空列表", () => {
    expect(filterEnabledAgents(agents, [])).toEqual([]);
  });
});