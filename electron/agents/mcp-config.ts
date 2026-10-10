import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { McpConfigScope, McpConfigSnapshot, McpServerConfig } from "../../src/types/ipc";
import { readMcpServerEntries, validateMcpServers } from "../../shared/agent-mcp-config";
import { getErrorMessage, isRecord } from "../utils/unknown-value";
import { queueNamedWrite } from "../utils/write-queue";

/**
 * MCP 配置文件（`mcp.json`）的宿主侧读写。
 *
 * 与 pi 的关系：pi 只从磁盘读，自己不写（除 `/mcp` 那条交互命令），
 * 且 `loadMcpConfig` / `addMcpServerConfig` 等 API **包根未导出**（1.1.0 实测）。
 * 所以宿主自己按 pi 的格式读写，校验规则照抄 `validateMcpServerConfig`，
 * 保证「界面能存的」一定等于「pi 能加载的」。
 *
 * 路径与 pi 一致（`dist/extensions/mcp/config.js:105`）：
 * - global：`<agentDir>/mcp.json`
 * - project：`<projectPath>/.pi/mcp.json`
 */
const PROJECT_CONFIG_DIR = ".pi";
const MCP_CONFIG_FILE = "mcp.json";

export interface McpConfigAgentContext {
  /** pi 的 agentDir，通常是 `~/.pi/agent`。 */
  agentDir: string;
}

const isRecordValue = isRecord;

/**
 * 把 agentDir 的取值归一成 pi 实际使用的路径。
 *
 * **必须照抄 SDK 的 `normalizePath`**（`dist/utils/paths.js`）：`getAgentDir()` 会先过
 * 它再 join `mcp.json` / `settings.json`。少做一步就是「配置写在 A、Pi 读 B」——
 * 例如 `~/pi-agent` 在这边是字面量、在 pi 那边展开成家目录。
 *
 * 三种要处理的形态：`~` / `~\`、Git Bash/MSYS/Cygwin/WSL 的盘符路径、`file://` URL。
 * 与 pi 的唯一差异是这里对空串/纯空白按未设置处理（pi 会原样拿去 join），因为空值
 * 会退化成相对路径，比回退默认目录危险得多。
 */
export function normalizePiAgentPath(input: string): string {
  let value = input.trim();
  if (process.platform === "win32" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
    const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value);
    if (match) value = `${match[1].toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}`;
  }
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(homedir(), value.slice(2));
  }
  if (/^file:\/\//.test(value)) return fileURLToPath(value);
  return value;
}

/**
 * 解析 pi 的 agentDir。
 *
 * **必须和 SDK 的口径一致**，否则会出现「配置写在A、Pi 读B」：
 * SDK 用 `ENV_AGENT_DIR`（即 `PI_CODING_AGENT_DIR`，见 `dist/config.js:476`）决定
 * agentDir，宿主必须先读它再回退默认值。仓库里 `subagent-extension.mjs` 已经这么做了。
 * 不猜 `PI_SDK_PACKAGE_ROOT` —— 那个是包位置不是配置目录。
 */
export function resolvePiAgentDir(explicitAgentDir?: string): string {
  const explicit = normalizePiAgentPath(String(explicitAgentDir || ""));
  if (explicit) return explicit;
  const fromEnv = normalizePiAgentPath(String(process.env.PI_CODING_AGENT_DIR || ""));
  if (fromEnv) return fromEnv;
  // 用 os.homedir() 而不是 process.env.USERPROFILE：Node 自己会兜底
  // （没设 HOME/USERPROFILE 时回落到系统账户目录），与 subagent-extension.mjs 同口径。
  return join(homedir(), ".pi", "agent");
}

export function getMcpConfigFilePath(
  scope: McpConfigScope,
  context: McpConfigAgentContext,
  projectPath?: string,
): string {
  if (scope === "global") return join(context.agentDir, MCP_CONFIG_FILE);
  const base = String(projectPath || "").trim();
  if (!base) throw new Error("编辑项目级 MCP 配置需要指定项目路径。");
  return join(base, PROJECT_CONFIG_DIR, MCP_CONFIG_FILE);
}

async function readJsonFile(filePath: string): Promise<{ parsed: unknown; exists: boolean }> {
  if (!existsSync(filePath)) return { parsed: undefined, exists: false };
  const text = await readFile(filePath, "utf8");
  if (!text.trim()) return { parsed: undefined, exists: true };
  return { parsed: JSON.parse(text), exists: true };
}

