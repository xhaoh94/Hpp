import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { app } from "electron";

import type { QuickAskRegisterResult } from "../shared/quick-ask";

const GENERATED_FILENAME = "hpp-quick-ask.kdl";

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
  mod: "Mod",
};

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

/** Hpp 的显示快捷键（Ctrl+Shift+Alt+H）→ niri keybind 语法。 */
export function toNiriShortcut(shortcut: string): string | null {
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
    || (/^[a-z]$/i.test(rawKey) ? rawKey.toUpperCase() : /^f\d{1,2}$/i.test(rawKey) ? rawKey.toUpperCase() : null);
  if (!key) return null;

  // 固定顺序，避免同一个快捷键因为录入顺序不同而反复重写配置。
  const ordered = ["Ctrl", "Shift", "Alt", "Super", "Mod"].filter((modifier) => modifiers.includes(modifier));
  return [...ordered, key].join("+");
}

const quoteKdl = (value: string) => JSON.stringify(value);

/** 生成被主配置 include 的片段；空快捷键也保留空 binds，避免 include 指向不存在的文件。 */
export function buildNiriQuickAskBindings(shortcut: string, command: string[]): string | null {
  const header = "// 由 Hpp 根据设置里的「全局唤起」自动生成，请勿手动编辑。\n";
  const trimmed = shortcut.trim();
  if (!trimmed) return `${header}binds {\n}\n`;
  const niriShortcut = toNiriShortcut(trimmed);
  if (!niriShortcut) return null;
  const invocation = command.map(quoteKdl).join(" ");
  return `${header}binds {\n    ${niriShortcut} { spawn ${invocation}; }\n}\n`;
}

export function resolveNiriConfigPath(): string {
  const explicit = process.env.NIRI_CONFIG?.trim();
  if (explicit) return resolve(explicit);
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "niri", "config.kdl");
}

function resolveQuickAskCommand(): string[] {
  const appImage = process.env.APPIMAGE?.trim();
  if (appImage) return [appImage, "--quick-ask"];
  if (app.isPackaged) return [process.execPath, "--quick-ask"];
  return [process.execPath, app.getAppPath(), "--quick-ask"];
}

function writeAtomic(filePath: string, content: string) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, "utf8");
  try {
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function validateNiriConfig(configPath: string) {
  execFileSync("niri", ["validate", "-c", configPath], {
    encoding: "utf8",
    timeout: 5000,
    stdio: "pipe",
  });
}

function reloadNiriConfig() {
  execFileSync("niri", ["msg", "action", "load-config-file"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: "pipe",
  });
}

/**
 * niri 没有全局快捷键协议，Hpp 注册不了系统热键。
 * 这里把设置里的组合键写进主配置 include 的生成文件，再让 niri 重载配置。
 */
export function syncNiriQuickAsk(shortcut: string): QuickAskRegisterResult {
  const configPath = resolveNiriConfigPath();
  if (!existsSync(configPath)) {
    return { ok: false, error: `找不到 niri 配置：${configPath}` };
  }

  const generatedPath = join(dirname(configPath), GENERATED_FILENAME);
  const mainConfig = readFileSync(configPath, "utf8");
  if (!new RegExp(`^\\s*include\\s+["']${GENERATED_FILENAME.replace(/\./g, "\\.")}["']`, "m").test(mainConfig)) {
    return {
      ok: false,
      error: `niri 配置缺少 include "${GENERATED_FILENAME}"，请在 ${configPath} 中加入这一行。`,
    };
  }

  const content = buildNiriQuickAskBindings(shortcut, resolveQuickAskCommand());
  if (content === null) {
    return { ok: false, error: "快捷键格式无效，需要至少一个修饰键加一个按键。" };
  }

  const previous = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : null;
  if (previous === content) return { ok: true };

  try {
    mkdirSync(dirname(generatedPath), { recursive: true });
    writeAtomic(generatedPath, content);
    validateNiriConfig(configPath);
  } catch (error) {
    // 不要留下指向不存在文件的 include：生成失败时至少保留一个合法的空 binds。
    writeAtomic(generatedPath, previous ?? "binds {\n}\n");
    return { ok: false, error: `写入 niri 配置失败：${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    reloadNiriConfig();
  } catch (error) {
    return {
      ok: false,
      error: `已写入配置，但 niri 重载失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true };
}
