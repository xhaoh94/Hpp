import { describe, expect, it } from "vitest";

import { fallbackCommandDescription } from "./command-description";

describe("fallbackCommandDescription", () => {
  it("maps common commands to a chinese verb", () => {
    expect(fallbackCommandDescription("grep -rn idle src")).toBe("检索内容");
    expect(fallbackCommandDescription("rg TODO")).toBe("检索内容");
    expect(fallbackCommandDescription("git status")).toBe("执行 Git 操作");
    expect(fallbackCommandDescription("pnpm test")).toBe("运行 pnpm 命令");
  });

  it("looks past shell wrappers and flags", () => {
    expect(fallbackCommandDescription("bash -lc grep -rn idle src")).toBe("检索内容");
    expect(fallbackCommandDescription("powershell -Command Get-ChildItem")).toBe("执行 get-childitem");
    expect(fallbackCommandDescription("/usr/bin/git log")).toBe("执行 Git 操作");
  });

  it("falls back to the tool name or a generic label", () => {
    expect(fallbackCommandDescription("")).toBe("执行命令");
    expect(fallbackCommandDescription(undefined, "shell")).toBe("执行 shell");
    expect(fallbackCommandDescription("something-weird --flag")).toBe("执行 something-weird");
  });
});
