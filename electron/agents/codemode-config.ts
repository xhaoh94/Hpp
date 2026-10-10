import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { AgentCodemodeConfig } from "../../src/types/ipc";
import { resolvePiAgentDir } from "./mcp-config";
import { queueNamedWrite } from "../utils/write-queue";

/**
 * codemode 扩展的配置读写。
 *
 * 与 MCP 配置分开存：`mcp.json` 放 server 列表，而 codemode 的两个字段属于
 * pi 自己的 settings（`~/.pi/agent/settings.json` 的 `codemode` 对象）。
 * 扩展侧读的就是它 —— `extensions/codemode/index.js` 的 `readMode`/`readInlineBudget`
 * 走 `pi.getSettings().codemode?.mode` 与 `.inlineBudget`。
 *
 * 注意这个文件和 Hpp 自己的 `hpp-data/settings.json` **不是同一个**
 * （那里存 agentBuiltinExtensions），别混。
 */
const SETTINGS_FILE = "settings.json";

/** pi 的默认值（`extensions/codemode/tool.js:72`）。 */
const DEFAULT_INLINE_BUDGET = 3000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function getPiSettingsPath(agentDir?: string): string {
  return join(resolvePiAgentDir(agentDir), SETTINGS_FILE);
}

function normalizeCodemodeConfig(raw: unknown): AgentCodemodeConfig {
  const source = isRecord(raw) ? raw : {};
  const mode = source.mode === "only" ? "only" : "on";
  // 负数/非数都没意义，回退到默认而不是接受 —— inlineBudget 是 token 预算。
  const budget = typeof source.inlineBudget === "number" && Number.isFinite(source.inlineBudget) && source.inlineBudget >= 0
    ? source.inlineBudget
    : DEFAULT_INLINE_BUDGET;
  return { mode, inlineBudget: budget };
}

export async function readCodemodeConfig(agentDir?: string): Promise<{
  config: AgentCodemodeConfig;
  filePath: string;
  exists: boolean;
  /** 读到的原始 codemode 字段；undefined 表示 settings.json 里没写过。 */
  stored: boolean;
}> {
  const filePath = getPiSettingsPath(agentDir);
  if (!existsSync(filePath)) {
    return { config: normalizeCodemodeConfig(undefined), filePath, exists: false, stored: false };
  }
  const parsed: unknown = JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  const settings = isRecord(parsed) ? parsed : {};
  return {
    config: normalizeCodemodeConfig(settings.codemode),
    filePath,
    exists: true,
    stored: settings.codemode !== undefined,
  };
}

export async function writeCodemodeConfig(
  config: AgentCodemodeConfig,
  agentDir?: string,
): Promise<AgentCodemodeConfig> {
  const filePath = getPiSettingsPath(agentDir);
  return queueNamedWrite(`pi-settings:${filePath}`, async () => {
    // 读-改-写：只碰 codemode 这一个键，settings.json 里的其他内容原样保留
    // （里面有 models / auth 等，绝不能整体覆盖）。
    let settings: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      const parsed: unknown = JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
      if (isRecord(parsed)) settings = parsed;
    }
    const next = normalizeCodemodeConfig(config);
    settings.codemode = { mode: next.mode, inlineBudget: next.inlineBudget };
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return next;
  });
}

export { DEFAULT_INLINE_BUDGET };
