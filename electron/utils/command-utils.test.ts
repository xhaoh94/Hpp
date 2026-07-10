import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { getCommonCommandDirs, getExecFileInvocation, getNpmInvocation } from "./command-utils";

describe("getExecFileInvocation", () => {
  it("quotes Windows command shims located under Program Files", () => {
    const env = {
      ...process.env,
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Program Files\\nodejs",
      PATHEXT: ".CMD;.EXE",
    };

    const invocation = getExecFileInvocation("npm", ["install", "example@latest"], env);

    expect(invocation.command).toBe(env.ComSpec);
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain('call "C:\\Program Files\\nodejs\\npm.cmd" install example@latest');
    expect(invocation.args[3]).toContain("chcp 65001");
  });

  it("includes common macOS package manager locations", () => {
    expect(getCommonCommandDirs("darwin", {}, "/Users/tester")).toEqual(expect.arrayContaining([
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/tester/.volta/bin",
    ]));
  });

  it("includes common Linux user and system locations", () => {
    expect(getCommonCommandDirs("linux", {}, "/home/tester")).toEqual(expect.arrayContaining([
      "/usr/local/bin",
      "/usr/bin",
      "/home/tester/.local/bin",
    ]));
  });

  it("runs npm through Node without invoking a shell shim", () => {
    const invocation = getNpmInvocation(["--version"], process.env);
    expect(invocation).not.toBeNull();
    expect(invocation?.command.toLowerCase()).not.toMatch(/\.(?:cmd|bat)$/);
    const output = execFileSync(invocation!.command, invocation!.args, { encoding: "utf8" }).trim();
    expect(output).toMatch(/^\d+\.\d+\.\d+/);
  });
});
