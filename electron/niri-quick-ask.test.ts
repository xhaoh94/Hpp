import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/home/test/Hpp",
  },
}));

vi.mock("child_process", () => ({ execFileSync: execFileSyncMock }));

import { buildNiriQuickAskBindings, syncNiriQuickAsk, toNiriShortcut } from "./niri-quick-ask";

describe("niri quick ask bindings", () => {
  it("converts Hpp shortcuts to niri syntax", () => {
    expect(toNiriShortcut("Ctrl+Shift+Alt+H")).toBe("Ctrl+Shift+Alt+H");
    expect(toNiriShortcut("Meta+Space")).toBe("Super+Space");
    expect(toNiriShortcut("Ctrl+Enter")).toBe("Ctrl+Return");
    expect(toNiriShortcut("Alt+Escape")).toBe("Alt+Escape");
    expect(toNiriShortcut("H")).toBeNull();
    expect(toNiriShortcut("Ctrl+Shift")).toBeNull();
    expect(toNiriShortcut("Ctrl+NotAKey")).toBeNull();
  });

  it("builds a complete include fragment and removes the binding when disabled", () => {
    const bindings = buildNiriQuickAskBindings("Ctrl+Shift+Alt+H", ["/home/test/Hpp", "--quick-ask"]);
    expect(bindings).toContain("binds {");
    expect(bindings).toContain('Ctrl+Shift+Alt+H { spawn "/home/test/Hpp" "--quick-ask"; }');

    expect(buildNiriQuickAskBindings("", ["/home/test/Hpp", "--quick-ask"])).toContain("binds {\n}");
    expect(buildNiriQuickAskBindings("H", ["/home/test/Hpp", "--quick-ask"])).toBeNull();
  });
});


describe("niri quick ask config sync", () => {
  const directories: string[] = [];

  const makeConfig = (include: boolean) => {
    const home = mkdtempSync(join(tmpdir(), "hpp-niri-"));
    directories.push(home);
    const niriDir = join(home, "niri");
    mkdirSync(niriDir, { recursive: true });
    const configPath = join(niriDir, "config.kdl");
    writeFileSync(configPath, `${include ? 'include "hpp-quick-ask.kdl"\n' : ""}`, "utf8");
    vi.stubEnv("XDG_CONFIG_HOME", home);
    vi.stubEnv("NIRI_CONFIG", "");
    return { home, configPath, generatedPath: join(niriDir, "hpp-quick-ask.kdl") };
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("writes the current shortcut and reloads niri", () => {
    const { generatedPath } = makeConfig(true);
    expect(syncNiriQuickAsk("Ctrl+Shift+Alt+H")).toEqual({ ok: true });
    const generated = readFileSync(generatedPath, "utf8");
    expect(generated).toContain("Ctrl+Shift+Alt+H { spawn");
    expect(generated).toContain("--quick-ask");
    expect(execFileSyncMock).toHaveBeenCalledWith("niri", ["validate", "-c", expect.any(String)], expect.anything());
    expect(execFileSyncMock).toHaveBeenCalledWith("niri", ["msg", "action", "load-config-file"], expect.anything());
  });

  it("keeps a valid empty include when the shortcut is disabled", () => {
    const { generatedPath } = makeConfig(true);
    expect(syncNiriQuickAsk("")).toEqual({ ok: true });
    expect(readFileSync(generatedPath, "utf8")).toContain("binds {\n}");
  });

  it("refuses to write when the main config does not include the generated file", () => {
    makeConfig(false);
    const result = syncNiriQuickAsk("Ctrl+Shift+Alt+H");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("include");
  });
});
