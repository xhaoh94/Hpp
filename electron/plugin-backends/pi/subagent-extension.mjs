import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiAgentDir } from "./pi-agent-dir.mjs";
import { resolveSubagentCwd } from "./subagent-policy.mjs";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_TASK_OUTPUT_BYTES = 8 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_MESSAGE_COUNT = 80;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_JSON_TASK_BYTES = 24 * 1024;
// Pi 的 JSONL 里单条记录可能非常大：message_end 带完整正文/补丁、
// tool_execution_end 带整个文件内容，很容易超过几百 KB。上限只用于
// 防御「一直没有换行符的失控输出」，不能低到误杀合法事件。
const MAX_STDOUT_LINE_BYTES = 16 * 1024 * 1024;
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

const DEFAULT_AGENTS = [
  {
    name: "scout",
    description: "快速检索代码库，定位相关文件、实现和风险，不修改文件。",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: "你是代码库侦察 Agent。优先使用文件发现工具，再读取必要文件。输出精确的文件路径、关键事实、相关符号和不确定性。不要修改文件。最终返回结构化、简洁的调查摘要。",
    source: "builtin",
  },
  {
    name: "planner",
    description: "基于代码库事实制定可执行的实施计划，不修改文件。",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: "你是实施规划 Agent。先检查相关代码和测试，再给出分步骤计划、文件范围、兼容性影响、测试方案和风险。不要修改文件。避免重复粘贴大段源码。",
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
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TASK_TIMEOUT_MS;
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

const getPiInvocation = (packageRoot, args, nodePath) => {
  const cliPath = join(packageRoot || "", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
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
});

const getPartialResultFromUpdate = (partial) => {
  const details = isRecord(partial?.details) ? partial.details : {};
  const results = Array.isArray(details.results) ? details.results : [];
  if (isRecord(results[0])) return results[0];
  return isRecord(partial) && typeof partial.exitCode === "number" ? partial : null;
};

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
}) => {
  const result = {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: -1,
    messages: [],
    output: "",
    currentActivity: `正在启动 ${agent.name}…`,
    liveOutput: "",
    stderr: "",
    usage: createUsage(),
    // Prefer the child process' actual model once its first assistant message
    // arrives; the dispatching model is only a fallback for providers that omit
    // model metadata in JSON mode.
    model: agent.model,
    step,
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
    if (immediate) emitUpdateNow();
    else emitProgressUpdate();
  };

  if (!agent) return result;
  if (signal?.aborted) {
    result.exitCode = 1;
    result.stopReason = "aborted";
    result.errorMessage = "子 Agent 已中断";
    emitUpdate();
    return result;
  }

  const interactive = typeof requestUI === "function" && existsSync(bridgeExtensionPath);
  let cwdResult;
  try {
    cwdResult = resolveSubagentCwd(cwd, defaultCwd);
  } catch (error) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    emitUpdate();
    return result;
  }
  const childCwd = cwdResult.cwd;
  const projectRoot = cwdResult.projectRoot;
  if (!interactive && Buffer.byteLength(task, "utf8") > MAX_JSON_TASK_BYTES) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = `SubAgent 任务过长，非交互模式最多支持 ${MAX_JSON_TASK_BYTES} 字节。`;
    emitUpdate();
    return result;
  }
  const extensionIntegrations = getSubagentExtensionIntegration(agent.name, agentDir);
  const approvedExtensionPaths = extensionIntegrations.flatMap((integration) => integration.extensionPaths);
  // 子 Agent 只汇报结果，不向用户提问：bridge 侧不再注册 question 工具，
  // 这里再用 denylist 兜底，避免扩展或历史配置把它们重新带回工具集。
  const args = interactive
    ? [
      "--mode", "rpc",
      "--no-session",
      "--no-extensions",
      "--extension", bridgeExtensionPath,
      "--exclude-tools", `subagent,${SUBAGENT_QUESTION_TOOL_DENYLIST}`,
    ]
    : ["--mode", "json", "-p", "--no-session", "--no-extensions", "--exclude-tools", `subagent,${SUBAGENT_QUESTION_TOOL_DENYLIST}`];
  for (const extensionPath of approvedExtensionPaths) args.push("--extension", extensionPath);
  const model = agent.model || dispatchDefaults.model;
  if (model) args.push("--model", model);
  if (!agent.model && dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
  const tools = getSubagentTools(agent, extensionIntegrations);
  if (tools.length > 0) args.push("--tools", tools.join(","));
  if (agent.systemPrompt) args.push("--append-system-prompt", truncateText(agent.systemPrompt, 24 * 1024));
  if (hostSystemPrompt) args.push("--append-system-prompt", truncateText(hostSystemPrompt, 24 * 1024));
  args.push("--append-system-prompt", "当前进程是 Hpp 内置 subagent。不要调用 subagent，不要尝试递归委派；只完成当前任务并返回结构化摘要。\n\n不要向用户提问（question / ask_user_question 工具在本进程不可用）；需要用户决策时，把问题、可选方案和建议写进结果，由主 Agent 转述给用户。\n\nTask 输出建议包含：Goal、Findings、Files Read/Changed、Tests、Risks、Next Steps。\n\n超时策略：默认允许运行 30 分钟，最长也是 30 分钟。除非用户明确要求更短的时间，否则不要传入 timeoutMs，也不要把 5 分钟作为默认值。\n");
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
          result.stopReason = nonEmptyString(message.stopReason) || result.stopReason;
          result.errorMessage = nonEmptyString(message.errorMessage) || result.errorMessage;
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
      timeoutId = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        abortHandler();
      }, timeoutMs);
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
    result.output = truncateText(getFinalOutput(result), MAX_TASK_OUTPUT_BYTES);
    if (oversizedLineCount > 0 && !result.stopReason) {
      result.protocolWarning = `已跳过 ${oversizedLineCount} 条超大协议记录`;
      result.stderr = truncateText(`${result.stderr}${result.stderr ? "\n" : ""}${result.protocolWarning}`, MAX_STDERR_BYTES);
    }
    result.currentActivity = result.stopReason
      ? result.errorMessage || (result.stopReason === "timeout" ? "已超时" : "已停止")
      : result.output ? "已完成" : "已完成（未返回正文）";
    emitUpdate();
    return result;
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
    return result;
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
    cwd: nonEmptyString(item.cwd),
    timeoutMs: item.timeoutMs === undefined ? undefined : normalizeTaskTimeout(item.timeoutMs),
  }));
};

