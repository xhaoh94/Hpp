import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiAgentDir } from "./pi-agent-dir.mjs";
import { resolveSubagentCwd } from "./subagent-policy.mjs";
import {
  applySubagentWorktree,
  createSubagentWorktree,
  finalizeSubagentWorktree,
  removeSubagentWorktree,
} from "./subagent-worktree.mjs";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_CONFIGURABLE_CONCURRENCY = 8;
const MAX_BACKGROUND_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_BACKGROUND_TIMEOUT_MS = MAX_BACKGROUND_TIMEOUT_MS;
const MAX_TASK_OUTPUT_BYTES = 8 * 1024;
/** 监视窗里展示的实时输出片段：只要尾巴，不参与最终结果。 */
const MAX_LIVE_OUTPUT_BYTES = 4 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_MESSAGE_COUNT = 80;
/**
 * 同步子任务默认不设墙钟超时（0 = 不挂定时器）。
 *
 * 上游没有这条限制：Claude Code 官方文档里子 Agent 只有 maxTurns、并发数和
 * 嵌套深度，没有运行时长上限；Codex CLI 没有子 Agent 派生；Hpp 的 Agent 工具
 * 也只有 max_turns。原先的 30 分钟会在长审查 / 大迁移任务上从外部把子进程杀掉，
 * 结果变成「明明还在干活却判超时失败」。需要兜底时由调用方显式传 timeoutMs。
 */
const DEFAULT_TASK_TIMEOUT_MS = 0;
/**
 * 显式 timeoutMs 的上界只做溢出保护：Node 的 setTimeout 超过 2^31-1 会立刻触发，
 * 这个数字不表达任何产品限制。
 */
const MAX_TASK_TIMEOUT_MS = 2_147_483_647;
const MAX_JSON_TASK_BYTES = 24 * 1024;
// Pi 的 JSONL 里单条记录可能非常大：message_end 带完整正文/补丁、
// tool_execution_end 带整个文件内容，很容易超过几百 KB。上限只用于
// 防御「一直没有换行符的失控输出」，不能低到误杀合法事件。
const MAX_STDOUT_LINE_BYTES = 16 * 1024 * 1024;
/** 模型池上限：并行任务最多 8 个，池子再长也只是让模型挑花眼。 */
const MAX_MODEL_POOL_ENTRIES = 8;
const SUBAGENT_BRIDGE_EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "subagent-bridge-extension.mjs");
/** RPC 模式下会阻塞等待响应的对话框方法；其余（setStatus/setWidget/setTitle/…）是单向指令。 */
const RPC_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
/**
 * 子 Agent 只允许「权限确认」冒泡给宿主。
 *
 * 参考 Claude Code 的子 agent 设计：子 agent 的权限提示会透传给用户，但
 * AskUserQuestion 这类主动提问在子 agent 里不可用；Codex 的子 agent 同样只
 * 冒泡 approval。子任务跑在隔离上下文里，主动提问会打断主会话，而且并行
 * 多个子 agent 时宿主无法判断该由谁承担这次交互。
 */
const SUBAGENT_ALLOWED_DIALOG_METHODS = new Set(["confirm"]);

/** 只终止当前 SubAgent 拥有的进程组/进程树，不能影响 Hpp 或用户的其他 Node 进程。 */
const killSubagentTree = (child, signal = "SIGTERM") => {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 5000,
      });
      return;
    } catch {
      // 回退到直接终止；调用方仍会等待 hard deadline。
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 子进程未创建独立进程组或已经退出时回退到直接终止。
    }
  }
  try { child.kill(signal); } catch { /* ignore */ }
};
const PI_FFF_PACKAGE_NAME = "@ff-labs/pi-fff";
const PI_FFF_TOOL_NAMES = ["fffind", "ffgrep", "fff-multi-grep"];
const PI_FFF_SUBAGENT_NAMES = new Set(["scout", "planner", "reviewer"]);

/**
 * 能写文件的工具。只读 agent 的 worktree 隔离请求会被忽略，
 * 但 bash / powershell 都能重定向写文件，不能只算 edit/write，
 * 否则 reviewer（read,grep,find,ls,bash）请求隔离会被静默降级到主工作区。
 */
const WRITE_CAPABLE_TOOL_NAMES = new Set(["edit", "write", "bash", "powershell"]);

const DEFAULT_AGENTS = [
  {
    name: "scout",
    description: "快速检索代码库，定位相关文件、实现和风险，不修改文件。",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: "你是代码库侦察 Agent。优先使用文件发现工具，再读取必要文件。输出精确的文件路径、关键事实、相关符号和不确定性。不要修改文件。最终返回结构化、简洁的调查摘要。没找到目标时，列出搜过的位置和关键词，不要只回答“没有”。",
    source: "builtin",
  },
  {
    name: "planner",
    description: "基于代码库事实制定可执行的实施计划，不修改文件。",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: "你是实施规划 Agent。先检查相关代码和测试，再给出分步骤计划、文件范围、兼容性影响、测试方案和风险。不要修改文件。避免重复粘贴大段源码。没找到目标时，列出搜过的位置和关键词，不要只回答“没有”。",
    source: "builtin",
  },
  {
    name: "reviewer",
    description: "审查实现、边界条件和测试回归，返回问题清单。",
    tools: ["read", "grep", "find", "ls", "bash"],
    systemPrompt: "你是代码审查 Agent。重点检查正确性、边界状态、异步生命周期、错误处理、权限和测试覆盖。只在必要时运行只读检查命令。按严重程度返回问题、证据和建议。",
    source: "builtin",
  },
  {
    name: "worker",
    description: "在隔离上下文中完成一个明确的开发任务。",
    systemPrompt: "你是通用开发 Agent。先发现并读取相关文件，再以最小范围完成任务。保持现有行为和风格，运行有针对性的测试，并以结构化摘要说明修改、测试和剩余风险。",
    source: "builtin",
  },
];

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
export const normalizeTaskTimeout = (value) => {
  const parsed = Number(value);
  // 未填写 / 非正数 = 不设超时；只有显式传了正数才挂定时器。
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_TASK_TIMEOUT_MS, Math.max(1000, Math.floor(parsed)));
};

const truncateText = (value, maxBytes) => {
  const text = String(value || "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  const body = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - 80)).toString("utf8");
  return `${body}\n\n[输出已截断，省略 ${Math.max(0, bytes - Buffer.byteLength(body, "utf8"))} 字节]`;
};

const getTextFromContent = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!isRecord(part)) return "";
    if (part.type === "text" && typeof part.text === "string") return part.text;
    return typeof part.text === "string" ? part.text : "";
  }).filter(Boolean).join("");
};

const getMessageText = (message) => {
  if (!isRecord(message)) return "";
  return getTextFromContent(message.content) || nonEmptyString(message.text) || "";
};

const CHILD_TOOL_LABELS = {
  read: "读取文件",
  grep: "搜索内容",
  find: "查找文件",
  ls: "查看目录",
  bash: "执行命令",
  edit: "编辑文件",
  write: "写入文件",
  fffind: "查找文件",
  ffgrep: "搜索内容",
};

const getChildToolInput = (event) => {
  if (isRecord(event?.args)) return event.args;
  if (isRecord(event?.input)) return event.input;
  if (isRecord(event?.parameters)) return event.parameters;
  return {};
};

const getChildToolDetail = (event) => {
  const input = getChildToolInput(event);
  const value = input.command || input.path || input.filePath || input.file_path
    || input.pattern || input.query || input.task || input.prompt;
  if (typeof value === "string" && value.trim()) return truncateText(value.trim(), 180);
  return "";
};

const getChildToolActivity = (event, phase) => {
  const rawName = nonEmptyString(event?.toolName || event?.name || event?.tool) || "工具";
  const normalizedName = rawName.toLowerCase().replace(/[\s-]+/g, "_");
  const label = CHILD_TOOL_LABELS[normalizedName] || `使用 ${rawName}`;
  const detail = getChildToolDetail(event);
  if (phase === "start") return `正在${label}${detail ? `：${detail}` : ""}`;
  if (phase === "end") return `已完成${label}，正在分析结果…`;
  return `正在处理${label}${detail ? `：${detail}` : ""}…`;
};

const getMessageUpdateEvent = (event) => (
  isRecord(event?.assistantMessageEvent) ? event.assistantMessageEvent : event
);

const getFinalOutput = (result) => {
  const direct = nonEmptyString(result?.output);
  if (direct) return direct;
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      const text = getMessageText(message);
      if (text) return text;
    }
  }
  return "";
};

/**
 * 子 Agent 的结果文本。
 *
 * 关键：**不能按 exitCode 判断有没有出错**。pi 的 print 模式只在 `mode === "text"` 时把
 * 「最后一轮是 error/aborted」映射成 exit 1（`dist/modes/print-mode.js`，全文件唯一一处
 * `exitCode = 1`），而 Hpp 的子进程用的是 `--mode json` / `--mode rpc` —— 上游 503/overloaded
 * 时子进程照样退 0，错误只留在 message 的 errorMessage 里。只看 exitCode 就会把
 * 「Our servers are currently overloaded」显示成「子 Agent 未返回输出」。
 */
const getResultOutput = (result) => {
  const error = nonEmptyString(result?.errorMessage);
  if (result?.stopReason === "aborted") return error || "子 Agent 已中断";
  const failed = result?.stopReason === "error"
    || (typeof result?.exitCode === "number" && result.exitCode !== 0);
  if (failed) {
    const reason = error
      || nonEmptyString(result?.stderr)
      || (result?.stopReason === "error" ? "上游返回错误但未给出原因" : `子 Agent 进程异常退出（exit ${result?.exitCode}）`);
    const retried = Number(result?.retries) > 0 ? `（已自动重试 ${result.retries} 次）` : "";
    // 失败前可能已经吐出一部分内容，别丢 —— 但要挂在原因后面，原因才是可行动的信息。
    const partial = getFinalOutput(result);
    const detail = `${reason}${retried}`;
    return partial && partial !== reason ? `${detail}\n\n${partial}` : detail;
  }
  return getFinalOutput(result) || "子 Agent 未返回输出";
};

const isFailedResult = (result) =>
  result?.exitCode !== 0 || result?.stopReason === "error" || result?.stopReason === "aborted";

/**
 * 可重试的上游错误。关键词与 pi-ai 的 `RETRYABLE_PROVIDER_ERROR_PATTERN`
 * （`dist/utils/retry.js`）对齐：过载 / 限流 / 5xx / 连接层抖动。
 * 不含鉴权与配额类 —— 那是配置问题，重试只是白烧 token。
 */
const RETRYABLE_UPSTREAM_ERROR = /overloaded|server_?busy|servers are currently busy|currently experiencing high demand|model is at capacity|rate.?limit|too many requests|\b429\b|\b5\d\d\b|temporarily unavailable|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i;

/** 重试间隔（先短后长），实际等待再叠加 0~50% 抖动。 */
const SUBAGENT_RETRY_DELAYS_MS = [15_000, 45_000];

const isRetryableSubagentFailure = (result) => {
  if (!result || !isFailedResult(result)) return false;
  // 中断与超时跟上游无关，重试只会把等待再来一遍。
  if (result.stopReason === "aborted" || result.stopReason === "timeout") return false;
  const text = nonEmptyString(result.errorMessage) || nonEmptyString(result.stderr);
  return Boolean(text) && RETRYABLE_UPSTREAM_ERROR.test(text);
};

/**
 * 重试前的等待。返回 false 表示期间被中断，调用方应停止重试。
 *
 * 必须带抖动：并行跑的几个子进程会在同一时刻撞上限流，固定间隔会让它们同步重试、
 * 继续捶上游 —— 那正是 overloaded 迟迟不退的原因之一。
 */
const waitBeforeRetry = (attempt, signal, delays = SUBAGENT_RETRY_DELAYS_MS) => {
  const base = delays[Math.min(attempt, delays.length - 1)];
  const delay = base + Math.floor(Math.random() * base * 0.5);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer;
    const finish = (value) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(true), delay);
    signal?.addEventListener?.("abort", onAbort);
  });
};

const createUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
});

const parseScalar = (value) => {
  const text = String(value || "").trim();
  if (!text) return "";
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  return text;
};

const parseFrontmatter = (content) => {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: content };
  const frontmatter = {};
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value.slice(1, -1).split(",").map(parseScalar).filter((item) => item !== "");
    } else {
      frontmatter[key] = parseScalar(value);
    }
  }
  return { frontmatter, body: content.slice(end + "\n---".length).replace(/^\r?\n/, "") };
};

const parseToolList = (value) => {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = values.map((item) => String(item || "").trim()).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
};

const loadAgentsFromDir = (dir, source) => {
  if (!dir || !existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) return [];
    const filePath = join(dir, entry.name);
    try {
      const { frontmatter, body } = parseFrontmatter(readFileSync(filePath, "utf8"));
      const name = nonEmptyString(frontmatter.name);
      const description = nonEmptyString(frontmatter.description);
      if (!name || !description) return [];
      return [{
        name,
        description,
        tools: parseToolList(frontmatter.tools),
        model: nonEmptyString(frontmatter.model),
        systemPrompt: body,
        source,
        filePath,
      }];
    } catch {
      return [];
    }
  });
};

