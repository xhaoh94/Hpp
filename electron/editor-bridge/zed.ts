import { app } from "electron";
import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import type { EditorBridgeZedResult } from "../../shared/editor-bridge-protocol";
import { parseJsonc } from "../utils/jsonc";

const TASK_LABELS = ["Hpp: 发送选中代码", "Hpp: 发送当前文件"] as const;
const HPP_TASK_PREFIX = "Hpp: ";

export function resolveZedConfigDir(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Zed");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "zed");
}

export function getZedTasksPath() {
  return join(resolveZedConfigDir(), "tasks.json");
}

export function getZedKeymapPath() {
  return join(resolveZedConfigDir(), "keymap.json");
}

function zedExecutableCandidates(): string[] {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return [
      join(local, "Programs", "Zed", "zed.exe"),
      join(process.env.ProgramFiles || "C:\\Program Files", "Zed", "zed.exe"),
    ];
  }
  if (process.platform === "darwin") return ["/Applications/Zed.app"];
  return ["/usr/bin/zed", "/usr/local/bin/zed", join(homedir(), ".local", "bin", "zed")];
}

export function isZedInstalled(): boolean {
  return existsSync(resolveZedConfigDir()) || zedExecutableCandidates().some((candidate) => existsSync(candidate));
}

export function isZedConfigured(): boolean {
  const tasksPath = getZedTasksPath();
  if (!existsSync(tasksPath)) return false;
  try {
    const tasks = parseJsonc(readFileSync(tasksPath, "utf8"));
    return Array.isArray(tasks)
      && tasks.some((task) => typeof (task as { label?: unknown })?.label === "string"
        && ((task as { label: string }).label.startsWith(HPP_TASK_PREFIX)));
  } catch {
    return false;
  }
}

const quote = (value: string) => `"${value}"`;

function buildTasks() {
  // ELECTRON_RUN_AS_NODE 让 Hpp 自己的可执行文件当 node 用，用户不必装 Node。
  const runner = `${quote(process.execPath)} ${quote(join(app.getAppPath(), "bin", "hpp-send.cjs"))}`;
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  return [
    {
      label: TASK_LABELS[0],
      command: `${runner} --client zed --file "$ZED_FILE" --start "$ZED_ROW" --end "$ZED_ROW" --text-env ZED_SELECTED_TEXT --language "$ZED_LANGUAGE"`,
      env,
      reveal: "never",
      hide: "always",
    },
    {
      label: TASK_LABELS[1],
      command: `${runner} --client zed --file "$ZED_FILE" --language "$ZED_LANGUAGE"`,
      env,
      reveal: "never",
      hide: "always",
    },
  ];
}

function buildKeymap() {
  const key = process.platform === "darwin" ? "cmd-alt-h" : "ctrl-alt-h";
  return [{
    context: "Editor",
    bindings: { [key]: ["task::Spawn", { task_name: TASK_LABELS[0] }] },
  }];
}

export async function installZedTasks(): Promise<EditorBridgeZedResult> {
  const tasksPath = getZedTasksPath();
  const keymapPath = getZedKeymapPath();
  const cliPath = join(app.getAppPath(), "bin", "hpp-send.cjs");
  if (!existsSync(cliPath)) {
    return { success: false, error: "安装目录里缺少 bin/hpp-send.cjs，请重新安装 Hpp。" };
  }

  let existing: unknown[] = [];
  if (existsSync(tasksPath)) {
    let parsed: unknown;
    try {
      parsed = parseJsonc(await readFile(tasksPath, "utf8"));
    } catch (error) {
      return {
        success: false,
        error: `Zed 的 tasks.json 解析失败，没有改动：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!Array.isArray(parsed)) {
      return { success: false, error: "Zed 的 tasks.json 不是数组，没有改动。" };
    }
    existing = parsed;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(tasksPath, `${tasksPath}.bak-${stamp}`);
  }

  const preserved = existing.filter((task) => {
    const label = (task as { label?: unknown })?.label;
    return !(typeof label === "string" && label.startsWith(HPP_TASK_PREFIX));
  });
  await mkdir(resolveZedConfigDir(), { recursive: true });
  await writeFile(tasksPath, `${JSON.stringify([...preserved, ...buildTasks()], null, 2)}\n`, "utf8");

  if (!existsSync(keymapPath)) {
    await writeFile(keymapPath, `${JSON.stringify(buildKeymap(), null, 2)}\n`, "utf8");
    return { success: true, tasksPath, keymapPath };
  }

  // 用户自己的 keymap 不动：改错了会连带影响其它键位，只把该加的那段回传。
  return {
    success: true,
    tasksPath,
    keymapSnippet: JSON.stringify(buildKeymap(), null, 2),
  };
}
