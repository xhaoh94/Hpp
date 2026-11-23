import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error Hpp worker extension is intentionally shipped as ESM.
import {
  isSafeSubagentShellCommand,
  isSubagentPathWithinProject,
  resolveRealSubagentPath,
  resolveSubagentCwd,
} from "./subagent-policy.mjs";

describe("SubAgent 路径与命令策略", () => {
  let root = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hpp-subagent-policy-"));
    outside = await mkdtemp(join(tmpdir(), "hpp-subagent-policy-outside-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export {};\n", "utf8");
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("允许项目内的已有路径和新文件", () => {
    expect(isSubagentPathWithinProject(root, join(root, "src", "app.ts"))).toBe(true);
    // 新文件还不存在：解析最近的已有父目录后仍应判定在项目内。
    expect(isSubagentPathWithinProject(root, join(root, "src", "new-file.ts"))).toBe(true);
  });

  it("拒绝 .. 逃逸和项目外绝对路径", () => {
    expect(isSubagentPathWithinProject(root, join(root, "..", "escape.txt"))).toBe(false);
    expect(isSubagentPathWithinProject(root, join(outside, "secret.txt"))).toBe(false);
  });

  it("拒绝符号链接逃逸", async () => {
    try {
      await symlink(outside, join(root, "link"), "junction");
    } catch {
      // Windows 无创建链接权限时跳过。
      return;
    }
    expect(isSubagentPathWithinProject(root, join(root, "link", "secret.txt"))).toBe(false);
  });

  it("拒绝断链，不回退到词法路径", async () => {
    try {
      await symlink(join(outside, "missing-target"), join(root, "broken"), "file");
    } catch {
      return;
    }
    expect(() => resolveRealSubagentPath(join(root, "broken"))).toThrow();
  });

  it("resolveSubagentCwd 拒绝项目外目录", () => {
    expect(() => resolveSubagentCwd(outside, root)).toThrow(/项目目录/);
    const resolved = resolveSubagentCwd(join(root, "src"), root);
    expect(isSubagentPathWithinProject(resolved.projectRoot, resolved.cwd)).toBe(true);
  });

  it("shell 白名单只放行完全无参数只读命令", () => {
    expect(isSafeSubagentShellCommand("pwd")).toBe(true);
    expect(isSafeSubagentShellCommand("whoami")).toBe(true);
    expect(isSafeSubagentShellCommand("Get-Location")).toBe(true);
    expect(isSafeSubagentShellCommand("pwd && rm -rf /")).toBe(false);
    expect(isSafeSubagentShellCommand("rm -rf /")).toBe(false);
    expect(isSafeSubagentShellCommand("pwd extra")).toBe(false);
  });
});