const findProjectAgentsDir = (cwd) => {
  let current = resolve(cwd || process.cwd());
  while (true) {
    const candidate = join(current, ".pi", "agents");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const discoverAgents = (cwd, agentDir, scope) => {
  const userAgentsDir = join(agentDir || join(homedir(), ".pi", "agent"), "agents");
  const projectAgentsDir = findProjectAgentsDir(cwd);
  const agentMap = new Map(DEFAULT_AGENTS.map((agent) => [agent.name, agent]));

  if (scope !== "project") {
    for (const agent of loadAgentsFromDir(userAgentsDir, "user")) agentMap.set(agent.name, agent);
  }
  if (scope !== "user" && projectAgentsDir) {
    for (const agent of loadAgentsFromDir(projectAgentsDir, "project")) agentMap.set(agent.name, agent);
  }

  return {
    agents: Array.from(agentMap.values()),
    projectAgentsDir,
  };
};

const getModelName = (model) => {
  if (!model) return undefined;
  if (typeof model === "string") return model;
  if (!isRecord(model)) return undefined;
  const provider = nonEmptyString(model.provider || model.providerID || model.providerId);
  const id = nonEmptyString(model.id || model.modelID || model.modelId || model.name);
  if (provider && id) return `${provider}/${id}`;
  return id || provider;
};

const OPTIONAL_SUBAGENT_PACKAGE_ADAPTERS = {
  // @ff-labs/pi-fff 当前尚未在 Pi manifest 中声明 subagent 工具元数据，
  // 因此只保留这一份兼容适配；其他包优先读取 manifest.pi.subagent。
  [PI_FFF_PACKAGE_NAME]: {
    profiles: [...PI_FFF_SUBAGENT_NAMES],
    tools: PI_FFF_TOOL_NAMES,
  },
};

const getNpmPackageName = (spec) => {
  const value = nonEmptyString(spec);
  if (!value || !value.startsWith("npm:")) return undefined;
  const packageSpec = value.slice(4);
  if (packageSpec.startsWith("@")) {
    const scopeSeparator = packageSpec.indexOf("/");
    const versionSeparator = packageSpec.indexOf("@", scopeSeparator + 1);
    return versionSeparator > 0 ? packageSpec.slice(0, versionSeparator) : packageSpec;
  }
  const versionSeparator = packageSpec.indexOf("@");
  return versionSeparator > 0 ? packageSpec.slice(0, versionSeparator) : packageSpec;
};

const getConfiguredPiPackageNames = (agentDir) => {
  const settingsPath = join(agentDir || "", "settings.json");
  if (!existsSync(settingsPath)) return new Set();
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    return new Set(
      Array.isArray(settings?.packages)
        ? settings.packages.map(getNpmPackageName).filter(Boolean)
        : [],
    );
  } catch {
    return new Set();
  }
};

const getInstalledPiPackageManifest = (agentDir, packageName) => {
  const packagePaths = [
    join(agentDir || "", "npm", "node_modules", ...packageName.split("/"), "package.json"),
    join(agentDir || "", "node_modules", ...packageName.split("/"), "package.json"),
  ];
  for (const packageJsonPath of packagePaths) {
    if (!existsSync(packageJsonPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (manifest?.name === packageName) return { manifest, packageDir: dirname(packageJsonPath) };
    } catch {
      // Ignore malformed or partially installed optional packages.
    }
  }
  return null;
};

const getManifestExtensionPaths = (packageInfo) => {
  if (!packageInfo) return [];
  const { manifest, packageDir } = packageInfo;
  const extensionEntries = Array.isArray(manifest?.pi?.extensions)
    ? manifest.pi.extensions
    : [];
  return extensionEntries.flatMap((entry) => {
    if (typeof entry !== "string" || !entry.trim()) return [];
    const extensionPath = resolve(packageDir, entry);
    const packageRelativePath = relative(packageDir, extensionPath);
    if (!packageRelativePath || packageRelativePath.startsWith("..") || isAbsolute(packageRelativePath)) return [];
    return existsSync(extensionPath) ? [extensionPath] : [];
  });
};

const getSubagentExtensionIntegration = (agentName, agentDir) => {
  const configuredPackages = getConfiguredPiPackageNames(agentDir);
  const integrations = [];
  for (const packageName of configuredPackages) {
    const packageInfo = getInstalledPiPackageManifest(agentDir, packageName);
    if (!packageInfo) continue;
    const manifestMetadata = isRecord(packageInfo.manifest?.pi?.subagent)
      ? packageInfo.manifest.pi.subagent
      : undefined;
    const adapter = OPTIONAL_SUBAGENT_PACKAGE_ADAPTERS[packageName];
    const profiles = Array.isArray(manifestMetadata?.profiles)
      ? manifestMetadata.profiles.filter((profile) => typeof profile === "string")
      : adapter?.profiles || [];
    if (!profiles.includes(agentName)) continue;
    const tools = Array.isArray(manifestMetadata?.tools)
      ? manifestMetadata.tools.filter((tool) => typeof tool === "string")
      : adapter?.tools || [];
    const extensionPaths = getManifestExtensionPaths(packageInfo);
    if (extensionPaths.length === 0) continue;
    integrations.push({ extensionPaths, tools });
  }
  return integrations;
};

/** 子 Agent 不允许向用户提问：这些工具即使写在 agent 的 tools 里也要剔除。 */
const SUBAGENT_QUESTION_TOOLS = new Set(["ask_user_question", "questionnaire", "question"]);
const SUBAGENT_QUESTION_TOOL_DENYLIST = [...SUBAGENT_QUESTION_TOOLS].join(",");

const getSubagentTools = (agent, integrations) => {
  const tools = Array.isArray(agent?.tools) ? [...agent.tools] : [];
  for (const integration of integrations) {
    for (const toolName of integration.tools) {
      if (!tools.includes(toolName)) tools.push(toolName);
    }
  }
  return tools.filter((toolName) => (
    !SUBAGENT_QUESTION_TOOLS.has(String(toolName || "").trim().toLowerCase().replace(/[\s-]+/g, "_"))
  ));
};

/**
 * 子 Agent 走预打包 CLI，而不是 dist/cli.js（模块树）。
 *
 * 模块树要靠 node_modules 解析 `@earendil-works/pi-ai`：旧版 SDK 曾用 shrinkwrap
 * 把它嵌在 pi-coding-agent/node_modules 下，升级后这份旧副本可能残留，新版代码
 * import 新文件就会 ERR_MODULE_NOT_FOUND —— 表现为「主会话正常、只有 subagent 挂」。
 * bundle/cli.js 只 import 同目录 chunks，完全绕开这个问题，启动也更快。
 */
const getPiInvocation = (packageRoot, args, nodePath) => {
  const packageDir = join(packageRoot || "", "node_modules", "@earendil-works", "pi-coding-agent");
  const bundleCli = join(packageDir, "dist", "bundle", "cli.js");
  const bundleRuntime = join(packageDir, "dist", "bundle", "cli-runtime.js");
  const cliPath = existsSync(bundleCli) && existsSync(bundleRuntime)
    ? bundleCli
    : join(packageDir, "dist", "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(`Pi CLI 不存在：${cliPath}`);
  }
  return {
    command: nodePath || process.env.PI_NODE_PATH || process.execPath,
    args: [cliPath, ...args],
  };
};

const toPublicResult = (result) => ({
  agent: result.agent,
  agentSource: result.agentSource,
  task: truncateText(result.task, MAX_TASK_OUTPUT_BYTES),
  ...(result.title ? { title: result.title } : {}),
  exitCode: result.exitCode,
  output: truncateText(getFinalOutput(result), MAX_TASK_OUTPUT_BYTES),
  // `message` doubles as the live activity while a child is running. Once the
  // child finishes, output/errorMessage carries the authoritative result.
  message: truncateText(result.currentActivity || result.message, MAX_TASK_OUTPUT_BYTES),
  stderr: truncateText(result.stderr, MAX_STDERR_BYTES),
  usage: result.usage,
  model: result.model,
  stopReason: result.stopReason,
  errorMessage: result.errorMessage,
  /** 因可重试的上游错误自动重跑的次数；0 表示没重试过。 */
  retries: Number(result.retries) || 0,
  step: result.step,
  ...(isRecord(result.worktree) ? { worktree: result.worktree } : {}),
  // 监视窗用：本任务自己的时间线 + 最近一段实时输出。
  ...(Number.isFinite(result.startedAt) ? { startedAt: result.startedAt } : {}),
  ...(Number.isFinite(result.completedAt) ? { completedAt: result.completedAt } : {}),
  ...(Number.isFinite(result.lastActivityAt) ? { lastActivityAt: result.lastActivityAt } : {}),
  ...(result.liveOutput ? { liveOutput: truncateText(result.liveOutput, MAX_LIVE_OUTPUT_BYTES) } : {}),
});

const getPartialResultFromUpdate = (partial) => {
  const details = isRecord(partial?.details) ? partial.details : {};
  const results = Array.isArray(details.results) ? details.results : [];
  if (isRecord(results[0])) return results[0];
  return isRecord(partial) && typeof partial.exitCode === "number" ? partial : null;
};

/** 把隔离工作区信息拼成主 Agent 可见的提示。 */
const formatWorktreeNote = (worktree) => {
  if (!isRecord(worktree)) return "";
  if (worktree.error) {
    return `\n\n[worktree] ${worktree.error}\n工作区保留在：${worktree.path || "(未知)"}`;
  }
  if (worktree.discarded === true) {
    return `\n\n[worktree] 任务被中断，未提交半成品；隔离工作区已清理。`;
  }
  if (worktree.retained === true) {
    const files = Array.isArray(worktree.ignoredFiles) ? worktree.ignoredFiles : [];
    return [
      "",
      "",
      `[worktree] 有 ${files.length} 个被 .gitignore 忽略的产物，未自动提交；`,
      `工作区保留在 ${worktree.path}${files.length > 0 ? `：${files.slice(0, 8).join("、")}${files.length > 8 ? " 等" : ""}` : ""}。`,
    ].join("\n");
  }
  if (worktree.changed !== true) return "";
  return [
    "",
    "",
    `[worktree] 改动已提交到分支 ${worktree.branch}（${worktree.path}）`,
    ...(worktree.autoCommitted === true
      ? ["该分支包含子 Agent 自己的提交（不是 Hpp 收尾时补提交的）。"]
      : []),
    ...(worktree.diffStat ? [worktree.diffStat] : []),
    `用 subagent_apply({ id: "${worktree.id}" }) 合并回主工作区。`,
  ].join("\n");
};

/**
 * 长结果已落盘时，在「截断之后」补一段路径。
 *
 * 必须放在 truncateText 之后：内联文本正好吃满 32KB 预算时，拼在里面的路径
 * 会被截掉，模型就永远看不到文件位置了。
 */
const formatResultFiles = (results) => {
  const list = (Array.isArray(results) ? results : [results])
    .filter((result) => isRecord(result) && nonEmptyString(result.resultFile));
  if (list.length === 0) return "";
  const lines = list.map((result) => {
    const label = nonEmptyString(result.title) || nonEmptyString(result.agent) || "subagent";
    const bytes = Number(result.resultBytes) || 0;
    return `${label}：${result.resultFile}（${bytes} 字节）`;
  });
  return `\n\n[完整输出]\n${lines.join("\n")}`;
};

const formatResultNotes = (result) => [
  result?.todoWarning ? `\n\n${result.todoWarning}` : "",
  result?.isolatedNote ? `\n\n${result.isolatedNote}` : "",
  formatWorktreeNote(result?.worktree),
].join("");

const makeDetails = (mode, agentScope, projectAgentsDir, results) => ({
  version: 1,
  mode,
  agentScope,
  projectAgentsDir,
  results: results.map(toPublicResult),
});

const mapWithConcurrencyLimit = async (items, concurrency, callback) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  };
  await Promise.all(new Array(Math.max(1, Math.min(concurrency, items.length))).fill(null).map(worker));
  return results;
};

const runSingleAgent = async ({
  defaultCwd,
  dispatchDefaults,
  agent,
  task,
  title,
  cwd,
  step,
  signal,
  onUpdate,
  makeDetails,
  packageRoot,
  agentDir,
  hostSystemPrompt,
  nodePath,
  permissionMode = "auto",
  requestUI,
  dismissUI,
  ownerId,
  bridgeExtensionPath = SUBAGENT_BRIDGE_EXTENSION_PATH,
  timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  // 续聊 / 后台任务用同一个会话文件重新拉起子进程；同步单次派发仍走 --no-session。
  sessionFile = "",
}) => {
  const result = {
    agent: agent.name,
    agentSource: agent.source,
    task,
    // 调度方给的极简标题，只供界面展示，不参与派发。
    ...(title ? { title } : {}),
    exitCode: -1,
    messages: [],
    output: "",
    currentActivity: `正在启动 ${agent.name}…`,
    liveOutput: "",
    stderr: "",
    usage: createUsage(),
    // 监视窗需要按任务算耗时、判断是否停滞：这里记本任务自己的时间线。
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    // Prefer the child process' actual model once its first assistant message
    // arrives; the dispatching model is only a fallback for providers that omit
    // model metadata in JSON mode.
    model: agent.model,
    step,
  };
  const finishResult = () => {
    result.completedAt = Date.now();
    return result;
  };
  let progressUpdateTimer = null;
  const emitUpdateNow = () => {
    if (!onUpdate) return;
    if (progressUpdateTimer) {
      clearTimeout(progressUpdateTimer);
      progressUpdateTimer = null;
    }
    const liveText = result.exitCode === -1
      ? result.liveOutput || result.currentActivity || getFinalOutput(result)
      : getFinalOutput(result) || result.currentActivity;
    onUpdate({
      content: [{ type: "text", text: truncateText(liveText || "正在运行…", MAX_TASK_OUTPUT_BYTES) }],
      details: makeDetails([result]),
    });
  };
  const emitProgressUpdate = () => {
    if (!onUpdate || progressUpdateTimer) return;
    progressUpdateTimer = setTimeout(() => {
      progressUpdateTimer = null;
      emitUpdateNow();
    }, 150);
  };
  const emitUpdate = () => emitUpdateNow();
  const setCurrentActivity = (value, immediate = false) => {
    const activity = nonEmptyString(value);
    if (!activity || activity === result.currentActivity) return;
    result.currentActivity = activity;
    result.lastActivityAt = Date.now();
    if (immediate) emitUpdateNow();
    else emitProgressUpdate();
  };

  if (!agent) return result;
  if (signal?.aborted) {
    result.exitCode = 1;
    result.stopReason = "aborted";
    result.errorMessage = "子 Agent 已中断";
    emitUpdate();
    return finishResult();
  }

  const bridgeAvailable = existsSync(bridgeExtensionPath);
  const interactive = typeof requestUI === "function" && bridgeAvailable;
  let cwdResult;
  try {
    cwdResult = resolveSubagentCwd(cwd, defaultCwd);
  } catch (error) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    emitUpdate();
    return finishResult();
  }
  const childCwd = cwdResult.cwd;
  const projectRoot = cwdResult.projectRoot;
  if (!interactive && Buffer.byteLength(task, "utf8") > MAX_JSON_TASK_BYTES) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = `SubAgent 任务过长，非交互模式最多支持 ${MAX_JSON_TASK_BYTES} 字节。`;
    emitUpdate();
    return finishResult();
  }
  const extensionIntegrations = getSubagentExtensionIntegration(agent.name, agentDir);
  const approvedExtensionPaths = extensionIntegrations.flatMap((integration) => integration.extensionPaths);
  // 子 Agent 只汇报结果，不向用户提问：bridge 侧不再注册 question 工具，
  // 这里再用 denylist 兜底，避免扩展或历史配置把它们重新带回工具集。
  //
  // 缺少权限桥时 fail closed：子进程没有宿主审批通道，不能让它继续用
  // edit/write（正常打包一定带桥，这里只防安装不完整）。
  const excludedTools = ["subagent", "todo_write", SUBAGENT_QUESTION_TOOL_DENYLIST];
  // 正常打包一定带桥；这里防安装不完整。没有桥就没有宿主审批通道，
  // 写文件的工具必须全部剔除（edit/write 直接写，bash 也能重定向写）。
  if (!bridgeAvailable) excludedTools.push("edit", "write", "bash", "powershell");
  const args = interactive
    ? [
      "--mode", "rpc",
      "--no-extensions",
      "--extension", bridgeExtensionPath,
      "--exclude-tools", excludedTools.join(","),
    ]
    : ["--mode", "json", "-p", "--no-extensions", "--exclude-tools", excludedTools.join(",")];
  if (sessionFile) {
    // 续聊要让子 Agent 记得上一轮内容，必须复用同一个会话文件。
    mkdirSync(dirname(sessionFile), { recursive: true });
    args.push("--session", sessionFile);
  } else {
    args.push("--no-session");
  }
  for (const extensionPath of approvedExtensionPaths) args.push("--extension", extensionPath);
  const model = agent.model || dispatchDefaults.model;
  if (model) args.push("--model", model);
  if (!agent.model && dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
  const tools = getSubagentTools(agent, extensionIntegrations);
  if (tools.length > 0) args.push("--tools", tools.join(","));
  if (agent.systemPrompt) args.push("--append-system-prompt", truncateText(agent.systemPrompt, 24 * 1024));
  if (hostSystemPrompt) args.push("--append-system-prompt", truncateText(hostSystemPrompt, 24 * 1024));
  args.push("--append-system-prompt", "当前进程是 Hpp 内置 subagent。不要调用 subagent，不要尝试递归委派；只完成当前任务并返回结构化摘要。\n\n不要向用户提问（question / ask_user_question 工具在本进程不可用）；需要用户决策时，把问题、可选方案和建议写进结果，由主 Agent 转述给用户。\n\nTask 输出建议包含：Goal、Findings、Files Read/Changed、Tests、Risks、Next Steps。\n\n超时策略：默认不设运行时长上限。除非用户明确要求某个时限，否则不要传入 timeoutMs。\n");
  if (!interactive) args.push(`Task: ${task}`);

  emitUpdate();
  let child;
  let aborted = false;
  let timedOut = false;
  let abortHandler;
  let timeoutId;
  try {
    const invocation = getPiInvocation(packageRoot, args, nodePath);
    child = spawn(invocation.command, invocation.args, {
      cwd: childCwd,
      shell: false,
      windowsHide: true,
      stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
      // POSIX 下创建独立进程组，取消/超时时可只回收本 SubAgent 及其后代。
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: resolvePiAgentDir(agentDir),
        HPP_PI_SUBAGENT_PROJECT_ROOT: projectRoot,
        HPP_PI_SUBAGENT_CHILD: "1",
        HPP_PI_SUBAGENT_PERMISSION_MODE: permissionMode,
      },
    });

    let rpcCompleted = false;
    let requestRpcExit = () => {};
    const writeRpc = (message) => {
      if (!interactive || !child?.stdin?.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch {
        return false;
      }
    };

    const processLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (interactive && event.type === "extension_ui_request") {
        const request = isRecord(event.request) ? event.request : event;
        const method = String(request.method || request.type || "").toLowerCase();
        // 子进程在 rpc 模式下会把 setStatus / setWidget / setTitle / set_editor_text
        // 这类「单向 UI 指令」也发成 extension_ui_request：它们不需要用户回答，
        // 转发给宿主只会被当成「询问用户」，弹出一个没有内容的空问卷。
        if (!RPC_DIALOG_METHODS.has(method)) return;
        if (!SUBAGENT_ALLOWED_DIALOG_METHODS.has(method)) {
          // select / input / editor 是子 Agent 主动向用户提问或索要输入，一律自动取消。
          // 必须回一个 cancelled 响应：RPC 的对话框方法是阻塞的，不回会让子进程永远卡住。
          // 子 Agent 需要用户决策时，应把问题写进结果，由主 Agent 转述。
          writeRpc({ type: "extension_ui_response", id: event.id, cancelled: true });
          return;
        }
        setCurrentActivity("等待用户确认…", true);
        void (async () => {
          let response;
          try {
            response = await requestUI(event, { ownerId, agent: agent.name, task, step });
          } catch {
            response = { cancelled: true };
          }
          writeRpc({
            type: "extension_ui_response",
            id: event.id,
            ...(response?.value !== undefined ? { value: response.value } : {}),
            ...(response?.confirmed !== undefined ? { confirmed: response.confirmed } : {}),
            ...(response?.cancelled ? { cancelled: true } : {}),
          });
        })();
        return;
      }
      if (interactive && event.type === "agent_end") {
        // agent_end 只结束一次低层 run；Pi 还可能重试、压缩恢复或消费引导队列。
        setCurrentActivity("正在等待 Pi 完成收尾或自动恢复…");
        return;
      }
      if (interactive && event.type === "agent_settled") {
        setCurrentActivity("正在整理最终结果…");
        rpcCompleted = true;
        if (event.aborted === true) {
          aborted = true;
          result.stopReason = "aborted";
          result.errorMessage = "子 Agent 已中断";
        }
        requestRpcExit();
        return;
      }
      if (interactive && event.type === "response") {
        if (event.command === "prompt") {
          if (event.success === false) {
            result.stopReason = "error";
            result.errorMessage = nonEmptyString(event.error) || "子 Agent RPC prompt 被拒绝";
            requestRpcExit();
          } else if (event.data?.disposition === "handled") {
            // Pi 官方协议：handled 表示命令已被扩展处理，没有 agent run，
            // 因此不会发送 agent_settled，必须在这里结束等待。
            rpcCompleted = true;
            result.stopReason = "completed";
            result.currentActivity = "Pi 命令已处理";
            requestRpcExit();
          }
        }
        return;
      }
      if (event.type === "message_start") {
        const message = event.message;
        if (message?.role === "assistant") setCurrentActivity("正在分析任务…");
        return;
      }
      if (event.type === "message_update") {
        const update = getMessageUpdateEvent(event);
        const updateType = String(update?.type || "");
        if (updateType === "text_delta") {
          const delta = String(update?.delta || "");
          if (delta) {
            result.liveOutput = `${result.liveOutput}${delta}`.slice(-MAX_TASK_OUTPUT_BYTES);
            const preview = result.liveOutput.replace(/\s+/g, " ").trim();
            const livePreview = preview.length > 180 ? `…${preview.slice(-179)}` : preview;
            setCurrentActivity(`正在输出：${livePreview}`);
          } else {
            setCurrentActivity("正在整理结果…");
          }
        } else if (updateType === "thinking_delta") {
          setCurrentActivity("正在分析任务…");
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        setCurrentActivity(getChildToolActivity(event, "start"), true);
        return;
      }
      if (event.type === "tool_execution_update") {
        setCurrentActivity(getChildToolActivity(event, "update"));
        return;
      }
      if (event.type === "tool_execution_end") {
        setCurrentActivity(getChildToolActivity(event, "end"));
        return;
      }
      if (event.type === "agent_end") {
        setCurrentActivity("正在整理最终结果…");
        return;
      }
      if (event.type === "tool_result_end") {
        setCurrentActivity("已收到工具结果，正在分析…");
      }
      if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
        if (result.messages.length < MAX_MESSAGE_COUNT) result.messages.push(event.message);
        const message = event.message;
        if (message.role === "assistant") {
          result.output = getMessageText(message) || result.output;
          result.liveOutput = "";
          setCurrentActivity(getMessageText(message) ? "已完成一轮输出，继续工作…" : "正在继续分析…");
          result.usage.turns += 1;
          const usage = isRecord(message.usage) ? message.usage : {};
          result.usage.input += Number(usage.input) || 0;
          result.usage.output += Number(usage.output) || 0;
          result.usage.cacheRead += Number(usage.cacheRead) || 0;
          result.usage.cacheWrite += Number(usage.cacheWrite) || 0;
          result.usage.cost += Number(usage.cost?.total) || 0;
          result.usage.contextTokens = Number(usage.totalTokens) || result.usage.contextTokens;
          result.model = nonEmptyString(message.model) || result.model || dispatchDefaults.model;
          const nextStopReason = nonEmptyString(message.stopReason);
          const nextErrorMessage = nonEmptyString(message.errorMessage);
          if (nextStopReason) result.stopReason = nextStopReason;
          // pi 内部会自己重试：失败尝试的 errorMessage 不能靠 `||` 留着，否则重试
          // 成功后任务还挂着「overloaded」这类旧文案，界面上看起来就是失败。
          if (nextErrorMessage) result.errorMessage = nextErrorMessage;
          else if (nextStopReason === "stop") result.errorMessage = "";
        }
        emitUpdate();
      }
    };

    let stdoutBuffer = "";
    let stderrBuffer = "";
    // 单条记录超过上限时只丢弃这一条并继续读取，而不是终止子 Agent：
    // 丢掉末尾一个大工具结果远比让整个任务失败代价小。
    let skippingOversizedLine = false;
    let oversizedLineCount = 0;
    child.stdout?.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      if (skippingOversizedLine) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex === -1) {
          // 仍未到记录结尾，避免缓冲区无限增长。
          stdoutBuffer = stdoutBuffer.slice(-1024);
          return;
        }
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        skippingOversizedLine = false;
      }
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_STDOUT_LINE_BYTES) {
        oversizedLineCount += 1;
        stdoutBuffer = "";
        skippingOversizedLine = true;
        setCurrentActivity("已跳过一条超大协议记录，继续执行…");
        return;
      }
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    child.stderr?.on("data", (chunk) => {
      stderrBuffer = truncateText(`${stderrBuffer}${chunk.toString()}`, MAX_STDERR_BYTES);
      result.stderr = stderrBuffer;
    });

    const exitCode = await new Promise((resolveExit) => {
      let settled = false;
      let hardAbortTimer = null;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (hardAbortTimer) clearTimeout(hardAbortTimer);
        resolveExit(rpcCompleted ? 0 : typeof code === "number" ? code : 1);
      };
      requestRpcExit = () => {
        if (!interactive || settled) return;
        setTimeout(() => {
          if (settled) return;
          // agent_settled 后先走 RPC 的 orderly shutdown，避免正常完成也被
          // taskkill 直接打断；只有子进程/后代不收敛时才强制回收。
          try { child.stdin?.end(); } catch { /* ignore */ }
          hardAbortTimer = setTimeout(() => {
            if (settled) return;
            killSubagentTree(child, "SIGKILL");
            finish(0);
          }, 2000);
        }, 25);
      };
      child.once("close", finish);
      child.once("error", () => finish(1));
      abortHandler = () => {
        if (aborted) return;
        aborted = true;
        try {
          if (interactive) writeRpc({ type: "abort" });
        } catch { /* ignore */ }
        killSubagentTree(child, "SIGTERM");
        hardAbortTimer = setTimeout(() => {
          if (!settled) {
            killSubagentTree(child, "SIGKILL");
            // child 的 close 事件可能被后代持有的 pipe 阻塞；主动结算任务。
            finish(1);
          }
        }, 2000);
      };
      if (signal) {
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          abortHandler();
        }, timeoutMs);
      }
      if (interactive && !writeRpc({ id: `prompt-${ownerId || Date.now()}`, type: "prompt", message: task })) {
        finish(1);
      }
    });

    if (!skippingOversizedLine && stdoutBuffer.trim()) processLine(stdoutBuffer);
    result.exitCode = exitCode;
    if (timedOut) {
      result.exitCode = 1;
      result.stopReason = "timeout";
      result.errorMessage = `子 Agent 超时（${Math.round(timeoutMs / 1000)} 秒）`;
    } else if (aborted || signal?.aborted) {
      result.exitCode = 1;
      result.stopReason = "aborted";
      result.errorMessage = "子 Agent 已中断";
    } else if (!result.stopReason && exitCode !== 0) {
      result.stopReason = "error";
      result.errorMessage = result.stderr || "子 Agent 进程异常退出";
    }
    // 保留完整正文：截断只发生在「给模型的内联预算」和「给界面看的 details」。
    // 以前在这里就把 result.output 覆盖成 8KB，等于把原件毁掉——之后落盘、
    // 续聊、{previous} 引用拿到的全是残本。
    if (oversizedLineCount > 0 && !result.stopReason) {
      result.protocolWarning = `已跳过 ${oversizedLineCount} 条超大协议记录`;
      result.stderr = truncateText(`${result.stderr}${result.stderr ? "\n" : ""}${result.protocolWarning}`, MAX_STDERR_BYTES);
    }
    // "stop" 是正常结束，不是失败；只有这三种才算失败原因。
    const stopReasonFailed = result.stopReason === "timeout"
      || result.stopReason === "error"
      || result.stopReason === "aborted";
    result.currentActivity = stopReasonFailed
      ? result.errorMessage || (result.stopReason === "timeout" ? "已超时" : "已停止")
      : result.output ? "已完成" : "已完成（未返回正文）";
    emitUpdate();
    return finishResult();
  } catch (error) {
    if (signal?.aborted || aborted) {
      result.exitCode = 1;
      result.stopReason = "aborted";
      result.errorMessage = "子 Agent 已中断";
    } else {
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage = error instanceof Error ? error.message : String(error);
    }
    result.currentActivity = result.errorMessage;
    emitUpdate();
    return finishResult();
  } finally {
    dismissUI?.(ownerId, "child-exit");
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
};

