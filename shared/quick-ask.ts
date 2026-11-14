/** 全局快速输入的跨进程契约。 */

/** 默认组合；主进程读不到配置时也用它，避免和设置页的默认值各写一份。 */
export const DEFAULT_GLOBAL_QUICK_ASK = "Ctrl+Shift+Space";

export interface QuickAskTarget {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  projectName: string;
}

export interface QuickAskSubmitPayload {
  sessionId: string;
  content: string;
  clientMessageId: string;
}

export interface QuickAskRegisterResult {
  ok: boolean;
  error?: string;
}

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: "CommandOrControl",
  control: "CommandOrControl",
  cmd: "Command",
  command: "Command",
  meta: "Command",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  super: "Super",
};

const KEY_ALIASES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  space: "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/**
 * 把界面上的显示串（Ctrl+Shift+Space）转成 Electron accelerator。
 *
 * 全局快捷键必须带修饰键：单键注册会把整个系统的该按键吞掉。
 */
export function toElectronAccelerator(shortcut: string): string | null {
  const parts = shortcut.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((part) => MODIFIER_ALIASES[part.toLowerCase()]);
  if (modifiers.some((modifier) => !modifier)) return null;
  const normalizedKey = KEY_ALIASES[key.toLowerCase()]
    || (key.length === 1 ? key.toUpperCase() : /^f\d{1,2}$/i.test(key) ? key.toUpperCase() : null);
  if (!normalizedKey) return null;
  return [...modifiers, normalizedKey].join("+");
}

type ProjectLike = {
  id?: unknown;
  name?: unknown;
  sessions?: Array<{ id?: unknown; title?: unknown; lastActiveAt?: unknown; closed?: unknown }>;
};

const asString = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** 优先取上次选中的会话；没有就取最近活跃的未关闭会话。 */
export function pickQuickAskTarget(payload: unknown): QuickAskTarget | null {
  const data = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as { projects?: unknown; activeSessionId?: unknown }
    : {};
  const projects = Array.isArray(data.projects) ? data.projects as ProjectLike[] : [];
  const activeSessionId = asString(data.activeSessionId);

  const candidates = projects.flatMap((project) => {
    const projectId = asString(project.id);
    const projectName = asString(project.name);
    if (!projectId) return [];
    return (Array.isArray(project.sessions) ? project.sessions : []).flatMap((session) => {
      const sessionId = asString(session.id);
      if (!sessionId || session.closed === true) return [];
      return [{
        sessionId,
        sessionTitle: asString(session.title) || "未命名会话",
        projectId,
        projectName,
        lastActiveAt: asString(session.lastActiveAt),
      }];
    });
  });
  if (candidates.length === 0) return null;

  const active = activeSessionId ? candidates.find((item) => item.sessionId === activeSessionId) : undefined;
  if (active) return active;
  const [latest] = candidates.sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
  return latest;
}
