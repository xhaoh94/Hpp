import { describe, expect, it } from "vitest";

import { fallbackCommandDescription } from "./command-description";

describe("fallbackCommandDescription", () => {
  it("maps common commands to a chinese verb", () => {
    expect(fallbackCommandDescription("grep -rn idle src")).toBe("搜索项目代码");
    expect(fallbackCommandDescription("rg TODO")).toBe("搜索项目代码");
    expect(fallbackCommandDescription("git status")).toBe("查看 Git 工作区状态");
    expect(fallbackCommandDescription("pnpm test")).toBe("运行项目脚本");
  });

  it("looks past shell wrappers and flags", () => {
    expect(fallbackCommandDescription("bash -lc grep -rn idle src")).toBe("搜索项目代码");
    expect(fallbackCommandDescription("powershell -Command Get-ChildItem")).toBe("列出项目文件");
    expect(fallbackCommandDescription("/usr/bin/git log")).toBe("查看 Git 提交记录");
  });

  it("falls back to the tool name or a generic label", () => {
    expect(fallbackCommandDescription("")).toBe("执行命令");
    expect(fallbackCommandDescription(undefined, "shell")).toBe("执行 shell");
    expect(fallbackCommandDescription("something-weird --flag")).toBe("执行 something-weird");
  });
});