const getTaskItems = (params) => {
  if (!Array.isArray(params?.tasks)) return [];
  return params.tasks.filter(isRecord).map((item) => ({
    agent: nonEmptyString(item.agent) || "",
    task: nonEmptyString(item.task) || "",
    title: nonEmptyString(item.title),
    cwd: nonEmptyString(item.cwd),
    model: nonEmptyString(item.model),
    isolation: item.isolation === "worktree" ? "worktree" : undefined,
    todoId: nonEmptyString(item.todoId),
    inheritContext: item.inheritContext === true,
    timeoutMs: item.timeoutMs === undefined ? undefined : normalizeTaskTimeout(item.timeoutMs),
  }));
};

const getChainItems = (params) => {
  if (!Array.isArray(params?.chain)) return [];
  return params.chain.filter(isRecord).map((item) => ({
    agent: nonEmptyString(item.agent) || "",
    task: nonEmptyString(item.task) || "",
    title: nonEmptyString(item.title),
    cwd: nonEmptyString(item.cwd),
    model: nonEmptyString(item.model),
    isolation: item.isolation === "worktree" ? "worktree" : undefined,
    todoId: nonEmptyString(item.todoId),
    inheritContext: item.inheritContext === true,
    timeoutMs: item.timeoutMs === undefined ? undefined : normalizeTaskTimeout(item.timeoutMs),
  }));
};

const requestedAgentNames = (params) => {
  const names = [];
  if (nonEmptyString(params?.agent)) names.push(params.agent);
  for (const item of [...getTaskItems(params), ...getChainItems(params)]) {
    if (item.agent) names.push(item.agent);
  }
  return new Set(names);
};

/**
 * 模型池归一化。
 *
 * 与 `shared/agent-subagent.ts` 的 `normalizeAgentSubagentPool` 保持同一口径：
 * 重复模型合并、空值/超长丢弃、上限 8 条。worker 侧这份副本不能引用 shared
 * 的 TS 模块（.mjs 在打包后单独运行），两边由测试钉住。
 */
const normalizeModelPool = (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const entries = [];
  for (const rawEntry of value) {
    if (!isRecord(rawEntry)) continue;
    const model = nonEmptyString(rawEntry.model);
    if (!model || model.length > 200 || seen.has(model)) continue;
    seen.add(model);
    const label = nonEmptyString(rawEntry.label)?.slice(0, 80);
    entries.push({
      model,
      ...(label ? { label } : {}),
    });
    if (entries.length >= MAX_MODEL_POOL_ENTRIES) break;
  }
  return entries;
};

export const normalizeHppSubagentConfig = (value) => {
  const input = isRecord(value) ? value : {};
  return {
    enabled: input.enabled !== false,
    // 总开关：关掉后 subagent 一律跟随主 Agent，池内容保留。
    poolEnabled: input.poolEnabled !== false,
    pool: normalizeModelPool(input.pool),
    backgroundEnabled: input.backgroundEnabled !== false,
    maxConcurrency: clampInteger(input.maxConcurrency, 1, MAX_CONFIGURABLE_CONCURRENCY, MAX_CONCURRENCY),
    autoWakeOnResult: input.autoWakeOnResult !== false,
    autoWakeDebounceMs: clampInteger(input.autoWakeDebounceMs, 500, 60_000, 3000),
    maxAutoWakeTurns: clampInteger(input.maxAutoWakeTurns, 1, 10, 3),
    backgroundTimeoutMs: clampInteger(
      input.backgroundTimeoutMs,
      60_000,
      MAX_BACKGROUND_TIMEOUT_MS,
      DEFAULT_BACKGROUND_TIMEOUT_MS,
    ),
  };
};

const clampInteger = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

/** 池内某一项；不在池里返回 undefined。 */
const getPoolEntry = (config, model) => (
  model ? (config.pool || []).find((entry) => entry.model === model) : undefined
);

/**
 * 子 Agent 的起始模型。
 *
 * 走池子（首项）或跟随主 Agent，二选一。agent markdown 里声明的 model
 * 在这一层之外优先，由调用方处理。
 */
const resolveConfiguredModel = (config, inheritedModel) => {
  if (config.poolEnabled !== false) {
    const poolStart = config.pool?.[0]?.model;
    if (poolStart) return poolStart;
  }
  return inheritedModel;
};

/**
 * 模型池逐行列出，给委派方在符合选型规则时读。
 *
 * 光给 id 不够：自建渠道的 id（`tanwan/gpt-5.6-sol`、本地别名）对模型来说就是
 * 陌生字符串，它没法据此判断强弱。所以这里补上模型目录里的真值 —— 上下文窗口、
 * 推理/思考档位、视觉、价格 —— 让「挑哪个」有据可依，也省掉用户手写场景说明。
 *
 * 一行一项而不是挤成一句话：并行任务之间要横向比能力，竖排更容易对齐着看。
 *
 * 这里只给事实、不给「什么任务用什么模型」的映射：轻重由派发方自己判断，
 * 写死一套档位规则等于把它该做的判断提前替它做掉。
 */
