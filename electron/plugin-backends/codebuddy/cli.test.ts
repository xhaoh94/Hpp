import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodebuddyInvocation,
  findBundledCli,
  findOnPath,
  resolveCodebuddyCli,
  resolveNodeEntryFromShim,
  resolveNodeRuntime,
} from "./cli";

const tempDirs: string[] = [];
const originalNodePath = process.env.CODEBUDDY_NODE_PATH;

const createTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hpp-codebuddy-cli-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  if (originalNodePath === undefined) delete process.env.CODEBUDDY_NODE_PATH;
  else process.env.CODEBUDDY_NODE_PATH = originalNodePath;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("findOnPath", () => {
  it("findOnPath 命中 PATH 里的 npm shim", () => {
    const dir = createTempDir();
    const shim = join(dir, process.platform === "win32" ? "codebuddy.cmd" : "codebuddy");
    writeFileSync(shim, "", "utf8");
    const env = { PATH: dir } as Record<string, string | undefined>;
    expect(findOnPath("codebuddy", env)).toBe(shim);
  });

  it("PATH 为空时返回 null", () => {
    expect(findOnPath("codebuddy", { PATH: "" })).toBeNull();
  });
});

describe("findBundledCli", () => {
  it("识别 WorkBuddy 内嵌 CLI 的默认安装位置", () => {
    const root = createTempDir();
    const cliDir = join(root, "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin");
    mkdirSync(cliDir, { recursive: true });
    const cliPath = join(cliDir, "codebuddy");
    writeFileSync(cliPath, "", "utf8");
    const env = process.platform === "win32"
      ? { ProgramFiles: root } as Record<string, string | undefined>
      : undefined;
    if (process.platform !== "win32") return;
    expect(findBundledCli(env)).toBe(cliPath);
  });
});

describe("resolveCodebuddyCli", () => {
  it("CODEBUDDY_PATH 优先级最高", () => {
    const dir = createTempDir();
    const explicit = join(dir, "my-codebuddy.cmd");
    writeFileSync(explicit, "", "utf8");
    const env = { CODEBUDDY_PATH: explicit, PATH: "" } as Record<string, string | undefined>;
    expect(resolveCodebuddyCli(env)).toEqual({ scriptPath: explicit, bundled: false });
  });

  it("PATH 上有公开命令时不用内嵌包", () => {
    const dir = createTempDir();
    const shim = join(dir, process.platform === "win32" ? "codebuddy.cmd" : "codebuddy");
    writeFileSync(shim, "", "utf8");
    const env = { PATH: dir } as Record<string, string | undefined>;
    expect(resolveCodebuddyCli(env)).toEqual({ scriptPath: shim, bundled: false });
  });

  it("都找不到时返回 null", () => {
    const env = { PATH: createTempDir(), ProgramFiles: createTempDir() } as Record<string, string | undefined>;
    expect(resolveCodebuddyCli(env)).toBeNull();
  });
});

describe("buildCodebuddyInvocation", () => {
  it("内嵌 lite 包要带 FORCE_LITE_WB_BUNDLE", () => {
    const invocation = buildCodebuddyInvocation(
      { scriptPath: join("C:", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"), bundled: true },
      ["-p"],
    );
    expect(invocation.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE).toBe("1");
    expect(invocation.args).toContain("-p");
  });

  it("Windows 的 .cmd shim 走 cmd /c", () => {
    if (process.platform !== "win32") return;
    const invocation = buildCodebuddyInvocation({ scriptPath: "C:\\npm\\codebuddy.cmd", bundled: false }, ["-p"]);
    expect(invocation.command.toLowerCase()).toContain("cmd");
    expect(invocation.args.slice(-1)).toEqual(["-p"]);
    expect(invocation.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE).toBeUndefined();
  });

  it("能找到 npm 包 JS 入口时绕过 cmd 直接跑 node", () => {
    if (process.platform !== "win32") return;
    const dir = createTempDir();
    const packageDir = join(dir, "node_modules", "@tencent-ai", "codebuddy-code");
    mkdirSync(join(packageDir, "bin"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ bin: { codebuddy: "bin/codebuddy" } }), "utf8");
    const entry = join(packageDir, "bin", "codebuddy");
    writeFileSync(entry, "", "utf8");
    const shim = join(dir, "codebuddy.cmd");
    writeFileSync(shim, "", "utf8");

    expect(resolveNodeEntryFromShim(shim)).toBe(entry);
    const invocation = buildCodebuddyInvocation({ scriptPath: shim, bundled: false }, ["-p"]);
    expect(invocation.command.toLowerCase()).not.toContain("cmd");
    expect(invocation.args[0]).toBe(entry);
    expect(invocation.args.slice(-1)).toEqual(["-p"]);
  });

  it("识别离线包的 %~dp0app 布局", () => {
    if (process.platform !== "win32") return;
    const dir = createTempDir();
    const packageDir = join(dir, "app", "node_modules", "@tencent-ai", "codebuddy-code");
    mkdirSync(join(packageDir, "bin"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ bin: { codebuddy: "bin/codebuddy" } }), "utf8");
    const entry = join(packageDir, "bin", "codebuddy");
    writeFileSync(entry, "", "utf8");
    const shim = join(dir, "codebuddy.cmd");
    writeFileSync(
      shim,
      '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0app\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*\r\n',
      "utf8",
    );

    expect(resolveNodeEntryFromShim(shim)).toBe(entry);
    const invocation = buildCodebuddyInvocation({ scriptPath: shim, bundled: false }, ["-p"]);
    expect(invocation.command.toLowerCase()).not.toContain("cmd");
    expect(invocation.args[0]).toBe(entry);
  });

  it("node 脚本用 node 运行时执行", () => {
    process.env.CODEBUDDY_NODE_PATH = "C:\\fake\\node.exe";
    const invocation = buildCodebuddyInvocation({ scriptPath: "C:\\cli\\bin\\codebuddy", bundled: false }, ["-p"]);
    expect(invocation.command).toBe("C:\\fake\\node.exe");
    expect(invocation.args[0]).toBe("C:\\cli\\bin\\codebuddy");
  });
});

describe("resolveNodeRuntime", () => {
  it("CODEBUDDY_NODE_PATH 可覆盖运行时", () => {
    process.env.CODEBUDDY_NODE_PATH = "D:\\node\\node.exe";
    expect(resolveNodeRuntime().command).toBe("D:\\node\\node.exe");
  });
});