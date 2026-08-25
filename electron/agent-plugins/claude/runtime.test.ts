import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNativePackageName, getRuntimeRoot, getStatus, resolveRuntimeCommand } from "./runtime.mjs";

const tempRoots: string[] = [];
const latestSdkVersion = "0.3.241";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ version: latestSdkVersion }),
  })));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude Agent SDK runtime", () => {
  it.skipIf(process.platform !== "win32")("invokes npm through node.exe on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-claude-runtime-"));
    tempRoots.push(root);
    const npmCli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(join(root, "node_modules", "npm", "bin"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "node.exe"), ""),
      writeFile(join(root, "npm.cmd"), ""),
      writeFile(npmCli, ""),
    ]);

    expect(resolveRuntimeCommand("npm", ["--version"], { Path: root, PATHEXT: ".EXE;.CMD" }, "win32"))
      .toEqual({ command: join(root, "node.exe"), args: [npmCli, "--version"] });
  });

  it("recognizes any matching SDK and native runtime versions as installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-claude-runtime-"));
    tempRoots.push(root);
    const context = { dataDir: root, pluginDir: join(root, "plugin") };
    const packageDir = join(getRuntimeRoot(context), "node_modules", "@anthropic-ai", "claude-agent-sdk");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ version: latestSdkVersion }));
    const nativePackageName = getNativePackageName();
    expect(nativePackageName).toBeTruthy();
    const nativePackageDir = join(getRuntimeRoot(context), "node_modules", "@anthropic-ai", nativePackageName!);
    await mkdir(nativePackageDir, { recursive: true });
    await Promise.all([
      writeFile(join(nativePackageDir, "package.json"), JSON.stringify({ version: latestSdkVersion })),
      writeFile(join(nativePackageDir, process.platform === "win32" ? "claude.exe" : "claude"), "binary"),
    ]);

    await expect(getStatus(context)).resolves.toMatchObject({
      installed: true,
      currentVersion: latestSdkVersion,
      latestVersion: latestSdkVersion,
      updateAvailable: false,
    });
  });

  it("rejects a partial install without the native package metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-claude-runtime-"));
    tempRoots.push(root);
    const context = { dataDir: root, pluginDir: join(root, "plugin") };
    const packageDir = join(getRuntimeRoot(context), "node_modules", "@anthropic-ai", "claude-agent-sdk");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ version: latestSdkVersion }));

    await expect(getStatus(context)).resolves.toMatchObject({
      installed: false,
      currentVersion: latestSdkVersion,
      updateAvailable: true,
      error: "Claude Agent SDK 原生运行组件未安装完整，请重新安装。",
    });
  });
});