const formatContextWindow = (value) => {
  const tokens = Number(value) || 0;
  if (tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
};

/** 每百万 token 的输入/输出价；两边都是 0 视为未知（免费额度也常是 0，不硬说成免费）。 */
const formatModelPrice = (cost) => {
  const input = Number(cost?.input) || 0;
  const output = Number(cost?.output) || 0;
  if (!input && !output) return "";
  const trim = (value) => value.toFixed(value < 1 ? 2 : 1).replace(/\.0+$/, "");
  return `$${trim(input)}/$${trim(output)} 每 M`;
};

const describeModelFacts = (meta) => {
  if (!meta) return [];
  const facts = [];
  const contextWindow = formatContextWindow(meta.contextWindow);
  if (contextWindow) facts.push(`ctx ${contextWindow}`);
  if (meta.reasoning === true) {
    const levels = Array.isArray(meta.thinkingLevels)
      ? meta.thinkingLevels.filter((level) => level && level !== "off")
      : [];
    facts.push(levels.length > 0 ? `思考 ${levels.join("/")}` : "推理");
  }
  if (meta.images === true) facts.push("视觉");
  const price = formatModelPrice(meta.cost);
  if (price) facts.push(price);
  return facts;
};

const listModelPool = (pool, getModelMeta) => pool.map((entry) => {
  const separator = entry.model.indexOf("/");
  const provider = separator > 0 ? entry.model.slice(0, separator) : entry.model;
  const modelId = separator > 0 ? entry.model.slice(separator + 1) : "";
  let meta;
  if (modelId && typeof getModelMeta === "function") {
    // 目录查询失败不能让整份工具说明挂掉：最差就是退回「只有 id」。
    try {
      meta = getModelMeta(provider, modelId);
    } catch {
      meta = undefined;
    }
  }
  return `- ${[entry.model, ...describeModelFacts(meta)].filter(Boolean).join("｜")}`;
}).join("\n");

/**
 * 派发侧的选型口径。
 *
 * 默认不换模型：同一段上下文里换模型会让 prompt 缓存全废，也会让一个任务的产出
 * 无法归因到某个模型。只有收益明确时（大批量只读检索、视觉、长窗口、交叉审查）
 * 才在派发时单独指定 model；会改代码的 worker 不主动换成更弱的模型。
 */
const MODEL_POOL_DISPATCH_GUIDANCE = [
  "默认不填 model，用池内第一项。只有下面几种情况才给任务单独指定 model：",
  "· 大批量只读检索（要读很多文件、广泛搜索定位）→ 池里便宜、快的模型；",
  "· 任务需要看图 → 支持视觉的模型；",
  "· 输入明显超过默认模型的上下文窗口 → 长窗口模型；",
  "· 审查代码 → 与写这段代码的模型不同厂商的模型，避免自己审自己。",
  "会改代码的 worker 不要换成比默认更弱的模型：改错的代价通常比省下的钱大。",
  "每行后面的信息来自模型目录：上下文窗口、推理/思考档位、视觉能力、每百万 token 的价格。",
  "model 填具体的 provider/modelId。",
].join("\n");

/**
 * 派发方式的选择策略。
 *
 * 不写这一段，模型会稳定地只用单任务：单任务永远「跑得通」，并行则要它先判断
 * 能不能拆、拆错了还要收拾。但一个要读五个目录的调研，用一个 subagent 串行读完
 * 就是白等；反过来，一处小改动拆成四个并行任务，只是把同一份 token 花四遍。
 * 所以这里只讲「什么时候值得并行」，不讲「尽量并行」。
 */
const SUBAGENT_DISPATCH_POLICY = [
  "怎么派：",
  "· 单任务（默认）：只有一件事要查或要改，改动集中在一处。",
  "· tasks 并行：能拆成 2~4 个互不依赖的部分（不同目录 / 不同子系统 / 不同问题），且每部分都要各自读一批文件。",
  "· chain：后一步必须拿到前一步的产出（先定位 → 再设计 → 再动手）。",
  "拆不出独立部分就别并行——并行会把上下文和成本成倍放大，却不会让单点任务更快。",
  "耗时长、你在这期间还有别的事可做时，加 background:true 立即拿回任务 id；",
  "后台派发后不要空等轮询，需要结果时调 subagent_wait；",
  "追问已经完成的子任务用 subagent_send，不要重新派一个。",
].join("\n");

/** 内置 agent 的一句话定位；名字从 DEFAULT_AGENTS 取，改了定义就不会漏改说明。 */
const BUILTIN_AGENT_LABELS = {
  scout: "只读检索",
  planner: "出实施计划",
  reviewer: "审查问题",
  worker: "改代码",
};
const builtinAgentRoster = DEFAULT_AGENTS
  .map((agent) => `${agent.name}（${BUILTIN_AGENT_LABELS[agent.name] || "自定义"}）`)
  .join("、");

/**
 * 扩展运行时状态。
 *
 * resourceLoader.reload() 会重新执行扩展工厂，但 createHppSubagentExtension
 * 返回的是同一个函数对象。状态挂在函数对象上，reload 前后共享同一份：
 * 否则 reload 前派发的后台任务会留在旧闭包的表里，新的 subagent_stop /
 * subagent_wait / dispose 都找不到它们，只能等超时。
 */
const createSubagentRuntimeState = () => ({
  backgroundTasks: new Map(),
  isolatedTasks: new Map(),
  isolatedTaskSeq: 0,
  backgroundTaskSeq: 0,
  activeTaskCount: 0,
  slotWaiters: [],
  pendingAutoWakeEntries: new Map(),
  autoWakeTimer: null,
  pendingHostWake: null,
  /** 会话正在销毁：不再向主会话投递任何后台事件/结果。 */
  disposed: false,
});

export const createHppSubagentExtension = (options = {}) => {
  const {
    packageRoot = process.env.PI_SDK_PACKAGE_ROOT || "",
    agentDir = resolvePiAgentDir(),
    hostSystemPrompt = "",
    nodePath = process.env.PI_NODE_PATH || process.execPath,
    getPermissionMode = () => "auto",
    requestUI,
    dismissUI,
    bridgeExtensionPath = SUBAGENT_BRIDGE_EXTENSION_PATH,
    subagentConfig,
    getSubagentConfig,
    /**
     * 模型目录查询：`(provider, modelId) => { name?, contextWindow?, reasoning?,
     * thinkingLevels?, images?, cost? }`。由 worker 用 pi 的 modelRegistry 提供，
     * 只用于把能力摘要写进工具说明；查不到就退回「只有 id」。
     */
    getModelMeta,
    /**
     * 后台任务的独立事件通道。worker 侧实现为直接写 stdout 的
     * `subagent_background`，不经过 activePromptId 闸门，所以主回合结束后
     * 仍能看到进度。
     */
    emitBackgroundEvent = () => {},
    /** 子任务会话文件根目录（<userData>/hpp-data/pi-subagents）。 */
    subagentDataDir = "",
    /** 父会话的稳定 key，用作子目录名。 */
    sessionKey = "default",
    /** 当前会话是否空闲；用于决定后台结果走 followUp 还是 nextTurn。 */
    isSessionIdle = () => true,
    /**
     * P2b 自动唤醒是否被护栏允许（暂停、连续上限、压缩/模型切换/待确认弹窗）。
     * 只有扩展侧决定「值得唤醒」后才问它。
     */
    canAutoWake = () => false,
    /** triggerTurn 发出后等宿主回执的超时；主要供测试缩短，生产默认 8s。 */
    hostWakeConfirmTimeoutMs = 8000,
    /** 触发宿主回合前，把本批任务 id 交给 worker（before_agent_start 里取走）。 */
    prepareHostTurn = () => {},
    /** worktree 隔离的根目录（<hpp-data>/worktrees）。 */
    worktreeBaseDir = "",
    /** P4：与 todo-extension 共享的任务 store。 */
    getTodoStore = () => null,
    /** P4：后台状态变更主动推给 UI（plan_update）。 */
    emitPlanUpdate = () => {},
    /**
     * P5：从主会话当前分支生成一个分叉会话文件。worker 负责避开「正在执行
     * 本次 subagent 调用的助手消息」，避免子 Agent 看到孤立的工具调用。
     */
    createInheritedSession = () => "",
    // 仅测试注入口：真实间隔是 15s / 45s，跑测试要能调小。
    retryDelaysMs = SUBAGENT_RETRY_DELAYS_MS,
  } = options;
  const extension = (pi) => {
  if (!pi || typeof pi.registerTool !== "function") return;
  const state = extension.__hppRuntimeState || (extension.__hppRuntimeState = createSubagentRuntimeState());
  // Hpp can hot-update the subagent config while this worker keeps running
  // ("SubAgent 设置" 保存不重建会话). Resolve the config on every use so a
  // changed profile/default model applies to the next subagent call instead
  // of only after a session reload. Plain values keep the previous behavior.
  const readSubagentConfig = () => normalizeHppSubagentConfig(
    typeof getSubagentConfig === "function"
      ? getSubagentConfig()
      : (typeof subagentConfig === "function" ? subagentConfig() : subagentConfig)
  );
  if (!readSubagentConfig().enabled) return;
  // 池子写进工具说明，模型才知道「可以按任务挑」。注册时的快照就够：改池子后
  // 校验仍读实时配置，选到已移除的模型会拿到一份「当前可用」的报错并自我纠正。
  // 开关关掉时不要列池：说明里挂着候选、实际却被拒绝，比不写更糟。
  const registeredConfig = readSubagentConfig();
  const registeredPool = registeredConfig.poolEnabled === false ? [] : (registeredConfig.pool || []);
  const poolHint = registeredPool.length > 0
    ? `\n\n模型池（默认用第一项，按下列规则才单独指定 model）：\n${listModelPool(registeredPool, getModelMeta)}\n${MODEL_POOL_DISPATCH_GUIDANCE}`
    : "";

  // 后台任务表：任务在 execute 返回之后继续跑，所有进度走 emitBackgroundEvent，
  // 不再依赖 tool_execution_update（那个通道受 activePromptId 闸门约束）。
  // 任务表、隔离任务、并发额度、唤醒队列都来自 extension 上的共享状态，
  // reload 后新实例仍能看到并管理旧任务。
  const { backgroundTasks, isolatedTasks, slotWaiters, pendingAutoWakeEntries } = state;
  const BACKGROUND_EVENT_THROTTLE_MS = 150;

  const nextBackgroundTaskId = () => {
    state.backgroundTaskSeq += 1;
    return `sa_${Date.now().toString(36)}${state.backgroundTaskSeq.toString(36)}`;
  };

  const sanitizePathSegment = (value) => (
    String(value || "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "default"
  );

  const getSubagentTaskDir = () => {
    if (!subagentDataDir) return "";
    const dir = join(subagentDataDir, sanitizePathSegment(sessionKey));
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  /** 结果文件与后台任务共用同一个目录：顺手清掉 7 天前的，别让它无限堆积。 */
  const pruneOldResultFiles = (dir) => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".result.md")) continue;
        const full = join(dir, name);
        try {
          if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
        } catch {
          // 单个文件被占用/已删除：跳过，下次再清。
        }
      }
    } catch {
      // 目录不可读时不影响落盘本身。
    }
  };

  /**
   * 同步任务的长结果落盘。
   *
   * 只有超过该路径的内联预算才写文件：短任务落盘纯属噪音。写的是**完整正文**，
   * 模型拿到的内联文本仍是截断版，但可以按路径用 Read 取全文。
   * 目录与后台任务的 resultFile 共用，路径风格保持一致。
   */
  const persistLongResult = (result, inlineBudget = MAX_TASK_OUTPUT_BYTES) => {
    if (!isRecord(result)) return;
    const text = getResultOutput(result);
    const bytes = Buffer.byteLength(text, "utf8");
    // 该路径的内联预算装得下就不用落盘：免得给模型多一行指向冗余文件的提示。
    if (bytes <= inlineBudget) return;
    const dir = getSubagentTaskDir();
    if (!dir) return;
    pruneOldResultFiles(dir);
    const filePath = join(dir, `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.result.md`);
    try {
      writeFileSync(filePath, [
        `# ${result.title || result.task || result.agent || "subagent"}`,
        `- agent: ${result.agent || ""}`,
        `- model: ${result.model || "(默认)"}`,
        `- status: ${isFailedResult(result) ? "failed" : "completed"}`,
        `- bytes: ${bytes}`,
        "",
        text,
      ].join("\n"), "utf8");
      result.resultFile = filePath;
      result.resultBytes = bytes;
    } catch {
      // 落盘失败不影响结果本身：模型仍能看到截断版，只是没有全文出口。
    }
  };

  const acquireTaskSlot = (signal, onQueued) => {
    const config = readSubagentConfig();
    if (state.activeTaskCount < config.maxConcurrency && slotWaiters.length === 0) {
      state.activeTaskCount += 1;
      return Promise.resolve(true);
    }
    onQueued?.();
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = { resolve, signal, onAbort: null, finish: null };
      waiter.finish = (granted) => {
        const index = slotWaiters.indexOf(waiter);
        if (index >= 0) slotWaiters.splice(index, 1);
        if (signal && waiter.onAbort) signal.removeEventListener("abort", waiter.onAbort);
        resolve(granted);
      };
      waiter.onAbort = () => waiter.finish(false);
      signal?.addEventListener?.("abort", waiter.onAbort, { once: true });
      slotWaiters.push(waiter);
    });
  };

  const releaseTaskSlot = () => {
    while (slotWaiters.length > 0) {
      const next = slotWaiters.shift();
      if (next.signal?.aborted) {
        next.finish(false);
        continue;
      }
      // 名额直接转交，不归零，避免被新来的任务插队。
      next.finish(true);
      return;
    }
    state.activeTaskCount = Math.max(0, state.activeTaskCount - 1);
  };

  const isTerminalBackgroundStatus = (status) => (
    status === "completed" || status === "error" || status === "interrupted"
  );

  const toBackgroundResult = (entry) => {
    const result = isRecord(entry.result) ? entry.result : {};
    return {
      ...toPublicResult({
        ...result,
        agent: entry.agent === "chain" ? (result.agent || "chain") : entry.agent,
        task: entry.task,
        title: entry.title,
        model: entry.model,
        usage: entry.usage,
        currentActivity: entry.currentActivity,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
        lastActivityAt: entry.lastActivityAt,
        liveOutput: entry.liveOutput,
        exitCode: isTerminalBackgroundStatus(entry.status) ? result.exitCode : -1,
        stopReason: entry.status === "interrupted" ? "aborted" : result.stopReason,
      }),
      // 任务 id 稳定跨多轮续聊，监视窗停止/续聊都靠它。
      id: entry.id,
      status: entry.status,
      background: true,
      rounds: Array.isArray(entry.rounds) ? entry.rounds.length : 0,
      ...(entry.resultFile ? { resultFile: entry.resultFile } : {}),
      ...(entry.sessionFile ? { sessionFile: entry.sessionFile } : {}),
    };
  };

  const buildBackgroundDetails = (entries) => ({
    version: 1,
    mode: entries.length > 1 ? "parallel" : "background",
    agentScope: entries[0]?.agentScope || "user",
    projectAgentsDir: entries[0]?.projectAgentsDir,
    background: true,
    results: entries.map(toBackgroundResult),
  });

  const emitBackgroundEntry = (entry, terminal) => {
    if (entry.eventTimer) {
      clearTimeout(entry.eventTimer);
      entry.eventTimer = null;
    }
    if (state.disposed) return;
    if (typeof emitBackgroundEvent !== "function") return;
    try {
      emitBackgroundEvent({
        type: "subagent_background",
        toolCallId: entry.toolCallId,
        background: true,
        args: { background: true },
        ...(terminal
          ? { result: { details: buildBackgroundDetails([entry]) } }
          : { partialResult: { details: buildBackgroundDetails([entry]) } }),
      });
    } catch {
      // 事件通道失败不能影响子任务本身；结果仍会落盘。
    }
  };

  const scheduleBackgroundEvent = (entry) => {
    if (entry.eventTimer) return;
    entry.eventTimer = setTimeout(() => {
      entry.eventTimer = null;
      if (!isTerminalBackgroundStatus(entry.status)) emitBackgroundEntry(entry, false);
    }, BACKGROUND_EVENT_THROTTLE_MS);
  };

  const addUsage = (target, delta) => {
    const usage = isRecord(delta) ? delta : {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"]) {
      target[key] += Number(usage[key]) || 0;
    }
    target.turns += Number(usage.turns) || 0;
    const contextTokens = Number(usage.contextTokens) || 0;
    if (contextTokens > 0) target.contextTokens = contextTokens;
    return target;
  };

  const makeBackgroundUpdate = (entry) => (partial) => {
    const now = Date.now();
    // 停滞看门狗只记录，不杀进程：长推理/大文件读取也可能很久没有新事件。
    entry.maxIdleMs = Math.max(entry.maxIdleMs || 0, now - (entry.lastActivityAt || now));
    const partialResult = getPartialResultFromUpdate(partial) || partial;
    if (isRecord(partialResult)) {
      entry.result = { ...(isRecord(entry.result) ? entry.result : {}), ...partialResult };
      // 本轮进行中的用量单独放，finalize 时再累加到跨轮总量里。
      entry.liveUsage = partialResult.usage || entry.liveUsage;
      entry.model = partialResult.model || entry.model;
      entry.currentActivity = partialResult.currentActivity || entry.currentActivity;
      entry.liveOutput = partialResult.liveOutput || entry.liveOutput;
      entry.lastActivityAt = now;
    }
    scheduleBackgroundEvent(entry);
  };

  const writeBackgroundResultFile = (entry) => {
    if (!entry.resultFile) return;
    const result = isRecord(entry.result) ? entry.result : {};
    const body = [
      `# ${entry.title || entry.task}`,
      `- id: ${entry.id}`,
      `- agent: ${entry.agent}`,
      `- model: ${entry.model || "(默认)"}`,
      `- status: ${entry.status}`,
      `- startedAt: ${new Date(entry.startedAt).toISOString()}`,
      ...(entry.completedAt ? [`- completedAt: ${new Date(entry.completedAt).toISOString()}`] : []),
      "",
      getFinalOutput(result) || result.errorMessage || getResultOutput(result) || "(无输出)",
    ].join("\n");
    try {
      writeFileSync(entry.resultFile, body, "utf8");
    } catch {
      // 落盘失败只影响「主 Agent 稍后读文件」，不改变任务结果。
    }
  };

  /**
 * 后台结果回送。
 *
 * - 主回合运行中：followUp，在当前回合里找空档送达；
 * - 空闲且允许自动唤醒：先等 autoWakeDebounceMs，窗口内完成的任务合并成
 *   一条消息，再让宿主开一个新回合（triggerTurn）；
 * - 空闲但自动唤醒被关闭/护栏挡住：nextTurn + 界面「继续」按钮。
 */
  const buildResultContent = (entries) => entries.map((entry) => {
    const result = isRecord(entry.result) ? entry.result : {};
    const summary = truncateText(getFinalOutput(result) || getResultOutput(result), 4096);
    const statusText = entry.status === "completed"
      ? "已完成"
      : entry.status === "interrupted"
        ? "已中断"
        : "失败";
    return [
      `后台子任务 ${entry.id}（${entry.agent}${entry.title ? ` · ${entry.title}` : ""}）${statusText}。`,
      ...(entry.resultFile ? [`完整结果：${entry.resultFile}`] : []),
      summary,
      ...(result.todoWarning ? [result.todoWarning] : []),
      ...(isRecord(result.worktree) ? [formatWorktreeNote(result.worktree).trim()] : []),
      `如需追问，调用 subagent_send({ id: "${entry.id}", message: "..." })。`,
    ].filter(Boolean).join("\n");
  }).join("\n\n---\n\n");

  const buildResultPayload = (entries, options) => ({
    customType: "hpp-subagent-result",
    content: buildResultContent(entries),
    display: true,
    details: {
      ...(entries.length === 1 ? { taskId: entries[0].id } : {}),
      taskIds: entries.map((entry) => entry.id),
      background: true,
      autoWake: options?.triggerTurn === true,
    },
  });

  /**
   * 发一条结果消息。
   *
   * pi.sendMessage 在 SDK 里是 fire-and-forget：bindCore 把它包成
   * `(message, options) => { sendCustomMessage(...).catch(...) }`，没有返回值。
   * 所以这里只能判断「同步调用有没有抛错」，不能当成投递成功；
   * triggerTurn 是否真的拉起宿主回合，要等 confirmHostTurn 回执。
   */
  const sendResultPayload = (entries, options) => {
    if (typeof pi.sendMessage !== "function") return false;
    try {
      pi.sendMessage(buildResultPayload(entries, options), options);
      return true;
    } catch {
      return false;
    }
  };

  const MAX_AUTO_WAKE_ATTEMPTS = 5;
  const HOST_WAKE_CONFIRM_TIMEOUT_MS = Math.max(50, Number(hostWakeConfirmTimeoutMs) || 8000);

  const settleAutoWakeEntries = (entries) => {
    for (const entry of entries) {
      entry.notified = true;
      pendingAutoWakeEntries.delete(entry.id);
    }
  };

  const clearPendingHostWake = () => {
    if (!state.pendingHostWake) return;
    clearTimeout(state.pendingHostWake.timer);
    state.pendingHostWake = null;
  };

  /**
   * 发出 triggerTurn 后等 worker 回执：宿主回合真的启动了才算送达。
   * 超时未确认（会话忙、被压缩挡住、扩展被 reload）就降级为 nextTurn，结果不丢。
   */
  const armHostWakeConfirmation = (entries) => {
    clearPendingHostWake();
    const timer = setTimeout(() => {
      if (!state.pendingHostWake) return;
      const pending = state.pendingHostWake;
      state.pendingHostWake = null;
      deliverEntries(pending.entries, { deliverAs: "nextTurn" });
    }, HOST_WAKE_CONFIRM_TIMEOUT_MS);
    state.pendingHostWake = { entries, taskIds: entries.map((entry) => entry.id), timer };
  };

  /**
   * 投递 + 结果处置。只有同步抛错能当场发现；triggerTurn 靠回执，
   * 其它模式是排队语义，发出去即视为已交付。
   */
  const deliverEntries = (entries, options, { awaitHostTurn = false } = {}) => {
    if (!sendResultPayload(entries, options)) {
      requeueAutoWake(entries);
      return false;
    }
    if (awaitHostTurn) armHostWakeConfirmation(entries);
    else settleAutoWakeEntries(entries);
    return true;
  };

  /**
   * 投递失败时把结果放回队列，稍后重试；不能像以前那样先 clear 再发送，
   * 一旦 pi.sendMessage 抛错，这一轮结果对主 Agent 就彻底不可见了。
   */
  const requeueAutoWake = (entries) => {
    let retryable = false;
    for (const entry of entries) {
      if (entry.delivered || entry.notified) continue;
      entry.wakeAttempts = (entry.wakeAttempts || 0) + 1;
      pendingAutoWakeEntries.set(entry.id, entry);
      if (entry.wakeAttempts <= MAX_AUTO_WAKE_ATTEMPTS) retryable = true;
    }
    if (retryable && !state.autoWakeTimer) {
      state.autoWakeTimer = setTimeout(flushAutoWake, 2000);
    }
  };

  const flushAutoWake = () => {
    state.autoWakeTimer = null;
    if (state.disposed) {
      pendingAutoWakeEntries.clear();
      return;
    }
    const entries = [...pendingAutoWakeEntries.values()]
      .filter((entry) => (
        !entry.delivered
        && !entry.notified
        && (entry.wakeAttempts || 0) <= MAX_AUTO_WAKE_ATTEMPTS
      ));
    if (entries.length === 0) return;
    const config = readSubagentConfig();
    if (!isSessionIdle()) {
      deliverEntries(entries, { deliverAs: "followUp" });
      return;
    }
    if (
      config.autoWakeOnResult === false
      || config.backgroundEnabled === false
      || (typeof canAutoWake === "function" && !canAutoWake())
    ) {
      deliverEntries(entries, { deliverAs: "nextTurn" });
      return;
    }
    // worker 先记住本批 task id，before_agent_start 里据此上报 host_turn_started；
    // 回执到了才算送达，否则超时降级为 nextTurn。
    try { prepareHostTurn?.({ taskIds: entries.map((entry) => entry.id) }); } catch { /* ignore */ }
    if (deliverEntries(entries, { triggerTurn: true }, { awaitHostTurn: true })) return;
    // triggerTurn 同步不可用时不能丢结果，立即降级。
    deliverEntries(entries, { deliverAs: "nextTurn" });
  };

  const scheduleAutoWake = (entry, delay) => {
    if (state.disposed) return;
    pendingAutoWakeEntries.set(entry.id, entry);
    if (state.autoWakeTimer) return;
    state.autoWakeTimer = setTimeout(flushAutoWake, Math.max(0, Number(delay) || 0));
  };

  const notifyMainAgent = (entry) => {
    if (state.disposed) return;
    if (entry.delivered || entry.notified) return;
    if (typeof pi.sendMessage !== "function") return;
    const config = readSubagentConfig();
    if (!isSessionIdle()) {
      deliverEntries([entry], { deliverAs: "followUp" });
      return;
    }
    if (config.autoWakeOnResult !== false && config.backgroundEnabled !== false) {
      scheduleAutoWake(entry, config.autoWakeDebounceMs);
      return;
    }
    deliverEntries([entry], { deliverAs: "nextTurn" });
  };

  /**
   * 用户发新消息 / 停止时取消尚未触发的合并唤醒。
   *
   * 默认把已排队的结果补送出去，不能静默丢掉：它们可能正好在防抖窗口里。
   * 用户停止时传 deliverAs:"nextTurn"，让结果留到下一条消息，而不是塞进
   * 正在被中止的回合。
   */
  const cancelPendingAutoWake = ({ deliver = true, deliverAs } = {}) => {
    if (state.autoWakeTimer) {
      clearTimeout(state.autoWakeTimer);
      state.autoWakeTimer = null;
    }
    // 已发出 triggerTurn、还在等回执的那批：回执不会再来了，结果仍留在
    // pendingAutoWakeEntries 里，继续走下面的补送逻辑。
    clearPendingHostWake();
    const entries = [...pendingAutoWakeEntries.values()]
      .filter((entry) => !entry.delivered && !entry.notified);
    if (!deliver) {
      pendingAutoWakeEntries.clear();
      return;
    }
    if (entries.length === 0) return;
    deliverEntries(entries, { deliverAs: deliverAs || (isSessionIdle() ? "nextTurn" : "followUp") });
  };

  const MAX_RETAINED_BACKGROUND_TASKS = 50;
  const RETAINED_BACKGROUND_TASK_TTL_MS = 60 * 60 * 1000;
  /**
   * 回收已结束的后台任务条目：长会话里 backgroundTasks 只增不删会线性涨内存。
   * 保留最近 50 条、且不超过 1 小时的结果（subagent_send 续聊要用）；
   * 隔离任务登记（isolatedTasks）不在这里删，未 apply 的 worktree 现场要保住。
   */
  const pruneBackgroundTasks = () => {
    if (backgroundTasks.size <= MAX_RETAINED_BACKGROUND_TASKS + 10) return;
    const now = Date.now();
    const terminal = [...backgroundTasks.entries()]
      .filter(([, entry]) => isTerminalBackgroundStatus(entry.status))
      .sort((a, b) => (b[1].completedAt || 0) - (a[1].completedAt || 0));
    const drop = new Set(
      terminal
        .filter(([, entry]) => !entry.completedAt || now - entry.completedAt > RETAINED_BACKGROUND_TASK_TTL_MS)
        .map(([id]) => id),
    );
    for (const [id] of terminal.slice(MAX_RETAINED_BACKGROUND_TASKS)) drop.add(id);
    for (const id of drop) backgroundTasks.delete(id);
  };

  const finalizeBackgroundEntry = (entry, result) => {
    entry.result = isRecord(result) ? result : null;
    // 10 分钟没有事件时在结果里注明「疑似停滞」，由主 Agent/用户判断，
    // 不自动杀进程（大文件读取或长推理也可能长时间没有新事件）。
    if ((entry.maxIdleMs || 0) >= 10 * 60 * 1000 && entry.result) {
      const minutes = Math.round(entry.maxIdleMs / 60000);
      const note = `\n\n[疑似停滞：运行中曾有 ${minutes} 分钟没有任何事件]`;
      entry.result.output = `${entry.result.output || ""}${note}`;
      entry.result.stalled = true;
    }
    entry.completedAt = Date.now();
    entry.lastActivityAt = entry.completedAt;
    entry.status = result?.stopReason === "aborted"
      ? "interrupted"
      : isFailedResult(result)
        ? "error"
        : "completed";
    entry.usage = entry.usage || createUsage();
    addUsage(entry.usage, result?.usage);
    entry.lastRoundUsage = result?.usage || entry.liveUsage || createUsage();
    entry.liveUsage = null;
    entry.model = result?.model || entry.model;
    if (!entry.sessionFile && result?.inheritedSessionFile) {
      // 继承上下文的后台任务把分叉文件留给续聊用。
      entry.sessionFile = result.inheritedSessionFile;
    }
    entry.liveOutput = "";
    entry.currentActivity = result?.currentActivity || entry.currentActivity;
    entry.rounds.push({
      task: entry.lastTask || entry.task,
      model: entry.model,
      status: entry.status,
      output: truncateText(getFinalOutput(result) || result?.errorMessage || "", MAX_TASK_OUTPUT_BYTES),
      usage: entry.lastRoundUsage,
      startedAt: entry.roundStartedAt || entry.startedAt,
      completedAt: entry.completedAt,
    });
    // 外层异常可能导致 todo 永远停在 in_progress；这里兜底回 pending。
    if (entry.todoId) {
      const todoStore = typeof getTodoStore === "function" ? getTodoStore() : null;
      const todo = todoStore?.findTask?.(entry.todoId);
      if (todo && (todo.status === "in_progress" || todo.owner === entry.id)) {
        todoStore.updateTask?.(
          entry.todoId,
          entry.status === "completed"
            ? { status: "completed", lastError: "" }
            : { status: "pending", owner: "", lastError: entry.result?.errorMessage || "子 Agent 未完成" },
        );
        emitPlanUpdate?.(todoStore.getTasks?.() || []);
      }
    }
    writeBackgroundResultFile(entry);
    emitBackgroundEntry(entry, true);
    notifyMainAgent(entry);
    pruneBackgroundTasks();
  };

  const backgroundHint = registeredConfig.backgroundEnabled
    ? "\n\n后台派发：background:true 会立即返回任务 id，子 Agent 在后台运行；结果完成时会通知你。"
    : "";

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `在隔离上下文中委派任务给专用 subagent。可用：${builtinAgentRoster}；也会读取 Pi 用户级和项目级 agent 配置。用户已安装的同名 Pi 扩展优先于此内置 fallback。\n\n${SUBAGENT_DISPATCH_POLICY}${poolHint}${backgroundHint}\n\n标题：每个任务都填 title，用 2~6 字的极简动宾短语概括它（如「补齐静态红点」「审查风险」「迁移红点C组」），只用于界面展示。\n\n超长结果：正文内联只给前面一段并标注「输出已截断」，同时附一行 [完整输出] 文件路径；需要全文时用 Read 读那个文件。`,
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "单任务模式的 agent 名称" },
        task: { type: "string", description: "单任务模式的委派任务" },
        title: { type: "string", description: "给这个子任务的极简标题（如「补齐静态红点」「审查风险」），只用于界面展示，不传给子 Agent。不填则由界面从任务内容推断。" },
        model: { type: "string", description: "可选；只在符合模型池规则时填写（provider/modelId），不填用池内第一项" },
        tasks: {
          type: "array",
          description: "并行任务列表；除非用户明确要求某个时限，否则不要填写 timeoutMs（默认不设超时）",
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              task: { type: "string" },
              title: { type: "string", description: "极简标题（如「补齐静态红点」），只用于界面展示，不传给子 Agent。不填则界面自行推断。" },
              model: { type: "string", description: "可选；只在符合模型池规则时填写（provider/modelId），不填用池内第一项" },
              cwd: { type: "string" },
              timeoutMs: { type: "number", description: "可选；仅在用户明确要求时限时填写，未填写则不设超时；单位为毫秒" },
              isolation: {
                type: "string",
                enum: ["shared", "worktree"],
                description: "worktree=在独立 git 工作区里运行（适合并行改文件）；结束时自动提交，用 subagent_apply 合并回主工作区",
              },
              todoId: { type: "string", description: "可选；绑定 todo_write 里的任务 id：派发时置为 in_progress 并写入 owner，结束时置为 completed" },
              inheritContext: {
                type: "boolean",
                default: false,
                description: "从主会话当前分支分叉，继承全部上下文；token 成本高，只在背景很难转述时才用",
              },
            },
            required: ["agent", "task"],
            additionalProperties: false,
          },
        },
        chain: {
          type: "array",
          description: "串行任务列表；后续任务可使用 {previous} 引用上一环输出；除非用户明确要求某个时限，否则不要填写 timeoutMs（默认不设超时）",
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              task: { type: "string" },
              title: { type: "string", description: "极简标题（如「补齐静态红点」），只用于界面展示，不传给子 Agent。不填则界面自行推断。" },
              model: { type: "string", description: "可选；只在符合模型池规则时填写（provider/modelId），不填用池内第一项" },
              cwd: { type: "string" },
              timeoutMs: { type: "number", description: "可选；仅在用户明确要求时限时填写，未填写则不设超时；单位为毫秒" },
              isolation: {
                type: "string",
                enum: ["shared", "worktree"],
                description: "worktree=在独立 git 工作区里运行（适合并行改文件）；结束时自动提交，用 subagent_apply 合并回主工作区",
              },
              todoId: { type: "string", description: "可选；绑定 todo_write 里的任务 id：派发时置为 in_progress 并写入 owner，结束时置为 completed" },
              inheritContext: {
                type: "boolean",
                default: false,
                description: "从主会话当前分支分叉，继承全部上下文；token 成本高，只在背景很难转述时才用",
              },
            },
            required: ["agent", "task"],
            additionalProperties: false,
          },
        },
        agentScope: { type: "string", enum: ["user", "project", "both"], default: "user" },
        // 兼容旧调用方但不信任模型传入的值；项目 Agent 是否批准由宿主 UI 决定。
        confirmProjectAgents: { type: "boolean", default: true, description: "由宿主控制，模型传入的值不会关闭安全确认" },
        cwd: { type: "string", description: "单任务子进程的工作目录" },
        timeoutMs: { type: "number", description: "可选；仅在用户明确要求时限时填写，未填写则不设超时；单位为毫秒" },
        isolation: {
          type: "string",
          enum: ["shared", "worktree"],
          description: "worktree=在独立 git 工作区里运行；结束时自动提交，用 subagent_apply 合并回主工作区",
        },
        todoId: { type: "string", description: "可选；绑定 todo_write 里的任务 id：派发时置为 in_progress 并写入 owner，结束时置为 completed" },
              inheritContext: {
                type: "boolean",
                default: false,
                description: "从主会话当前分支分叉，继承全部上下文；token 成本高，只在背景很难转述时才用",
              },
        ...(registeredConfig.backgroundEnabled
          ? {
            background: {
              type: "boolean",
              default: false,
              description: "立即返回任务 id，子 Agent 在后台运行；完成时结果会通知你。耗时长且你还有别的事可做时使用。",
            },
          }
          : {}),
      },
      additionalProperties: false,
    },

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = isRecord(rawParams) ? rawParams : {};
      const agentScope = ["user", "project", "both"].includes(params.agentScope) ? params.agentScope : "user";
      const discovery = discoverAgents(ctx?.cwd || process.cwd(), agentDir, agentScope);
      const agents = discovery.agents;
      const agentByName = new Map(agents.map((agent) => [agent.name, agent]));
      const dispatchDefaults = {
        model: getModelName(ctx?.model),
        thinkingLevel: nonEmptyString(ctx?.thinkingLevel),
      };
      const tasks = getTaskItems(params);
      const chain = getChainItems(params);
      const hasSingle = !!nonEmptyString(params.agent) && !!nonEmptyString(params.task);
      const modeCount = Number(hasSingle) + Number(tasks.length > 0) + Number(chain.length > 0);
      const mode = chain.length > 0 ? "chain" : tasks.length > 0 ? "parallel" : "single";
      const details = (results) => makeDetails(mode, agentScope, discovery.projectAgentsDir, results);
      const defaultTimeoutMs = normalizeTaskTimeout(params.timeoutMs);
      const effectiveSubagentConfig = readSubagentConfig();
      if (!effectiveSubagentConfig.enabled) {
        return {
          content: [{ type: "text", text: "内置 SubAgent 已在设置中禁用；重新启用后保存会在此会话生效。" }],
          details: details([]),
          isError: true,
        };
      }

      const wantsBackground = params.background === true;
      if (wantsBackground && effectiveSubagentConfig.backgroundEnabled === false) {
        return {
          content: [{ type: "text", text: "后台运行已在设置中关闭；去掉 background 参数即可同步执行。" }],
          details: details([]),
          isError: true,
        };
      }

      if (modeCount !== 1) {
        const available = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "无可用 agent";
        return {
          content: [{ type: "text", text: `subagent 参数无效：必须且只能选择单任务、并行或 chain 模式。可用 agent：${available}` }],
          details: details([]),
          isError: true,
        };
      }

      if (agentScope === "project" || agentScope === "both") {
        const projectNames = [...requestedAgentNames(params)].filter((name) => agentByName.get(name)?.source === "project");
        if (projectNames.length > 0) {
          // 不能信任模型传入的 confirmProjectAgents:false；没有 UI 也必须 fail closed，
          // 否则仓库里的 .pi/agents/*.md 可以在无用户确认时注入完整系统提示和工具权限。
          if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function") {
            return {
              content: [{ type: "text", text: "无法在当前无 UI 的环境中运行项目级 Agent；请在可信项目中由用户明确批准。" }],
              details: details([]),
              isError: true,
            };
          }
          const approved = await ctx.ui.confirm(
            "运行项目级 Agent？",
            `Agent：${projectNames.join(", ")}\n来源：${discovery.projectAgentsDir || "未知"}\n\nAgent 定义由仓库内容控制，请仅在可信仓库中继续。`,
          );
          if (!approved) {
            return {
              content: [{ type: "text", text: "已取消：用户未批准运行项目级 Agent。" }],
              details: details([]),
              isError: true,
            };
          }
        }
      }

      const nextIsolatedTaskId = () => {
        state.isolatedTaskSeq += 1;
        return `w_${Date.now().toString(36)}${state.isolatedTaskSeq.toString(36)}`;
      };
      const isolationErrorResult = (item, step, agent, message) => ({
        agent: item.agent,
        agentSource: agent.source,
        task: item.task,
        ...(item.title ? { title: item.title } : {}),
        exitCode: 1,
        messages: [],
        output: "",
        stderr: "",
        usage: createUsage(),
        errorMessage: message,
        stopReason: "error",
        step,
      });
      const run = async (item, step, update, runKey = step ?? "single", runSignal = signal, overrides = {}) => {
        const agent = agentByName.get(item.agent);
        if (!agent) {
          const result = {
            agent: item.agent,
            agentSource: "unknown",
            task: item.task,
            ...(item.title ? { title: item.title } : {}),
            exitCode: 1,
            messages: [],
            output: "",
            stderr: "",
            usage: createUsage(),
            errorMessage: `未知 agent：${item.agent}。可用 agent：${agents.map((entry) => entry.name).join(", ")}`,
            stopReason: "error",
            step,
          };
          update?.(result);
          return result;
        }
        const pool = effectiveSubagentConfig.pool || [];
        const poolActive = effectiveSubagentConfig.poolEnabled !== false;
        const requestedModel = item.model;
        // 池关着却收到 model：说明调度方看的是旧说明，或它在替用户做主张。
        // 明确拒绝，别让它以为换了模型其实没换。
        if (requestedModel && !poolActive) {
          const result = {
            agent: item.agent,
            agentSource: agent.source,
            task: item.task,
            ...(item.title ? { title: item.title } : {}),
            exitCode: 1,
            messages: [],
            output: "",
            stderr: "",
            usage: createUsage(),
            errorMessage: "模型池已在设置中关闭，不接受按任务指定模型。去掉 model 参数即可（子 Agent 会跟随主 Agent 当前模型）。",
            stopReason: "error",
            step,
          };
          update?.(result);
          return result;
        }
        // 池外模型直接拒绝，而不是悄悄退回默认：调度方会以为换了模型，
        // 结果和预期对不上却查不出原因。
        if (requestedModel && poolActive && !getPoolEntry(effectiveSubagentConfig, requestedModel)) {
          const result = {
            agent: item.agent,
            agentSource: agent.source,
            task: item.task,
            ...(item.title ? { title: item.title } : {}),
            exitCode: 1,
            messages: [],
            output: "",
            stderr: "",
            usage: createUsage(),
            errorMessage: `模型 ${requestedModel} 不在模型池内。当前可用：${pool.map((entry) => entry.model).join("、") || "（未配置模型池）"}`,
            stopReason: "error",
            step,
          };
          update?.(result);
          return result;
        }
        // agent markdown 里钉死的 model 优先，且不接受按任务改：这类 agent 往往是
        // 专精用途（视觉、特定渠道），让调度方随手覆盖反而会把它弄坏。
        if (agent.model && requestedModel && requestedModel !== agent.model) {
          const result = {
            agent: item.agent,
            agentSource: agent.source,
            task: item.task,
            ...(item.title ? { title: item.title } : {}),
            exitCode: 1,
            messages: [],
            output: "",
            stderr: "",
            usage: createUsage(),
            errorMessage: `agent ${agent.name} 的 markdown 里钉死了 model（${agent.model}），不接受按任务指定。去掉 model 参数即可，或改这个 agent 的定义。`,
            stopReason: "error",
            step,
          };
          update?.(result);
          return result;
        }
        const configuredModel = agent.model
          || requestedModel
          || resolveConfiguredModel(effectiveSubagentConfig, dispatchDefaults.model);
        const effectiveAgent = !configuredModel || configuredModel === agent.model
          ? agent
          : { ...agent, model: configuredModel };
        const acquired = await acquireTaskSlot(runSignal, overrides.onQueued);
        if (!acquired) {
          return {
            agent: item.agent,
            agentSource: agent.source,
            task: item.task,
            ...(item.title ? { title: item.title } : {}),
            exitCode: 1,
            messages: [],
            output: "",
            stderr: "",
            usage: createUsage(),
            errorMessage: "子 Agent 已中断",
            stopReason: "aborted",
            step,
          };
        }
        try {
          // 排队与重试等待也计入超时预算：否则长队列里的任务会在等几分钟后
          // 才重新计时，实际总耗时变成「排队 + 单轮超时」。
          if (overrides.deadline && Date.now() >= overrides.deadline) {
            return {
              agent: item.agent,
              agentSource: agent.source,
              task: item.task,
              ...(item.title ? { title: item.title } : {}),
              exitCode: 1,
              messages: [],
              output: "",
              stderr: "",
              usage: createUsage(),
              errorMessage: "子 Agent 超时：排队等待已耗尽时间预算",
              stopReason: "timeout",
              step,
            };
          }
          const remainingTimeoutMs = overrides.deadline
            ? Math.max(1000, overrides.deadline - Date.now())
            : undefined;
          overrides.onStarted?.();
          let runDefaultCwd = ctx?.cwd || process.cwd();
          let runCwd = item.cwd || (step === undefined ? nonEmptyString(params.cwd) : undefined);
          // 链式任务共用一个隔离工作区：由 chain 分支创建并传入，避免每一环
          // 各建一个、后一环看不到前一环的改动。
          let worktree = isRecord(overrides.worktreeInfo) ? overrides.worktreeInfo : null;
          const ownsWorktree = !worktree;
          let isolatedNote = "";
          if (item.isolation === "worktree" || worktree) {
            const writesFiles = !Array.isArray(agent.tools)
              || agent.tools.some((tool) => WRITE_CAPABLE_TOOL_NAMES.has(String(tool).toLowerCase()));
            if (!writesFiles && !worktree) {
              isolatedNote = "该 agent 是只读的，已忽略 isolation:worktree。";
            } else {
              const baseWorktreeId = overrides.worktreeId || nextIsolatedTaskId();
              // 重试时换一个物理 id：上一次尝试可能已经提交/保留了同名目录，
              // 复用固定 id 会在第二次 create 时直接报「目录已存在」。
              const worktreeTaskId = overrides.attempt
                ? `${baseWorktreeId}-r${overrides.attempt}`
                : baseWorktreeId;
              try {
                if (!worktree) {
                  worktree = await createSubagentWorktree({
                    projectCwd: runDefaultCwd,
                    baseDir: worktreeBaseDir,
                    taskId: worktreeTaskId,
                  });
                  worktree.id = worktreeTaskId;
                }
                if (runCwd) {
                  const sourceRoot = resolve(runDefaultCwd);
                  const absoluteCwd = resolve(sourceRoot, runCwd);
                  const relativeCwd = relative(sourceRoot, absoluteCwd);
                  if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`) || isAbsolute(relativeCwd)) {
                    throw new Error("SubAgent 工作目录必须位于当前项目目录内。");
                  }
                  runCwd = join(worktree.rootPath, relativeCwd);
                }
                runDefaultCwd = worktree.rootPath;
              } catch (error) {
                return isolationErrorResult(
                  item,
                  step,
                  agent,
                  `创建隔离工作区失败：${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          }
          // P4：把任务绑定到 todo 列表。只作提示与状态同步，不改变执行条件。
          const todoStore = typeof getTodoStore === "function" ? getTodoStore() : null;
          const todoId = nonEmptyString(item.todoId);
          const todoTaskId = overrides.taskId || (todoId ? nextBackgroundTaskId() : "");
          let todoWarning = "";
          if (todoId && todoStore) {
            const todo = todoStore.findTask?.(todoId)
              || todoStore.getTasks?.().find((task) => task.id === todoId);
            if (todo) {
              const blockedBy = Array.isArray(todo.blockedBy) ? todo.blockedBy : [];
              const unfinished = blockedBy.filter((depId) => {
                const dep = todoStore.findTask?.(depId)
                  || todoStore.getTasks?.().find((task) => task.id === depId);
                return dep && dep.status !== "completed";
              });
              if (unfinished.length > 0) {
                todoWarning = `依赖任务尚未完成：${unfinished.join("、")}（仅提示，不阻止执行）`;
              }
              todoStore.updateTask?.(todoId, { status: "in_progress", owner: todoTaskId, lastError: "" });
              emitPlanUpdate?.(todoStore.getTasks?.() || []);
            } else {
              todoWarning = `todoId ${todoId} 不在当前任务列表里，已忽略绑定。`;
            }
          }
          // P5：继承上下文的分叉子 Agent。每个任务拿一份独立分叉，避免并行任务
          // 共享同一个会话文件、互相污染。
          let inheritedSessionFile = overrides.sessionFile || "";
          if (item.inheritContext && !inheritedSessionFile) {
            try {
              inheritedSessionFile = String(createInheritedSession?.() || "");
            } catch {
              inheritedSessionFile = "";
            }
            if (!inheritedSessionFile) {
              // 已经创建的 worktree 和已置为 in_progress 的 todo 都要回滚，
              // 不能因为一个参数不可用就留下分支目录和永久进行中的任务。
              if (worktree && ownsWorktree) {
                try { await removeSubagentWorktree(worktree); } catch { /* ignore */ }
              }
              if (todoId && todoStore) {
                todoStore.updateTask?.(todoId, {
                  status: "pending",
                  owner: "",
                  lastError: "无法创建继承上下文的分叉会话",
                });
                emitPlanUpdate?.(todoStore.getTasks?.() || []);
              }
              return isolationErrorResult(item, step, agent, "当前会话尚未落盘或无法分叉，inheritContext 不可用；请去掉该参数后重试。");
            }
          }
          const result = await runSingleAgent({
            defaultCwd: runDefaultCwd,
            dispatchDefaults,
            agent: effectiveAgent,
            task: item.task,
            title: item.title,
            cwd: runCwd,
            step,
            signal: runSignal,
            onUpdate: update,
            makeDetails: (results) => details(results),
            packageRoot,
            agentDir,
            hostSystemPrompt,
            nodePath,
            permissionMode: typeof getPermissionMode === "function" ? getPermissionMode() : "auto",
            requestUI: ctx?.hasUI ? requestUI : undefined,
            dismissUI: ctx?.hasUI ? dismissUI : undefined,
            ownerId: `${_toolCallId}:${runKey}:${item.agent}`,
            bridgeExtensionPath,
            // 0 = 不设超时，是合法值：`||` 会让它让位给默认值，必须用 `??`。
            // 有 deadline 时用剩余预算，把排队/重试消耗的时间扣掉。
            timeoutMs: remainingTimeoutMs ?? (overrides.timeoutMs ?? item.timeoutMs ?? defaultTimeoutMs),
            sessionFile: inheritedSessionFile || "",
          });
          if (todoId && todoStore) {
            if (isFailedResult(result)) {
              todoStore.updateTask?.(todoId, {
                status: "pending",
                owner: "",
                // lastError 会跟着 plan_update 走 IPC：只留一小段原因，
                // 别把完整的几十 KB 输出塞进计划事件里。
                lastError: truncateText(getResultOutput(result), MAX_TASK_OUTPUT_BYTES),
              });
            } else {
              todoStore.updateTask?.(todoId, { status: "completed", lastError: "" });
            }
            emitPlanUpdate?.(todoStore.getTasks?.() || []);
          }
          if (todoWarning) result.todoWarning = todoWarning;
          if (item.inheritContext && inheritedSessionFile) result.inheritedSessionFile = inheritedSessionFile;
          if (isolatedNote) result.isolatedNote = isolatedNote;
          if (worktree && ownsWorktree) {
            try {
              // 被用户中断的任务不提交半成品：直接清掉隔离工作区。
              const interrupted = result.stopReason === "aborted" || result.stopReason === "interrupted";
              const info = await finalizeSubagentWorktree(worktree, { taskId: worktree.id, discard: interrupted });
              result.worktree = {
                id: worktree.id,
                branch: info.branch,
                path: info.worktreePath,
                changed: info.changed === true,
                ...(info.discarded ? { discarded: true } : {}),
                ...(info.retained ? { retained: true, ignoredFiles: info.ignoredFiles } : {}),
                ...(info.diffStat ? { diffStat: info.diffStat } : {}),
              };
              isolatedTasks.set(worktree.id, {
                id: worktree.id,
                worktree: info,
                agent: item.agent,
                task: item.task,
                status: info.changed ? "completed" : "clean",
              });
              // 后台任务表也挂一份，续聊前据此判断隔离分支是否还没合并。
              const ownerEntry = overrides.worktreeId ? backgroundTasks.get(overrides.worktreeId) : null;
              if (ownerEntry) ownerEntry.worktree = info;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              result.worktree = {
                id: worktree.id,
                branch: worktree.branch,
                path: worktree.worktreePath,
                changed: true,
                error: `提交隔离工作区失败：${message}`,
              };
              isolatedTasks.set(worktree.id, {
                id: worktree.id,
                worktree,
                agent: item.agent,
                task: item.task,
                status: "error",
              });
            }
          }
          return result;
        } finally {
          releaseTaskSlot();
        }
      };

      const discardAttemptWorktree = async (result) => {
        const id = result?.worktree?.id;
        if (!id) return;
        const record = isolatedTasks.get(id);
        if (record?.worktree) {
          try { await removeSubagentWorktree(record.worktree); } catch { /* ignore */ }
        }
        isolatedTasks.delete(id);
        for (const entry of backgroundTasks.values()) {
          if (entry.worktree?.id === id) entry.worktree = null;
        }
      };

      /**
       * 带重试的执行：撞上可重试的上游错误（overloaded / 限流 / 5xx）时重跑，间隔带抖动。
       *
       * 为什么退到外层重跑，而不是指望子进程内的重试：pi 自己会重试 3 次（`retry.enabled`
       * 默认 true、固定 2s 起），但并行跑的几个子进程是**同时**重试的，同步捶上游正是
       * overloaded 不退的原因之一。这里间隔更长、且加抖动把各个子进程的重试时刻错开。
       */
      const runWithRetry = async (item, step, update, runKey = step ?? "single", runSignal = signal, overrides = {}) => {
        const budget = overrides.timeoutMs ?? item.timeoutMs ?? defaultTimeoutMs;
        // 0 = 不设超时；正数才建 deadline，排队与重试共享同一个截止时间。
        const deadline = budget > 0 ? Date.now() + budget : 0;
        const withDeadline = (extra) => ({
          ...overrides,
          ...(deadline > 0 ? { deadline } : {}),
          ...extra,
        });
        let result = await run(item, step, update, runKey, runSignal, withDeadline({ attempt: 0 }));
        let attempt = 0;
        while (attempt < retryDelaysMs.length && isRetryableSubagentFailure(result)) {
          const next = attempt + 1;
          // 写进 currentActivity，并行/链式/单个三条路径的进度文案都会把它带出来。
          result.currentActivity = `上游错误，等待第 ${next}/${retryDelaysMs.length} 次重试…`;
          update?.({
            content: [{ type: "text", text: truncateText(`[${result.agent || item.agent}] ${getResultOutput(result)}`, MAX_TASK_OUTPUT_BYTES) }],
            details: details([result]),
          });
          if (!await waitBeforeRetry(attempt, runSignal, retryDelaysMs) || runSignal?.aborted) {
            result.exitCode = 1;
            result.stopReason = "aborted";
            result.errorMessage = "子 Agent 已中断";
            result.currentActivity = result.errorMessage;
            break;
          }
          // 上一次尝试留下的 worktree/分支先回收，再用新 id 重跑。
          await discardAttemptWorktree(result);
          const retried = await run(item, step, update, runKey, runSignal, withDeadline({ attempt: next }));
          retried.retries = next;
          // 重试是同一个任务的重来：耗时按首次启动算，否则监视窗会显示成刚跑不久。
          retried.startedAt = result.startedAt || retried.startedAt;
          result = retried;
          attempt = next;
        }
        return result;
      };

      const createBackgroundEntry = ({
        item,
        kind,
        step,
        task = item.task,
        title = item.title,
        sessionIndex,
      }) => {
        const id = nextBackgroundTaskId();
        const taskDir = getSubagentTaskDir();
        const entry = {
          id,
          status: "queued",
          kind,
          toolCallId: _toolCallId,
          agent: item.agent,
          agentPinnedModel: agentByName.get(item.agent)?.model,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          task,
          lastTask: task,
          title,
          model: item.model,
          cwd: item.cwd,
          isolation: item.isolation,
          todoId: item.todoId,
          inheritContext: item.inheritContext === true,
          step,
          runKey: id,
          // 显式 timeoutMs 必须生效（≤30min 的前台口径）；未指定时才用后台
          // 任务的默认预算（backgroundTimeoutMs，最多 2h）。
          timeoutMs: item.timeoutMs !== undefined
            ? normalizeTaskTimeout(item.timeoutMs)
            : effectiveSubagentConfig.backgroundTimeoutMs,
          sessionFile: item.inheritContext || !taskDir
            ? ""
            : join(taskDir, sessionIndex === undefined ? `${id}.jsonl` : `${id}-${sessionIndex}.jsonl`),
          resultFile: taskDir ? join(taskDir, `${id}.result.md`) : "",
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          completedAt: undefined,
          usage: createUsage(),
          currentActivity: "等待执行…",
          liveOutput: "",
          rounds: [],
          result: null,
          controller: new AbortController(),
          delivered: false,
          notified: false,
          continuable: kind !== "chain",
          eventTimer: null,
        };
        backgroundTasks.set(id, entry);
        // 后台首轮与后续续聊共用同一个入口：runWithRetry 内部会走并发额度、
        // 模型校验和重试。send 工具拿到的也是这个函数。
        entry.runRound = ({
          task = entry.task,
          model = entry.model,
          signal: roundSignal = entry.controller.signal,
          onUpdate: roundUpdate,
          sessionFile = entry.sessionFile,
        } = {}) => runWithRetry(
          { agent: entry.agent, task, title: entry.title, model, cwd: entry.cwd, isolation: entry.isolation, todoId: entry.todoId, inheritContext: entry.inheritContext },
          entry.step,
          roundUpdate,
          entry.runKey,
          roundSignal,
          {
            timeoutMs: entry.timeoutMs,
            sessionFile,
            // 后台任务的工作区必须绑定任务 id，subagent_apply 才能找回现场。
            worktreeId: entry.id,
            taskId: entry.id,
            background: true,
            onQueued: () => {
              entry.status = "queued";
              entry.currentActivity = "排队中…";
              scheduleBackgroundEvent(entry);
            },
            onStarted: () => {
              entry.status = "running";
              entry.currentActivity = `正在启动 ${entry.agent}…`;
              scheduleBackgroundEvent(entry);
            },
          },
        );
        return entry;
      };

      const launchBackgroundEntry = (entry) => {
        emitBackgroundEntry(entry, false);
        void (async () => {
          const onUpdate = makeBackgroundUpdate(entry);
          try {
            const result = await entry.runRound({ signal: entry.controller.signal, onUpdate });
            finalizeBackgroundEntry(entry, result);
          } catch (error) {
            finalizeBackgroundEntry(entry, {
              agent: entry.agent,
              task: entry.task,
              exitCode: 1,
              messages: [],
              output: "",
              stderr: "",
              usage: entry.usage,
              model: entry.model,
              stopReason: "error",
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      };

      if (wantsBackground) {
        if (tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: "text", text: `并行任务数量过多：${tasks.length}，最多支持 ${MAX_PARALLEL_TASKS} 个。` }],
            details: details([]),
            isError: true,
          };
        }
        const entries = [];
        if (chain.length > 0) {
          const entry = createBackgroundEntry({
            item: { agent: "chain", task: chain.map((item) => item.agent).join(" → "), title: chain[0]?.title, cwd: undefined, model: undefined },
            kind: "chain",
            task: chain.map((item) => item.task).join("\n→ "),
            title: chain[0]?.title,
          });
          // chain 的每一环是不同 agent，续聊语义不明确，先不开放 subagent_send。
          entry.continuable = false;
          entry.runRound = async ({ signal: roundSignal, onUpdate: roundUpdate }) => {
            let previous = "";
            let last = null;
            let chainWorktree = null;
            if (chain.some((item) => item.isolation === "worktree")) {
              // 自定义 cwd 必须先过项目边界校验：否则模型可以让隔离工作区
              // 建到任意 git 仓库上，subagent 就能在项目外改文件。
              let chainProjectCwd = ctx?.cwd || process.cwd();
              const requestedChainCwd = nonEmptyString(params.cwd);
              if (requestedChainCwd) {
                try {
                  chainProjectCwd = resolveSubagentCwd(requestedChainCwd, chainProjectCwd).projectRoot;
                } catch (error) {
                  const message = `chain 工作目录无效：${error instanceof Error ? error.message : String(error)}`;
                  return {
                    agent: "chain",
                    task: entry.task,
                    exitCode: 1,
                    messages: [],
                    // output 也要写：通用结果格式化只取 output，errorMessage 不一定会展示。
                    output: message,
                    stderr: "",
                    usage: createUsage(),
                    stopReason: "error",
                    errorMessage: message,
                  };
                }
              }
              try {
                chainWorktree = await createSubagentWorktree({
                  projectCwd: chainProjectCwd,
                  baseDir: worktreeBaseDir,
                  taskId: entry.id,
                });
                chainWorktree.id = entry.id;
              } catch (error) {
                return {
                  agent: "chain",
                  task: entry.task,
                  exitCode: 1,
                  messages: [],
                  output: "",
                  stderr: "",
                  usage: createUsage(),
                  stopReason: "error",
                  errorMessage: `创建隔离工作区失败：${error instanceof Error ? error.message : String(error)}`,
                };
              }
            }
            try {
              for (let index = 0; index < chain.length; index += 1) {
                const item = chain[index];
                const current = { ...item, task: item.task.replace(/\{previous\}/g, previous) };
                last = await runWithRetry(current, index + 1, (partial) => {
                  const partialResult = getPartialResultFromUpdate(partial) || partial;
                  roundUpdate?.({
                    content: [{ type: "text", text: truncateText(getFinalOutput(partialResult) || partialResult.message || "正在运行…", MAX_TASK_OUTPUT_BYTES) }],
                    details: details([partialResult]),
                  });
                }, index, roundSignal, {
                  timeoutMs: entry.timeoutMs,
                  // 只有最后一环写入续聊会话，避免不同 agent 的上下文混在一起。
                  sessionFile: index === chain.length - 1 ? entry.sessionFile : "",
                  ...(chainWorktree ? { worktreeInfo: chainWorktree, worktreeId: entry.id } : {}),
                });
                if (isFailedResult(last)) break;
                previous = getFinalOutput(last);
              }
              return last;
            } finally {
              if (chainWorktree) {
                try {
                  const interrupted = last?.stopReason === "aborted"
                    || last?.stopReason === "interrupted"
                    || entry.stopRequested === true;
                  const info = await finalizeSubagentWorktree(chainWorktree, {
                    taskId: entry.id,
                    discard: interrupted,
                  });
                  entry.worktree = info;
                  if (last) {
                    last.worktree = {
                      id: entry.id,
                      branch: info.branch,
                      path: info.worktreePath,
                      changed: info.changed === true,
                      ...(info.discarded ? { discarded: true } : {}),
                      ...(info.retained ? { retained: true, ignoredFiles: info.ignoredFiles } : {}),
                      ...(info.diffStat ? { diffStat: info.diffStat } : {}),
                    };
                  }
                  isolatedTasks.set(entry.id, {
                    id: entry.id,
                    worktree: info,
                    agent: "chain",
                    task: entry.task,
                    status: info.changed ? "completed" : "clean",
                  });
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  entry.worktree = { ...chainWorktree, error: message };
                  if (last) {
                    last.worktree = {
                      id: entry.id,
                      branch: chainWorktree.branch,
                      path: chainWorktree.worktreePath,
                      changed: true,
                      error: `提交隔离工作区失败：${message}`,
                    };
                  }
                }
              }
            }
          };
          entries.push(entry);
        } else if (tasks.length > 0) {
          for (const item of tasks) {
            entries.push(createBackgroundEntry({ item, kind: "parallel" }));
          }
        } else {
          const item = {
            agent: nonEmptyString(params.agent) || "",
            task: nonEmptyString(params.task) || "",
            title: nonEmptyString(params.title),
            cwd: nonEmptyString(params.cwd),
            model: nonEmptyString(params.model),
            isolation: params.isolation === "worktree" ? "worktree" : undefined,
            todoId: nonEmptyString(params.todoId),
            inheritContext: params.inheritContext === true,
          };
          entries.push(createBackgroundEntry({ item, kind: "single" }));
        }
        for (const entry of entries) launchBackgroundEntry(entry);
        return {
          content: [{
            type: "text",
            text: [
              `已在后台启动 ${entries.length} 个子任务：`,
              ...entries.map((entry) => `- ${entry.id} ${entry.agent}${entry.title ? ` · ${entry.title}` : ""}`),
              "",
              "需要结果时调用 subagent_wait；任务结束时会通知你，不要空等轮询。",
            ].join("\n"),
          }],
          details: buildBackgroundDetails(entries),
        };
      }

      if (chain.length > 0) {
        const results = [];
        let previous = "";
        // 链式隔离：整条链共用一个 worktree，后续环节能看到前面环节的改动。
        let chainWorktree = null;
        let chainNote = "";
        if (chain.some((item) => item.isolation === "worktree")) {
          const writable = chain.some((item) => {
            const chainAgent = agentByName.get(item.agent);
            return !Array.isArray(chainAgent?.tools)
              || chainAgent.tools.some((tool) => WRITE_CAPABLE_TOOL_NAMES.has(String(tool).toLowerCase()));
          });
          if (!writable) {
            chainNote = "链里只有只读 agent，已忽略 isolation:worktree。";
          } else {
            try {
              const chainTaskId = nextIsolatedTaskId();
              chainWorktree = await createSubagentWorktree({
                projectCwd: ctx?.cwd || process.cwd(),
                baseDir: worktreeBaseDir,
                taskId: chainTaskId,
              });
              chainWorktree.id = chainTaskId;
            } catch (error) {
              return {
                content: [{ type: "text", text: `创建隔离工作区失败：${error instanceof Error ? error.message : String(error)}` }],
                details: details([]),
                isError: true,
              };
            }
          }
        }
        try {
          for (let index = 0; index < chain.length; index += 1) {
            const item = chain[index];
            const current = { ...item, task: item.task.replace(/\{previous\}/g, previous) };
            const result = await runWithRetry(current, index + 1, (partial) => {
              const partialResult = getPartialResultFromUpdate(partial) || partial;
              onUpdate?.({
                content: [{ type: "text", text: truncateText(getFinalOutput(partialResult) || partialResult.message || "正在运行…", MAX_TASK_OUTPUT_BYTES) }],
                details: details([...results, partialResult]),
              });
            }, index, signal, chainWorktree ? { worktreeInfo: chainWorktree, worktreeId: chainWorktree.id } : {});
            results.push(result);
            if (isFailedResult(result)) {
              // 失败步骤的内联预算只有 8KB，中间步骤的 output 在 details 里也被
              // 截到 8KB：所有步骤都按 8KB 阈值落盘，保证任何一步的长输出
              // 都有全文出口（以前只落失败那一步）。
              results.forEach((entry) => persistLongResult(entry, MAX_TASK_OUTPUT_BYTES));
              return {
                content: [{ type: "text", text: `Chain 在第 ${index + 1} 步（${item.agent}）停止：${truncateText(getResultOutput(result), MAX_TASK_OUTPUT_BYTES)}${chainNote}${formatResultFiles(results)}` }],
                details: details(results),
                isError: true,
              };
            }
            previous = getFinalOutput(result);
          }
          const lastResult = results[results.length - 1];
          // 最后一步的内联预算是 32KB；中间步骤只在 details 里（截到 8KB）。
          // 按各自的预算落盘，任何一步的超长输出都能按路径读到全文。
          results.forEach((entry, index) => persistLongResult(
            entry,
            index === results.length - 1 ? MAX_TOOL_OUTPUT_BYTES : MAX_TASK_OUTPUT_BYTES,
          ));
          return {
            content: [{
              type: "text",
              text: truncateText(getFinalOutput(lastResult) || "无输出", MAX_TOOL_OUTPUT_BYTES)
                + chainNote
                + formatWorktreeNote(lastResult?.worktree)
                + formatResultFiles(results),
            }],
            details: details(results),
          };
        } finally {
          if (chainWorktree) {
            try {
              const info = await finalizeSubagentWorktree(chainWorktree, { taskId: chainWorktree.id });
              const summary = {
                id: chainWorktree.id,
                branch: info.branch,
                path: info.worktreePath,
                changed: info.changed === true,
                ...(info.diffStat ? { diffStat: info.diffStat } : {}),
              };
              if (results.length > 0) results[results.length - 1].worktree = summary;
              isolatedTasks.set(chainWorktree.id, {
                id: chainWorktree.id,
                worktree: info,
                agent: "chain",
                task: chain.map((item) => item.task).join("\n→ "),
                status: info.changed ? "completed" : "clean",
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (results.length > 0) {
                results[results.length - 1].worktree = {
                  id: chainWorktree.id,
                  branch: chainWorktree.branch,
                  path: chainWorktree.worktreePath,
                  changed: true,
                  error: `提交隔离工作区失败：${message}`,
                };
              }
            }
          }
        }
      }

      if (tasks.length > 0) {
        if (tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: "text", text: `并行任务数量过多：${tasks.length}，最多支持 ${MAX_PARALLEL_TASKS} 个。` }],
            details: details([]),
            isError: true,
          };
        }
        const allResults = tasks.map((item) => ({
          agent: item.agent,
          agentSource: "unknown",
          task: item.task,
          ...(item.title ? { title: item.title } : {}),
          exitCode: -1,
          messages: [],
          output: "",
          currentActivity: "等待执行…",
          stderr: "",
          usage: createUsage(),
        }));
        const emitParallelUpdate = () => onUpdate?.({
          content: [{ type: "text", text: `并行任务：${allResults.filter((result) => typeof result.exitCode === "number" && result.exitCode !== -1).length}/${allResults.length} 已完成` }],
          details: details(allResults),
        });
        emitParallelUpdate();
        const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, (item, index) => runWithRetry(item, undefined, (partial) => {
          const partialResult = getPartialResultFromUpdate(partial);
          if (partialResult) allResults[index] = partialResult;
          emitParallelUpdate();
        }, index));
        const successCount = results.filter((result) => !isFailedResult(result)).length;
        // 每个子任务分一份总预算。原先各自按 MAX_TASK_OUTPUT_BYTES(8KB) 截断、拼完再按
        // MAX_TOOL_OUTPUT_BYTES(32KB) 整体截一次：任务数一多，前面的就把 32KB 吃光，
        // 后面的整段被静默丢掉（8 个任务时只有前 4 个到得了模型）。留 512 字节给标题与分隔符。
        const perTaskBudget = Math.max(
          1024,
          Math.floor((MAX_TOOL_OUTPUT_BYTES - 512) / Math.max(1, results.length)),
        );
        const summary = results.map((result) => {
          const status = isFailedResult(result) ? "failed" : "completed";
          return `### [${result.agent}] ${status}\n\n${truncateText(getResultOutput(result), perTaskBudget)}${formatResultNotes(result)}`;
        }).join("\n\n---\n\n");
        // 并行时每个任务的内联预算被摊薄（8 个任务只剩 ~4KB），长报告几乎必被截；
        // 路径清单放在整体截断之后，保证每一份都能被找到。
        results.forEach((result) => persistLongResult(result, perTaskBudget));
        return {
          content: [{ type: "text", text: truncateText(`Parallel：${successCount}/${results.length} 成功\n\n${summary}`, MAX_TOOL_OUTPUT_BYTES) + formatResultFiles(results) }],
          details: details(results),
          isError: successCount !== results.length,
        };
      }

      const item = {
        agent: nonEmptyString(params.agent) || "",
        task: nonEmptyString(params.task) || "",
        title: nonEmptyString(params.title),
        cwd: nonEmptyString(params.cwd),
        model: nonEmptyString(params.model),
        isolation: params.isolation === "worktree" ? "worktree" : undefined,
        todoId: nonEmptyString(params.todoId),
        inheritContext: params.inheritContext === true,
      };
      const result = await runWithRetry(item, undefined, onUpdate ? (partial) => {
        const partialResult = getPartialResultFromUpdate(partial) || partial;
        onUpdate({
          content: [{ type: "text", text: truncateText(getFinalOutput(partialResult) || partialResult.message || "正在运行…", MAX_TASK_OUTPUT_BYTES) }],
          details: details([partialResult]),
        });
      } : undefined);
      persistLongResult(result, MAX_TOOL_OUTPUT_BYTES);
      if (isFailedResult(result)) {
        return {
          content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}：${truncateText(getResultOutput(result), MAX_TOOL_OUTPUT_BYTES)}${formatResultNotes(result)}${formatResultFiles(result)}` }],
          details: details([result]),
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: truncateText(getFinalOutput(result) || "无输出", MAX_TOOL_OUTPUT_BYTES) + formatResultNotes(result) + formatResultFiles(result) }],
        details: details([result]),
      };
    },
  });

  pi.registerTool({
    name: "subagent_apply",
    label: "Apply Subagent Worktree",
    description: "把 isolation:worktree 子任务的改动合并回主工作区（git apply --3way）。成功后自动清理 worktree 和分支；冲突时列出文件。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "隔离任务 id（sa_ / w_ 开头，见任务结果里的 worktree.id）" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams) {
      const params = isRecord(rawParams) ? rawParams : {};
      const id = nonEmptyString(params.id) || "";
      const isolated = isolatedTasks.get(id);
      const entry = backgroundTasks.get(id);
      if (!isolated && !entry) {
        return {
          content: [{ type: "text", text: `未知的隔离任务：${id || "(空)"}` }],
          details: { version: 1, worktree: null },
          isError: true,
        };
      }
      const info = isolated?.worktree || entry?.worktree;
      if (!info) {
        return {
          content: [{ type: "text", text: `任务 ${id} 没有可用的隔离工作区（可能已应用或创建失败）。` }],
          details: { version: 1, worktree: entry?.result?.worktree || null },
          isError: true,
        };
      }
      if (info.changed !== true) {
        const ignoredFiles = Array.isArray(info.ignoredFiles) ? info.ignoredFiles : [];
        return {
          content: [{
            type: "text",
            text: ignoredFiles.length > 0
              ? `任务 ${id} 只有被 .gitignore 忽略的产物（${ignoredFiles.slice(0, 8).join("、")}${ignoredFiles.length > 8 ? " 等" : ""}），未自动提交；工作区保留在 ${info.worktreePath}。`
              : `任务 ${id} 没有产生文件改动，无需应用。`,
          }],
          details: { version: 1, worktree: { id, changed: false, ...(ignoredFiles.length > 0 ? { retained: true, ignoredFiles } : {}) } },
        };
      }
      try {
        const result = await applySubagentWorktree(info, { taskId: id });
        if (!result.applied) {
          return {
            content: [{
              type: "text",
              text: [
                `合并 ${id} 失败${result.reason === "conflict" ? "（冲突）" : ""}。`,
                ...(result.files.length > 0 ? [`冲突文件：${result.files.join("、")}`] : []),
                ...(result.unmergedFiles?.length ? [`未合并文件：${result.unmergedFiles.join("、")}`] : []),
                ...(result.stagedFiles?.length ? [`已暂存文件：${result.stagedFiles.join("、")}`] : []),
                result.error ? `原因：${result.error}` : "",
                result.recovery ? `恢复这些文件的本地版本：${result.recovery}` : "",
                "冲突需要主 Agent 手动处理；隔离工作区与分支已保留。",
              ].filter(Boolean).join("\n"),
            }],
            details: {
              version: 1,
              worktree: {
                id,
                changed: true,
                applied: false,
                files: result.files,
                ...(result.unmergedFiles?.length ? { unmergedFiles: result.unmergedFiles } : {}),
                ...(result.stagedFiles?.length ? { stagedFiles: result.stagedFiles } : {}),
              },
            },
            isError: true,
          };
        }
        const cleanup = result.cleanup;
        const cleanupFailed = !!cleanup && (cleanup.removed === false || cleanup.branchDeleted === false);
        isolatedTasks.delete(id);
        if (entry?.result?.worktree) entry.result.worktree.applied = true;
        if (entry?.worktree) entry.worktree.applied = true;
        return {
          content: [{
            type: "text",
            text: cleanupFailed
              ? `已把 ${id} 的改动合并回主工作区；但 worktree/分支未完全清理${cleanup.error ? `（${cleanup.error}）` : ""}，请手动检查 ${info.worktreePath}。`
              : `已把 ${id} 的改动合并回主工作区，worktree 与分支已清理。`,
          }],
          details: {
            version: 1,
            worktree: {
              id,
              changed: true,
              applied: true,
              ...(cleanupFailed ? { cleanup } : {}),
            },
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `合并 ${id} 失败：${error instanceof Error ? error.message : String(error)}` }],
          details: { version: 1, worktree: { id, changed: true, applied: false } },
          isError: true,
        };
      }
    },
  });

  const formatBackgroundResults = (results) => results.map((result) => {
    const statusText = result.status === "completed"
      ? "已完成"
      : result.status === "interrupted"
        ? "已中断"
        : result.status === "error"
          ? "失败"
          : result.status === "queued"
            ? "排队中"
            : "运行中";
    return `- ${result.id} [${statusText}] ${result.agent}${result.title ? ` · ${result.title}` : ""}`;
  }).join("\n");

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait Subagents",
    description: "等待后台子任务结束（或只看当前状态）。ids 不填时等待所有未结束的后台任务；timeoutMs:0 只查状态。",
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "要等待的任务 id；不填则等待全部未结束任务" },
        timeoutMs: { type: "number", default: 30000, description: "最长等待毫秒数；0 表示只查状态" },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams) {
      const params = isRecord(rawParams) ? rawParams : {};
      const requestedIds = Array.isArray(params.ids)
        ? params.ids.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
      const missing = requestedIds.filter((id) => !backgroundTasks.has(id));
      if (missing.length > 0) {
        return {
          content: [{ type: "text", text: `未知的后台任务：${missing.join("、")}` }],
          details: { version: 1, background: true, results: [] },
          isError: true,
        };
      }
      const targets = requestedIds.length > 0
        ? requestedIds.map((id) => backgroundTasks.get(id))
        : [...backgroundTasks.values()].filter((entry) => !isTerminalBackgroundStatus(entry.status));
      const timeoutRaw = Number(params.timeoutMs);
      const timeout = Number.isFinite(timeoutRaw) ? Math.min(600_000, Math.max(0, timeoutRaw)) : 30_000;
      const deadline = Date.now() + timeout;
      while (timeout > 0 && targets.some((entry) => !isTerminalBackgroundStatus(entry.status)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      // 已被 wait 取走的结果不再触发完成通知，避免主 Agent 收到重复内容。
      for (const entry of targets) {
        if (isTerminalBackgroundStatus(entry.status)) entry.delivered = true;
      }
      const results = targets.map(toBackgroundResult);
      const done = results.filter((result) => isTerminalBackgroundStatus(result.status)).length;
      return {
        content: [{
          type: "text",
          text: targets.length === 0
            ? "当前没有运行中的后台子任务。"
            : `后台任务：${done}/${targets.length} 已结束\n${formatBackgroundResults(results)}`,
        }],
        details: buildBackgroundDetails(targets),
      };
    },
  });

  pi.registerTool({
    name: "subagent_stop",
    label: "Stop Subagent",
    description: "停止一个正在运行的后台子任务。只终止该子任务的进程树，不影响主会话。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "要停止的后台任务 id（sa_ 开头）" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams) {
      const params = isRecord(rawParams) ? rawParams : {};
      const id = nonEmptyString(params.id) || "";
      const entry = backgroundTasks.get(id);
      if (!entry) {
        return {
          content: [{ type: "text", text: `未知的后台任务：${id || "(空)"}` }],
          details: { version: 1, background: true, results: [] },
          isError: true,
        };
      }
      if (isTerminalBackgroundStatus(entry.status)) {
        return {
          content: [{ type: "text", text: `任务 ${id} 已经结束（${entry.status}），无需停止。` }],
          details: buildBackgroundDetails([entry]),
        };
      }
      // 主 Agent 主动停止后不再补一条完成通知。
      entry.delivered = true;
      entry.stopRequested = true;
      try { entry.controller?.abort(); } catch { /* ignore */ }
      return {
        content: [{ type: "text", text: `已请求停止 ${id}；正在回收子进程。` }],
        details: buildBackgroundDetails([entry]),
      };
    },
  });

  const splitModelProvider = (model) => {
    const separator = String(model || "").indexOf("/");
    return separator > 0 ? model.slice(0, separator) : "";
  };

  pi.registerTool({
    name: "subagent_send",
    label: "Send to Subagent",
    description: "对已经结束的后台子任务追加一轮对话（续聊）。默认沿用该任务上一轮实际使用的模型；只有明确传 model 才换。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "后台任务 id（sa_ 开头）" },
        message: { type: "string", description: "追加给该子 Agent 的消息" },
        model: { type: "string", description: "可选；只在符合模型池规则时填写，不填沿用上一轮模型" },
        background: { type: "boolean", default: true, description: "true（默认）立即返回，结束后通知；false 则同步等待本轮结果" },
      },
      required: ["id", "message"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams, signal) {
      const params = isRecord(rawParams) ? rawParams : {};
      const id = nonEmptyString(params.id) || "";
      const message = nonEmptyString(params.message) || "";
      const entry = backgroundTasks.get(id);
      if (!entry) {
        return {
          content: [{ type: "text", text: `未知的后台任务：${id || "(空)"}` }],
          details: { version: 1, background: true, results: [] },
          isError: true,
        };
      }
      if (!message) {
        return {
          content: [{ type: "text", text: "subagent_send 需要非空的 message。" }],
          details: buildBackgroundDetails([entry]),
          isError: true,
        };
      }
      if (!isTerminalBackgroundStatus(entry.status)) {
        return {
          content: [{ type: "text", text: `任务 ${id} 仍在运行；先 subagent_wait 等它结束，或 subagent_stop 停止后再续聊。` }],
          details: buildBackgroundDetails([entry]),
          isError: true,
        };
      }
      if (!entry.continuable) {
        return {
          content: [{ type: "text", text: `任务 ${id} 是 chain，不同环节使用不同 agent，暂不支持续聊；请重新派发一个任务。` }],
          details: buildBackgroundDetails([entry]),
          isError: true,
        };
      }
      if (entry.worktree?.changed === true && entry.worktree?.applied !== true) {
        return {
          content: [{
            type: "text",
            text: `任务 ${id} 的隔离工作区还有未合并改动（分支 ${entry.worktree.branch}）。先 subagent_apply 合并，或重新派发任务；直接续聊会在新工作区丢失原分支状态。`,
          }],
          details: buildBackgroundDetails([entry]),
          isError: true,
        };
      }
      if (!entry.sessionFile || !existsSync(entry.sessionFile)) {
        return {
          content: [{ type: "text", text: `任务 ${id} 没有可用的会话文件，无法续聊；请重新派发一个任务。` }],
          details: buildBackgroundDetails([entry]),
          isError: true,
        };
      }

      const config = readSubagentConfig();
      const requestedModel = nonEmptyString(params.model);
      const poolActive = config.poolEnabled !== false;
      const pool = config.pool || [];
      if (requestedModel && !poolActive) {
        return {
          content: [{ type: "text", text: "模型池已在设置中关闭，续聊不接受指定模型；去掉 model 即可沿用上一轮模型。" }],
          details: buildBackgroundDetails([entry]),
          isError: true,
        };
      }
      if (requestedModel && poolActive && !getPoolEntry(config, requestedModel)) {
        return {
          content: [{ type: "text", text: `模型 ${requestedModel} 不在模型池内。当前可用：${pool.map((item) => item.model).join("、") || "（未配置模型池）"}` }],
          details: buildBackgroundDetails([entry]),
          isError: true,
        };
      }
      if (entry.agentPinnedModel && requestedModel && requestedModel !== entry.agentPinnedModel) {
        return {
          content: [{ type: "text", text: `agent ${entry.agent} 的 markdown 里钉死了 model（${entry.agentPinnedModel}），续聊也不能换。` }],
          details: buildBackgroundDetails([entry]),
          isError: true,
        };
      }
      // 换模型前做窗口检查：上一轮上下文已吃掉新窗口 80% 以上时，
      // 续聊会立刻触发压缩或直接超限，不如让主 Agent 换更大的窗口。
      if (requestedModel && requestedModel !== entry.model && typeof getModelMeta === "function") {
        try {
          const separator = requestedModel.indexOf("/");
          const provider = separator > 0 ? requestedModel.slice(0, separator) : requestedModel;
          const modelId = separator > 0 ? requestedModel.slice(separator + 1) : "";
          const meta = modelId ? getModelMeta(provider, modelId) : undefined;
          const contextWindow = Number(meta?.contextWindow) || 0;
          const used = Number(entry.lastRoundUsage?.contextTokens) || Number(entry.usage?.contextTokens) || 0;
          if (contextWindow > 0 && used > contextWindow * 0.8) {
            return {
              content: [{
                type: "text",
                text: `不能续聊到 ${requestedModel}：上一轮已用约 ${Math.round(used / 1000)}k token，超过该模型 ${Math.round(contextWindow / 1000)}k 窗口的 80%。请换一个窗口更大的模型，或重新派发任务。`,
              }],
              details: buildBackgroundDetails([entry]),
              isError: true,
            };
          }
        } catch {
          // 目录查询失败不阻断续聊。
        }
      }

      // 默认沿用上一轮模型；只有它仍在池内时才能当成显式 model 传下去。
      // 池为空或上一轮走的是「跟随主 Agent」时，传 model 会被运行时的池校验拒绝，
      // 这时留空让 run 重新按「池首项 / 主 Agent 模型」解析。
      const previousPoolModel = entry.model && poolActive && getPoolEntry(config, entry.model)
        ? entry.model
        : undefined;
      const chosenModel = entry.agentPinnedModel
        ? undefined
        : (requestedModel || previousPoolModel);
      const crossProvider = requestedModel
        && splitModelProvider(requestedModel) !== splitModelProvider(entry.model);
      const runInBackground = params.background !== false;
      const controller = new AbortController();
      entry.controller = controller;
      entry.roundStartedAt = Date.now();
      entry.lastTask = message;
      entry.delivered = false;
      entry.notified = false;
      entry.completedAt = undefined;
      entry.liveOutput = "";
      entry.result = null;
      entry.liveUsage = null;
      entry.status = "queued";
      const onUpdate = makeBackgroundUpdate(entry);
      // 同步续聊要同时响应两件事：宿主取消本次工具调用（signal），以及
// 监视窗/工具对 subagent_stop（controller）。少任意一个都会出现
// 「显示已停止、实际还在跑」或「停止按钮无效」。
      const runSignal = runInBackground
        ? controller.signal
        : (signal && controller.signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([signal, controller.signal])
          : (signal || controller.signal));

      if (!runInBackground) {
        const result = await entry.runRound({ task: message, model: chosenModel, signal: runSignal, onUpdate });
        entry.delivered = true;
        finalizeBackgroundEntry(entry, result);
        const note = crossProvider ? "\n\n（跨厂商续聊：上一轮的思考过程未继承。）" : "";
        return {
          content: [{ type: "text", text: truncateText(getFinalOutput(result) || getResultOutput(result), MAX_TOOL_OUTPUT_BYTES) + note }],
          details: buildBackgroundDetails([entry]),
          isError: isFailedResult(result),
        };
      }

      emitBackgroundEntry(entry, false);
      void (async () => {
        try {
          const result = await entry.runRound({ task: message, model: chosenModel, signal: runSignal, onUpdate });
          finalizeBackgroundEntry(entry, result);
        } catch (error) {
          finalizeBackgroundEntry(entry, {
            agent: entry.agent,
            task: message,
            exitCode: 1,
            messages: [],
            output: "",
            stderr: "",
            usage: entry.usage,
            model: entry.model,
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return {
        content: [{
          type: "text",
          text: `已向 ${id} 追加一轮对话${chosenModel ? `（模型 ${chosenModel}）` : ""}；结束后会通知你。`,
        }],
        details: buildBackgroundDetails([entry]),
      };
    },
  });

  /** 宿主停止单个后台任务（监视窗按钮 / worker 命令）。 */
  extension.stopTask = (id) => {
    const entry = backgroundTasks.get(String(id || "").trim());
    if (!entry || isTerminalBackgroundStatus(entry.status)) return false;
    entry.delivered = true;
    entry.stopRequested = true;
    try { entry.controller?.abort(); } catch { /* ignore */ }
    return true;
  };

  /** 当前后台任务快照，供宿主状态查询 / 监视窗恢复。 */
  extension.listTasks = () => [...backgroundTasks.values()].map(toBackgroundResult);
  /** 用户发消息/停止时取消防抖中的自动唤醒。 */
  extension.cancelPendingAutoWake = cancelPendingAutoWake;

  /**
   * 停止全部后台任务。
   *
   * worker 切会话 / 关会话 / 重启时不调用它，后台子进程会继续写文件、
   * 继续烧 token。wait=true 时等待任务进入终态（受硬超时保护）。
   */
  const stopAllTasks = ({ wait = false } = {}) => {
    state.disposed = true;
    const active = [...backgroundTasks.values()].filter((entry) => !isTerminalBackgroundStatus(entry.status));
    for (const entry of active) {
      entry.delivered = true;
      entry.stopRequested = true;
      try { entry.controller?.abort(); } catch { /* ignore */ }
    }
    cancelPendingAutoWake({ deliver: false });
    if (!wait || active.length === 0) return Promise.resolve(active.length);
    // worker 只给 2.5s（backend 侧总预算 4s + 1.5s），这里必须留出余量。
    const deadline = Date.now() + 2000;
    return new Promise((resolve) => {
      const check = () => {
        const pending = [...backgroundTasks.values()]
          .some((entry) => !isTerminalBackgroundStatus(entry.status));
        if (!pending || Date.now() >= deadline) {
          // 等待窗口内 finalize 的任务可能重新入队/起新 timer（disposed 标志
          // 已在各入口早退）；这里再清一次，避免向已切走的会话推事件。
          cancelPendingAutoWake({ deliver: false });
          resolve(active.length);
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  };
  extension.stopAll = () => stopAllTasks({ wait: true });
  /**
   * 宿主回合真的启动了：worker 在 maybeStartHostTurn 里回调，用来确认
   * triggerTurn 送达。未确认的那批在超时后降级为 nextTurn。
   */
  extension.confirmHostTurn = (taskIds) => {
    if (!state.pendingHostWake) return false;
    const ids = new Set((Array.isArray(taskIds) ? taskIds : []).map((value) => String(value || "")));
    if (ids.size > 0 && !state.pendingHostWake.taskIds.some((id) => ids.has(id))) return false;
    clearTimeout(state.pendingHostWake.timer);
    const entries = state.pendingHostWake.entries;
    state.pendingHostWake = null;
    settleAutoWakeEntries(entries);
    return true;
  };
  /** 进程即将退出时只能做同步动作；abort 会同步触发 taskkill / kill(-pid)。 */
  extension.abortAll = () => { void stopAllTasks({ wait: false }); };
  };

  return extension;
};

export default createHppSubagentExtension;
