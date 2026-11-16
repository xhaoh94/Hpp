import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock("child_process", () => ({ execFileSync: execFileSyncMock }));

import {
  buildHyprlandQuickAskBindings,
  buildSwayQuickAskBindings,
  parseShortcut,
  syncHyprlandQuickAsk,
  syncSwayQuickAsk,
} from "./compositor-quick-ask";

const COMMAND = ["/home/test/Hpp", "--quick-ask"];

describe("compositor shortcut parsing", () => {
  it("parses modifiers and keys for both compositors", () => {
    expect(parseShortcut("Ctrl+Shift+Alt+H")).toEqual({ modifiers: ["Ctrl", "Shift", "Alt"], key: "h" });
    expect(parseShortcut("Meta+Space")).toEqual({ modifiers: ["Super"], key: "Space" });
    expect(parseShortcut("Ctrl+Enter")).toEqual({ modifiers: ["Ctrl"], key: "Return" });
    expect(parseShortcut("H")).toBeNull();
    expect(parseShortcut("Ctrl+Shift")).toBeNull();
    expect(parseShortcut("Ctrl+NotAKey")).toBeNull();
  });

  it("builds Hyprland bind lines", () => {
    expect(buildHyprlandQuickAskBindings("Ctrl+Shift+Alt+H", COMMAND))
      .toContain("bind = CTRL SHIFT ALT, h, exec, /home/test/Hpp --quick-ask");
    expect(buildHyprlandQuickAskBindings("Meta+Space", COMMAND))
      .toContain("bind = SUPER, Space, exec, /home/test/Hpp --quick-ask");
    expect(buildHyprlandQuickAskBindings("", COMMAND)).not.toContain("bind =");
    expect(buildHyprlandQuickAskBindings("H", COMMAND)).toBeNull();
  });

  it("builds sway bindsym lines with Mod4 for Super", () => {
    expect(buildSwayQuickAskBindings("Ctrl+Shift+Alt+H", COMMAND))
      .toContain("bindsym Ctrl+Shift+Alt+h exec /home/test/Hpp --quick-ask");
    expect(buildSwayQuickAskBindings("Super+Return", COMMAND))
      .toContain("bindsym Mod4+Return exec /home/test/Hpp --quick-ask");
    expect(buildSwayQuickAskBindings("", COMMAND)).not.toContain("bindsym");
    expect(buildSwayQuickAskBindings("Ctrl+NotAKey", COMMAND)).toBeNull();
  });

  it("quotes command arguments that contain spaces", () => {
    expect(buildHyprlandQuickAskBindings("Ctrl+H", ["/path/with space/App", "--quick-ask"]))
      .toContain('exec, "/path/with space/App" --quick-ask');
  });
});

describe("Hyprland config sync", () => {
  const directories: string[] = [];

  const makeConfig = (withSource: boolean) => {
    const home = mkdtempSync(join(tmpdir(), "hpp-hypr-"));
    directories.push(home);
    const hyprDir = join(home, "hypr");
    mkdirSync(hyprDir, { recursive: true });
    const configPath = join(hyprDir, "hyprland.conf");
    writeFileSync(configPath, `${withSource ? `source = ${join(hyprDir, "hpp-quick-ask.conf")}\n` : ""}`, "utf8");
    vi.stubEnv("XDG_CONFIG_HOME", home);
    vi.stubEnv("HYPRLAND_CONFIG", "");
    return { configPath, generatedPath: join(hyprDir, "hpp-quick-ask.conf") };
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("writes the bind line and reloads via hyprctl", () => {
    const { generatedPath } = makeConfig(true);
    expect(syncHyprlandQuickAsk("Ctrl+Shift+Alt+H", COMMAND)).toEqual({ ok: true });
    expect(readFileSync(generatedPath, "utf8")).toContain("bind = CTRL SHIFT ALT, h, exec");
    expect(execFileSyncMock).toHaveBeenCalledWith("hyprctl", ["reload"], expect.anything());
  });

  it("keeps an empty fragment when the shortcut is disabled", () => {
    const { generatedPath } = makeConfig(true);
    expect(syncHyprlandQuickAsk("", COMMAND)).toEqual({ ok: true });
    expect(readFileSync(generatedPath, "utf8")).not.toContain("bind =");
  });

  it("refuses to write when the main config has no source line", () => {
    makeConfig(false);
    const result = syncHyprlandQuickAsk("Ctrl+Shift+Alt+H", COMMAND);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("source");
  });
});

describe("sway config sync", () => {
  const directories: string[] = [];

  const makeConfig = (withInclude: boolean) => {
    const home = mkdtempSync(join(tmpdir(), "hpp-sway-"));
    directories.push(home);
    const swayDir = join(home, "sway");
    mkdirSync(swayDir, { recursive: true });
    const configPath = join(swayDir, "config");
    writeFileSync(configPath, `${withInclude ? `include ${join(swayDir, "hpp-quick-ask.conf")}\n` : ""}`, "utf8");
    vi.stubEnv("XDG_CONFIG_HOME", home);
    vi.stubEnv("SWAY_CONFIG", "");
    return { configPath, generatedPath: join(swayDir, "hpp-quick-ask.conf") };
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("writes the bindsym line and reloads via swaymsg", () => {
    const { generatedPath } = makeConfig(true);
    expect(syncSwayQuickAsk("Ctrl+Shift+Alt+H", COMMAND)).toEqual({ ok: true });
    expect(readFileSync(generatedPath, "utf8")).toContain("bindsym Ctrl+Shift+Alt+h exec");
    expect(execFileSyncMock).toHaveBeenCalledWith("swaymsg", ["reload"], expect.anything());
  });

  it("refuses to write when the main config has no include line", () => {
    makeConfig(false);
    const result = syncSwayQuickAsk("Ctrl+Shift+Alt+H", COMMAND);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("include");
  });
});
