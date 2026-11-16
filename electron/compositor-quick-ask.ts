import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

const GENERATED_FILENAME = "hpp-quick-ask.conf";

/**
 * 两个纯文本配置的 Wayland 合成器共用这里的同步逻辑：
 * - Hyprland：bind 行写进 `source` 的片段，`hyprctl reload` 热重载。
 * - sway：bindsym 行写进 `include` 的片段，`swaymsg reload` 热重载。
 * 两者都没有离线校验命令，只能写完再重载；重载失败时配置已落盘，不回滚。
 */

const MODIFIER_NAMES: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  meta: "Super",
  super: "Super",
  win: "Super",
  cmd: "Super",
  command: "Super",
};

// 修饰键与按键都按各自合成器的惯例输出，避免大小写引发的隐式 Shift。
const COMPOSITOR_MODIFIERS = {
  hyprland: { Ctrl: "CTRL", Shift: "SHIFT", Alt: "ALT", Super: "SUPER" },
  sway: { Ctrl: "Ctrl", Shift: "Shift", Alt: "Alt", Super: "Mod4" },
} as const;

const KEY_NAMES: Record<string, string> = {
  space: "Space",
  esc: "Escape",
  escape: "Escape",
  enter: "Return",
  return: "Return",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

export interface ParsedShortcut {
  modifiers: string[];
  key: string;
}

/** Hpp 的显示快捷键（Ctrl+Shift+Alt+H）→ 修饰键 + xkb 按键名；字母一律小写。 */
export function parseShortcut(shortcut: string): ParsedShortcut | null {
  const parts = shortcut.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_NAMES[part.toLowerCase()];
    if (!modifier) return null;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  if (modifiers.length === 0) return null;

  const rawKey = parts[parts.length - 1];
  const key = KEY_NAMES[rawKey.toLowerCase()]
    || (/^[a-z]$/i.test(rawKey) ? rawKey.toLowerCase() : /^f\d{1,2}$/i.test(rawKey) ? rawKey.toUpperCase() : null);
  if (!key) return null;

  // 固定顺序，同一个快捷键无论录入顺序如何都生成同一份配置。
  const ordered = ["Ctrl", "Shift", "Alt", "Super"].filter((modifier) => modifiers.includes(modifier));
  return { modifiers: ordered, key };
}

const quoteCommand = (value: string) => JSON.stringify(value);

/** 含空格或引号的参数按整体一个参数传给 exec，其余原样拼接。 */
const formatCommand = (command: string[]) =>
  command.map((arg) => (/\s|["']/.test(arg) ? quoteCommand(arg) : arg)).join(" ");

/** 生成 Hyprland 的 bind 行；空快捷键返回空 binds 片段，保证 source 指向的文件始终存在。 */
export function buildHyprlandQuickAskBindings(shortcut: string, command: string[]): string | null {
  const header = "# 由 Hpp 根据设置里的「全局唤起」自动生成，请勿手动编辑。\n";
  const trimmed = shortcut.trim();
  if (!trimmed) return `${header}\n`;
  const parsed = parseShortcut(trimmed);
  if (!parsed) return null;
  const mods = parsed.modifiers.map((modifier) => COMPOSITOR_MODIFIERS.hyprland[modifier as keyof typeof COMPOSITOR_MODIFIERS.hyprland]).join(" ");
  return `${header}bind = ${mods}, ${parsed.key}, exec, ${formatCommand(command)}\n`;
}

/** 生成 sway 的 bindsym 行；空快捷键返回空片段，保证 include 指向的文件始终存在。 */
export function buildSwayQuickAskBindings(shortcut: string, command: string[]): string | null {
  const header = "# 由 Hpp 根据设置里的「全局唤起」自动生成，请勿手动编辑。\n";
  const trimmed = shortcut.trim();
  if (!trimmed) return `${header}\n`;
  const parsed = parseShortcut(trimmed);
  if (!parsed) return null;
  const mods = parsed.modifiers.map((modifier) => COMPOSITOR_MODIFIERS.sway[modifier as keyof typeof COMPOSITOR_MODIFIERS.sway]);
  return `${header}bindsym ${[...mods, parsed.key].join("+")} exec ${formatCommand(command)}\n`;
}

const resolveGeneratedPath = (configDirEnv: string | undefined, subdirectory: string): string => {
  const explicit = configDirEnv?.trim();
  if (explicit) return join(resolve(explicit), GENERATED_FILENAME);
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, subdirectory, GENERATED_FILENAME);
};

function writeAtomic(filePath: string, content: string) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, filePath);
}

/** 检查主配置里有没有挂上生成片段；没有就直接报错，绝不悄悄写一个不会被读取的文件。 */
const requireReference = (configPath: string, pattern: RegExp, instruction: string): string | null => {
  if (!existsSync(configPath)) return `找不到合成器配置：${configPath}`;
  const mainConfig = readFileSync(configPath, "utf8");
  if (!pattern.test(mainConfig)) return instruction;
  return null;
};

function writeAndReload(
  generatedPath: string,
  content: string,
  reload: () => void,
  reloadLabel: string,
): { ok: boolean; error?: string } {
  const previous = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : null;
  if (previous === content) return { ok: true };
  try {
    mkdirSync(dirname(generatedPath), { recursive: true });
    writeAtomic(generatedPath, content);
  } catch (error) {
    return { ok: false, error: `写入配置失败：${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    reload();
  } catch (error) {
    return {
      ok: false,
      error: `已写入配置，但${reloadLabel}失败：${error instanceof Error ? error.message : String(error)}。重启合成器后生效。`,
    };
  }
  return { ok: true };
}

export function resolveHyprlandMainConfigPath(): string {
  const explicit = process.env.HYPRLAND_CONFIG?.trim();
  if (explicit) return resolve(explicit);
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "hypr", "hyprland.conf");
}

export function resolveSwayMainConfigPath(): string {
  const explicit = process.env.SWAY_CONFIG?.trim();
  if (explicit) return resolve(explicit);
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "sway", "config");
}

export function syncHyprlandQuickAsk(shortcut: string, command: string[]): { ok: boolean; error?: string } {
  const configPath = resolveHyprlandMainConfigPath();
  const referenceError = requireReference(
    configPath,
    /^\s*source\s*=.*hpp-quick-ask\.conf\s*$/m,
    `Hyprland 配置缺少 source 行，请在 ${configPath} 中加入：\nsource = ${join(dirname(configPath), GENERATED_FILENAME)}`,
  );
  if (referenceError) return { ok: false, error: referenceError };

  const content = buildHyprlandQuickAskBindings(shortcut, command);
  if (content === null) return { ok: false, error: "快捷键格式无效，需要至少一个修饰键加一个按键。" };
  return writeAndReload(
    join(dirname(configPath), GENERATED_FILENAME),
    content,
    () => execFileSync("hyprctl", ["reload"], { encoding: "utf8", timeout: 5000, stdio: "pipe" }),
    "hyprctl reload",
  );
}

export function syncSwayQuickAsk(shortcut: string, command: string[]): { ok: boolean; error?: string } {
  const configPath = resolveSwayMainConfigPath();
  const referenceError = requireReference(
    configPath,
    /^\s*include\s+.*hpp-quick-ask\.conf\s*$/m,
    `sway 配置缺少 include 行，请在 ${configPath} 中加入：\ninclude ${join(dirname(configPath), GENERATED_FILENAME)}`,
  );
  if (referenceError) return { ok: false, error: referenceError };

  const content = buildSwayQuickAskBindings(shortcut, command);
  if (content === null) return { ok: false, error: "快捷键格式无效，需要至少一个修饰键加一个按键。" };
  return writeAndReload(
    join(dirname(configPath), GENERATED_FILENAME),
    content,
    () => execFileSync("swaymsg", ["reload"], { encoding: "utf8", timeout: 5000, stdio: "pipe" }),
    "swaymsg reload",
  );
}
