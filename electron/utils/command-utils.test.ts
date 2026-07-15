import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import {
  findCommandOnPath,
  findCommandsOnPath,
  getCommonCommandDirs,
  getExecFileInvocation,
  getNpmPackageBinTarget,
  getNpmInvocation,
} from "./command-utils";

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

  it("resolves the real executable behind a global npm shim", async () => {
    const prefixDir = await mkdtemp(join(tmpdir(), "hpp-global-npm-bin-"));
    try {
      const shimPath = join(prefixDir, "opencode.cmd");
      const targetPath = join(prefixDir, "node_modules", "opencode-ai", "bin", "opencode.exe");
      await mkdir(join(prefixDir, "node_modules", "opencode-ai", "bin"), { recursive: true });
      await writeFile(shimPath, "@echo off\n", "utf8");
      await writeFile(targetPath, "", "utf8");

      expect(getNpmPackageBinTarget(
        shimPath,
        "opencode-ai",
        join("bin", "opencode.exe"),
      )).toBe(targetPath);
    } finally {
      await rm(prefixDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("ignores bare npm shell shims on Windows", async () => {
    const commandDir = await mkdtemp(join(tmpdir(), "hpp-command-path-"));
    try {
      await writeFile(join(commandDir, "codex"), "#!/bin/sh\n", "utf8");
      await writeFile(join(commandDir, "codex.cmd"), "@echo off\n", "utf8");
      const env = { ...process.env, PATH: commandDir, PATHEXT: ".EXE" };

      expect(findCommandOnPath("codex", { env })).toBe(join(commandDir, "codex.cmd"));
      expect(findCommandsOnPath("codex", { env })).toEqual([join(commandDir, "codex.cmd")]);
    } finally {
      await rm(commandDir, { recursive: true, force: true });
    }
  });
});
