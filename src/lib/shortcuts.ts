import { DEFAULT_GLOBAL_QUICK_ASK } from "../../shared/quick-ask";

export interface ShortcutConfig {
  sendKey: string;
  /** 系统级快捷键：应用在后台也能唤出快速输入框。空串表示禁用。 */
  globalQuickAsk: string;
  fileSearch: string;
  switchToFiles: string;
  prevModel: string;
  nextModel: string;
  previousMessage: string;
  nextMessage: string;
}

export const DEFAULT_SHORTCUTS: ShortcutConfig = {
  sendKey: "normal",
  globalQuickAsk: DEFAULT_GLOBAL_QUICK_ASK,
  fileSearch: "Ctrl+P",
  switchToFiles: "Ctrl+Shift+F",
  prevModel: "Ctrl+[",
  nextModel: "Ctrl+]",
  previousMessage: "Ctrl+Up",
  nextMessage: "Ctrl+Down",
};

export const SHORTCUTS_UPDATED_EVENT = "hpp-shortcuts-updated";

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

// sendKey 表示 Enter 承担哪种发送：normal = Enter 普通发送 / Ctrl+Enter 引导，guide = 对调。
// 旧配置里它是「哪个键发送」（"Enter" / "Ctrl+Enter"），读取时迁移。
export function normalizeSendKey(value: unknown): string {
  if (value === "Ctrl+Enter" || value === "guide") return "guide";
  return "normal";
}

export function normalizeShortcuts(value: unknown): ShortcutConfig {
  const shortcuts = asRecord(value);
  const result = { ...DEFAULT_SHORTCUTS };
  for (const key of Object.keys(DEFAULT_SHORTCUTS) as Array<keyof ShortcutConfig>) {
    if (key === "sendKey") continue;
    // 全局快捷键允许显式存空串（禁用）；其余项留空视为没配过，回退默认值。
    if (key === "globalQuickAsk") {
      if (typeof shortcuts[key] === "string") result[key] = shortcuts[key].trim();
      continue;
    }
    if (typeof shortcuts[key] === "string" && shortcuts[key].trim()) result[key] = shortcuts[key].trim();
  }
  result.sendKey = normalizeSendKey(shortcuts.sendKey);
  return result;
}

const normalizeKey = (key: string) => {
  const normalized = key.trim().toLowerCase();
  if (normalized === "arrowup") return "up";
  if (normalized === "arrowdown") return "down";
  if (normalized === "arrowleft") return "left";
  if (normalized === "arrowright") return "right";
  if (normalized === "escape") return "esc";
  if (normalized === " ") return "space";
  return normalized;
};

export function formatShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">) {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return "";
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Cmd");

  const key = normalizeKey(event.key);
  const labels: Record<string, string> = {
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    esc: "Esc",
    space: "Space",
    enter: "Enter",
    backspace: "Backspace",
    tab: "Tab",
  };
  parts.push(labels[key] || (key.length === 1 ? key.toUpperCase() : event.key));
  return parts.join("+");
}

export function matchShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  shortcut: string,
) {
  const parts = shortcut.split("+").map((part) => normalizeKey(part));
  const key = normalizeKey(event.key);
  return (
    parts.includes("ctrl") === event.ctrlKey &&
    parts.includes("shift") === event.shiftKey &&
    parts.includes("alt") === event.altKey &&
    parts.includes("cmd") === event.metaKey &&
    !["ctrl", "shift", "alt", "cmd"].includes(key) &&
    parts.includes(key)
  );
}
