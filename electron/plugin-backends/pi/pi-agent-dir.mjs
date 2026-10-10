/**
 * agentDir 的解析与归一。
 *
 * 这里是 `electron/agents/mcp-config.ts` 里 TS 实现的副本 —— worker 侧的 .mjs 没法
 * import 主进程的 .ts。两份必须给出同样的结果：`pi-agent-dir.test.ts` 拿同一组输入
 * 对比两边，改了一份忘了另一份会直接红。
 *
 * 归一规则照抄 SDK 的 `normalizePath`（`dist/utils/paths.js`）：`getAgentDir()` 会先过
 * 它再 join 配置文件名。少做一步就是「配置写在 A、Pi 读 B」—— `~/pi-agent` 在这边当
 * 字面量、在 pi 那边是家目录。
 *
 * 唯一故意偏离 pi 的地方：空串/纯空白按未设置处理（pi 会原样拿去 join，空值会退化成
 * 相对路径，比回退默认目录危险得多）。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/** 展开 `~`、转 Git Bash/MSYS/Cygwin/WSL 盘符路径、解析 `file://`。 */
export const normalizePiAgentPath = (input) => {
  let value = String(input ?? "").trim();
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
};

/** 显式值 → 环境变量 → `~/.pi/agent`。 */
export const resolvePiAgentDir = (explicitAgentDir, env = process.env) => {
  const explicit = normalizePiAgentPath(explicitAgentDir);
  if (explicit) return explicit;
  const fromEnv = normalizePiAgentPath(env?.[ENV_AGENT_DIR]);
  if (fromEnv) return fromEnv;
  return join(homedir(), ".pi", "agent");
};