/** 全局作用域的 server 名列表 —— 项目级覆盖条目要靠它判断是否「有基可覆盖」。 */
async function readGlobalServerNames(context: McpConfigAgentContext): Promise<string[]> {
  try {
    const { parsed, exists } = await readJsonFile(getMcpConfigFilePath("global", context));
    if (!exists || !isRecordValue(parsed) || !isRecordValue(parsed.mcpServers)) return [];
    return Object.keys(parsed.mcpServers);
  } catch {
    // 全局文件本身坏了不该让项目级完全不可读；读不到名字就当没有，
    // 覆盖条目会被标成 overrideMissing，与 pi 的行为一致（它也读不出就会报错）。
    return [];
  }
}

export async function readMcpConfigSnapshot(
  scope: McpConfigScope,
  context: McpConfigAgentContext,
  projectPath?: string,
): Promise<McpConfigSnapshot> {
  const filePath = getMcpConfigFilePath(scope, context, projectPath);
  const globalNames = scope === "project" ? await readGlobalServerNames(context) : [];
  const { parsed, exists } = await readJsonFile(filePath);
  return {
    scope,
    filePath,
    exists,
    servers: readMcpServerEntries(parsed, scope, globalNames),
    ...(isRecordValue(parsed) && typeof parsed.autoEnableCodemode === "boolean"
      ? { autoEnableCodemode: parsed.autoEnableCodemode }
      : {}),
    // 项目级条目里「无基可覆盖」的情况已经标到条目上的 overrideMissing 了，
    // 让校验器别在 errors 里重复报同一件事。
    errors: validateMcpServers(parsed, scope, globalNames, { reportOverrideMissing: false }),
    ...(scope === "project" ? { projectPath } : {}),
  };
}

export interface McpConfigWrite {
  scope: McpConfigScope;
  servers: Record<string, McpServerConfig>;
  autoEnableCodemode?: boolean;
  projectPath?: string;
}

/**
 * 写入 mcp.json。**先校验再落盘** —— pi 读文件时会把 error 收进 `loadMcpConfig().errors`，
 * 写坏了不会立刻报错，只会让对应 server 静默消失。所以宁可拒绝写。
 */
export async function writeMcpConfig(
  input: McpConfigWrite,
  context: McpConfigAgentContext,
): Promise<{ filePath: string; snapshot: McpConfigSnapshot }> {
  const filePath = getMcpConfigFilePath(input.scope, context, input.projectPath);
  return queueNamedWrite(`mcp:${filePath}`, async () => {
  const globalNames = input.scope === "project" ? await readGlobalServerNames(context) : [];
  // 读-改-写：只覆盖 mcpServers（以及显式传入的 autoEnableCodemode），其余顶层键原样保留。
  // `autoEnableCodemode` 在 pi 里是「项目级覆盖全局」（`extensions/mcp/config.js` 的
  // readConfigFile 两个文件都读、项目后读后赢），整体重建会把它从项目文件里静默删掉。
  let existing: { parsed: unknown; exists: boolean };
  try {
    existing = await readJsonFile(filePath);
  } catch (error) {
    // 坏文件不静默覆盖：pi 会把它记进 loadMcpConfig().errors 然后忽略整份配置，
    // 这时候再往上写只会把用户剩下的内容也一起弄没。
    throw new Error(`现有 ${filePath} 不是合法 JSON（${getErrorMessage(error)}），先手工修复再保存。`);
  }
  const base = isRecordValue(existing.parsed) ? existing.parsed : {};
  const next: Record<string, unknown> = { ...base, mcpServers: input.servers };
  if (typeof input.autoEnableCodemode === "boolean") {
    next.autoEnableCodemode = input.autoEnableCodemode;
  }
  const errors = validateMcpServers(next, input.scope, globalNames);
  if (errors.length > 0) {
    throw new Error(`配置校验未通过：${errors[0]}`);
  }
  // 与 pi 的写法保持一致：2 空格缩进、末尾换行，便于用户手工 diff。
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  const snapshot = await readMcpConfigSnapshot(input.scope, context, input.projectPath);
  return { filePath, snapshot };
  });
}
