import { describe, expect, it } from "vitest";
import { getCodexCommandInvocation } from "./command-invocation.mjs";

describe("Codex command invocation", () => {
  it("runs Windows npm shims through cmd without shell mode", () => {
    const invocation = getCodexCommandInvocation(
      "C:\\Program Files\\Hpp Runtime\\codex.cmd",
      ["app-server", "--stdio"],
      "win32",
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    );

    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args).toEqual([
      "/d",
      "/s",
      "/c",
      'call "C:\\Program Files\\Hpp Runtime\\codex.cmd" app-server --stdio',
    ]);
  });

  it("runs native executables directly", () => {
    expect(getCodexCommandInvocation("C:\\Tools\\codex.exe", ["--version"], "win32", {})).toEqual({
      command: "C:\\Tools\\codex.exe",
      args: ["--version"],
    });
  });
});
