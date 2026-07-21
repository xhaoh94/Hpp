import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: spawnMock };
});

import { getNativePackageName, getRuntimeRoot, PACKAGE_NAME, SDK_VERSION, uninstall, update } from "./runtime.mjs";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
}

const roots: string[] = [];

afterEach(async () => {
  spawnMock.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude runtime operations", () => {
  it("installs the pinned SDK and removes its private runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hpp-claude-runtime-ops-"));
    roots.push(dataDir);
    const context = { dataDir, pluginDir: join(dataDir, "plugin") };
    const packageDir = join(getRuntimeRoot(context), "node_modules", "@anthropic-ai", "claude-agent-sdk");
    const nativePackageName = getNativePackageName();
    expect(nativePackageName).toBeTruthy();
    const nativePackageDir = join(getRuntimeRoot(context), "node_modules", "@anthropic-ai", nativePackageName!);

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeProcess();
      queueMicrotask(() => {
        if (args.includes("install")) {
          mkdirSync(packageDir, { recursive: true });
          writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version: SDK_VERSION }));
          mkdirSync(nativePackageDir, { recursive: true });
          writeFileSync(join(nativePackageDir, "package.json"), JSON.stringify({ version: SDK_VERSION }));
          writeFileSync(join(nativePackageDir, process.platform === "win32" ? "claude.exe" : "claude"), "binary");
        }
        child.stdout.write(args.includes("--version") ? "22.19.0\n" : "");
        child.emit("exit", 0);
      });
      return child;
    });

    await expect(update(context)).resolves.toMatchObject({
      success: true,
      status: { installed: true, currentVersion: SDK_VERSION },
    });
    expect(spawnMock.mock.calls.some(([, args]) =>
      Array.isArray(args) && args.includes("install") && args.includes(`${PACKAGE_NAME}@${SDK_VERSION}`)
      && args.includes("--save-exact") && args.includes("--omit=dev"))).toBe(true);

    const installCalls = spawnMock.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes("install")).length;
    await expect(update(context)).resolves.toMatchObject({ success: true, status: { installed: true } });
    expect(spawnMock.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes("install"))).toHaveLength(installCalls);

    await expect(uninstall(context)).resolves.toEqual({ success: true });
    expect(existsSync(getRuntimeRoot(context))).toBe(false);
  });

  it("accepts an abnormal npm exit only when both SDK packages are complete", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hpp-claude-runtime-ops-"));
    roots.push(dataDir);
    const context = { dataDir, pluginDir: join(dataDir, "plugin") };
    const packageDir = join(getRuntimeRoot(context), "node_modules", "@anthropic-ai", "claude-agent-sdk");
    const nativePackageName = getNativePackageName()!;
    const nativePackageDir = join(getRuntimeRoot(context), "node_modules", "@anthropic-ai", nativePackageName);

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeProcess();
      queueMicrotask(() => {
        if (args.includes("install")) {
          mkdirSync(packageDir, { recursive: true });
          writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version: SDK_VERSION }));
          mkdirSync(nativePackageDir, { recursive: true });
          writeFileSync(join(nativePackageDir, "package.json"), JSON.stringify({ version: SDK_VERSION }));
          writeFileSync(join(nativePackageDir, process.platform === "win32" ? "claude.exe" : "claude"), "binary");
          child.emit("exit", null, "SIGTERM");
          return;
        }
        child.stdout.write("22.19.0\n");
        child.emit("exit", 0);
      });
      return child;
    });

    await expect(update(context)).resolves.toMatchObject({
      success: true,
      status: { installed: true, currentVersion: SDK_VERSION },
    });
  });
});