const getChainItems = (params) => {
  if (!Array.isArray(params?.chain)) return [];
  return params.chain.filter(isRecord).map((item) => ({
    agent: nonEmptyString(item.agent) || "",
    task: nonEmptyString(item.task) || "",
    cwd: nonEmptyString(item.cwd),
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

export const normalizeHppSubagentConfig = (value) => {
  const input = isRecord(value) ? value : {};
  const rawProfiles = isRecord(input.profiles) ? input.profiles : {};
  const profiles = {};
  for (const [name, rawProfile] of Object.entries(rawProfiles)) {
    if (!/^[A-Za-z0-9._:-]+$/.test(name) || !isRecord(rawProfile)) continue;
    const modelMode = rawProfile.modelMode === "custom" ? "custom" : "inherit";
    const model = nonEmptyString(rawProfile.model);
    profiles[name] = {
      modelMode,
      ...(modelMode === "custom" && model ? { model } : {}),
    };
  }
  const defaultModelMode = input.defaultModelMode === "custom" ? "custom" : "inherit";
  const defaultModel = nonEmptyString(input.defaultModel);
  return {
    enabled: input.enabled !== false,
    defaultModelMode,
    ...(defaultModelMode === "custom" && defaultModel ? { defaultModel } : {}),
    profiles,
  };
};

const resolveConfiguredModel = (config, agentName, inheritedModel) => {
  const profile = config.profiles?.[agentName];
  if (profile?.modelMode === "custom" && profile.model) return profile.model;
  if (config.defaultModelMode === "custom" && config.defaultModel) return config.defaultModel;
  return inheritedModel;
};

export const createHppSubagentExtension = ({
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
  // 仅测试注入口：真实间隔是 15s / 45s，跑测试要能调小。
  retryDelaysMs = SUBAGENT_RETRY_DELAYS_MS,
} = {}) => (pi) => {
  if (!pi || typeof pi.registerTool !== "function") return;
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

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "在隔离上下文中委派任务给专用 subagent。支持单任务、并行 tasks 和带 {previous} 占位符的 chain。默认提供 scout、planner、reviewer、worker，也会读取 Pi 用户级和项目级 agent 配置。用户已安装的同名 Pi 扩展优先于此内置 fallback。",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "单任务模式的 agent 名称" },
        task: { type: "string", description: "单任务模式的委派任务" },
        tasks: {
          type: "array",
          description: "并行任务列表；除非用户明确要求更短时间，否则不要填写 timeoutMs，未填写时默认 30 分钟",
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              task: { type: "string" },
              cwd: { type: "string" },
              timeoutMs: { type: "number", default: 1800000, description: "可选；仅按用户明确要求设置，未填写默认 30 分钟，最长 30 分钟；单位为毫秒" },
            },
            required: ["agent", "task"],
            additionalProperties: false,
          },
        },
        chain: {
          type: "array",
          description: "串行任务列表；后续任务可使用 {previous} 引用上一环输出；除非用户明确要求更短时间，否则不要填写 timeoutMs，未填写时默认 30 分钟",
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              task: { type: "string" },
              cwd: { type: "string" },
              timeoutMs: { type: "number", default: 1800000, description: "可选；仅按用户明确要求设置，未填写默认 30 分钟，最长 30 分钟；单位为毫秒" },
            },
            required: ["agent", "task"],
            additionalProperties: false,
          },
        },
        agentScope: { type: "string", enum: ["user", "project", "both"], default: "user" },
        // 兼容旧调用方但不信任模型传入的值；项目 Agent 是否批准由宿主 UI 决定。
        confirmProjectAgents: { type: "boolean", default: true, description: "由宿主控制，模型传入的值不会关闭安全确认" },
        cwd: { type: "string", description: "单任务子进程的工作目录" },
        timeoutMs: { type: "number", default: 1800000, description: "可选；仅在用户明确要求自定义时填写，未填写默认 30 分钟，最长 30 分钟；单位为毫秒" },
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

      const run = (item, step, update, runKey = step ?? "single") => {
        const agent = agentByName.get(item.agent);
        if (!agent) {
          const result = {
            agent: item.agent,
            agentSource: "unknown",
            task: item.task,
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
          return Promise.resolve(result);
        }
        const configuredModel = resolveConfiguredModel(
          effectiveSubagentConfig,
          agent.name,
          dispatchDefaults.model,
        );
        const effectiveAgent = agent.model || !configuredModel
          ? agent
          : { ...agent, model: configuredModel };
        return runSingleAgent({
          defaultCwd: ctx?.cwd || process.cwd(),
          dispatchDefaults,
          agent: effectiveAgent,
          task: item.task,
          cwd: item.cwd || (step === undefined ? nonEmptyString(params.cwd) : undefined),
          step,
          signal,
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
          timeoutMs: item.timeoutMs || defaultTimeoutMs,
        });
      };

      /**
       * 带重试的执行：撞上可重试的上游错误（overloaded / 限流 / 5xx）时重跑，间隔带抖动。
       *
       * 为什么退到外层重跑，而不是指望子进程内的重试：pi 自己会重试 3 次（`retry.enabled`
       * 默认 true、固定 2s 起），但并行跑的几个子进程是**同时**重试的，同步捶上游正是
       * overloaded 不退的原因之一。这里间隔更长、且加抖动把各个子进程的重试时刻错开。
       */
      const runWithRetry = async (item, step, update, runKey = step ?? "single") => {
        let result = await run(item, step, update, runKey);
        let attempt = 0;
        while (attempt < retryDelaysMs.length && isRetryableSubagentFailure(result)) {
          const next = attempt + 1;
          // 写进 currentActivity，并行/链式/单个三条路径的进度文案都会把它带出来。
          result.currentActivity = `上游错误，等待第 ${next}/${retryDelaysMs.length} 次重试…`;
          update?.({
            content: [{ type: "text", text: truncateText(`[${result.agent || item.agent}] ${getResultOutput(result)}`, MAX_TASK_OUTPUT_BYTES) }],
            details: details([result]),
          });
          if (!await waitBeforeRetry(attempt, signal, retryDelaysMs) || signal?.aborted) {
            result.exitCode = 1;
            result.stopReason = "aborted";
            result.errorMessage = "子 Agent 已中断";
            result.currentActivity = result.errorMessage;
            break;
          }
          const retried = await run(item, step, update, runKey);
          retried.retries = next;
          result = retried;
          attempt = next;
        }
        return result;
      };

      if (chain.length > 0) {
        const results = [];
        let previous = "";
        for (let index = 0; index < chain.length; index += 1) {
          const item = chain[index];
          const current = { ...item, task: item.task.replace(/\{previous\}/g, previous) };
          const result = await runWithRetry(current, index + 1, (partial) => {
            const partialResult = getPartialResultFromUpdate(partial) || partial;
            onUpdate?.({
              content: [{ type: "text", text: truncateText(getFinalOutput(partialResult) || partialResult.message || "正在运行…", MAX_TASK_OUTPUT_BYTES) }],
              details: details([...results, partialResult]),
            });
          }, index);
          results.push(result);
          if (isFailedResult(result)) {
            return {
              content: [{ type: "text", text: `Chain 在第 ${index + 1} 步（${item.agent}）停止：${truncateText(getResultOutput(result), MAX_TASK_OUTPUT_BYTES)}` }],
              details: details(results),
              isError: true,
            };
          }
          previous = getFinalOutput(result);
        }
        return {
          content: [{ type: "text", text: truncateText(getFinalOutput(results[results.length - 1]) || "无输出", MAX_TOOL_OUTPUT_BYTES) }],
          details: details(results),
        };
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
          return `### [${result.agent}] ${status}\n\n${truncateText(getResultOutput(result), perTaskBudget)}`;
        }).join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: truncateText(`Parallel：${successCount}/${results.length} 成功\n\n${summary}`, MAX_TOOL_OUTPUT_BYTES) }],
          details: details(results),
          isError: successCount !== results.length,
        };
      }

      const item = { agent: nonEmptyString(params.agent) || "", task: nonEmptyString(params.task) || "", cwd: nonEmptyString(params.cwd) };
      const result = await runWithRetry(item, undefined, onUpdate ? (partial) => {
        const partialResult = getPartialResultFromUpdate(partial) || partial;
        onUpdate({
          content: [{ type: "text", text: truncateText(getFinalOutput(partialResult) || partialResult.message || "正在运行…", MAX_TASK_OUTPUT_BYTES) }],
          details: details([partialResult]),
        });
      } : undefined);
      if (isFailedResult(result)) {
        return {
          content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}：${truncateText(getResultOutput(result), MAX_TOOL_OUTPUT_BYTES)}` }],
          details: details([result]),
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: truncateText(getFinalOutput(result) || "无输出", MAX_TOOL_OUTPUT_BYTES) }],
        details: details([result]),
      };
    },
  });
};

export default createHppSubagentExtension;
