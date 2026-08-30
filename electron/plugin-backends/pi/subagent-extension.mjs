import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_TASK_OUTPUT_BYTES = 8 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_MESSAGE_COUNT = 80;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const SUBAGENT_BRIDGE_EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "subagent-bridge-extension.mjs");
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

const getResultOutput = (result) => {
  if (result?.stopReason === "aborted") return result.errorMessage || "子 Agent 已中断";
  if (result?.exitCode !== 0) {
    return result.errorMessage || result.stderr || getFinalOutput(result) || "子 Agent 未返回输出";
  }
  return getFinalOutput(result) || "子 Agent 未返回输出";
};

const isFailedResult = (result) =>
  result?.exitCode !== 0 || result?.stopReason === "error" || result?.stopReason === "aborted";

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

const getSubagentTools = (agent, integrations) => {
  const tools = Array.isArray(agent?.tools) ? [...agent.tools] : [];
  for (const integration of integrations) {
    for (const toolName of integration.tools) {
      if (!tools.includes(toolName)) tools.push(toolName);
    }
  }
  return tools;
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
  const extensionIntegrations = getSubagentExtensionIntegration(agent.name, agentDir);
  const approvedExtensionPaths = extensionIntegrations.flatMap((integration) => integration.extensionPaths);
  const args = interactive
    ? ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", bridgeExtensionPath, "--exclude-tools", "subagent"]
    : ["--mode", "json", "-p", "--no-session", "--no-extensions", "--exclude-tools", "subagent"];
  for (const extensionPath of approvedExtensionPaths) args.push("--extension", extensionPath);
  const model = agent.model || dispatchDefaults.model;
  if (model) args.push("--model", model);
  if (!agent.model && dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
  const tools = getSubagentTools(agent, extensionIntegrations);
  if (tools.length > 0) args.push("--tools", tools.join(","));
  if (agent.systemPrompt) args.push("--append-system-prompt", truncateText(agent.systemPrompt, 24 * 1024));
  if (hostSystemPrompt) args.push("--append-system-prompt", truncateText(hostSystemPrompt, 24 * 1024));
  args.push("--append-system-prompt", "当前进程是 Hpp 内置 subagent。不要调用 subagent，不要尝试递归委派；只完成当前任务并返回结构化摘要。\n\nTask 输出建议包含：Goal、Findings、Files Read/Changed、Tests、Risks、Next Steps。\n\n超时策略：默认允许运行 30 分钟，最长也是 30 分钟。除非用户明确要求更短的时间，否则不要传入 timeoutMs，也不要把 5 分钟作为默认值。\n");
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
      cwd: cwd || defaultCwd,
      shell: false,
      windowsHide: true,
      stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
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
        setCurrentActivity(
          method === "select" || method === "questionnaire" ? "等待用户选择…" : "等待用户确认…",
          true,
        );
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
        setCurrentActivity("正在整理最终结果…");
        rpcCompleted = true;
        requestRpcExit();
        return;
      }
      if (interactive && event.type === "response") {
        if (event.command === "prompt" && event.success === false) {
          result.stopReason = "error";
          result.errorMessage = nonEmptyString(event.error) || "子 Agent RPC prompt 被拒绝";
          requestRpcExit();
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
    child.stdout?.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
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
      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        resolveExit(rpcCompleted ? 0 : typeof code === "number" ? code : 1);
      };
      requestRpcExit = () => {
        if (!interactive || settled) return;
        setTimeout(() => {
          if (!settled) {
            try { child.kill("SIGTERM"); } catch { /* ignore */ }
          }
        }, 25);
      };
      child.once("close", finish);
      child.once("error", () => finish(1));
      abortHandler = () => {
        if (aborted) return;
        aborted = true;
        try {
          if (interactive) writeRpc({ type: "abort" });
          child.kill("SIGTERM");
        } catch { /* ignore */ }
        setTimeout(() => {
          if (!settled) {
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
          }
        }, 1500);
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

    if (stdoutBuffer.trim()) processLine(stdoutBuffer);
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
  agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  hostSystemPrompt = "",
  nodePath = process.env.PI_NODE_PATH || process.execPath,
  getPermissionMode = () => "auto",
  requestUI,
  dismissUI,
  bridgeExtensionPath = SUBAGENT_BRIDGE_EXTENSION_PATH,
  subagentConfig,
} = {}) => (pi) => {
  if (!pi || typeof pi.registerTool !== "function") return;
  const effectiveSubagentConfig = normalizeHppSubagentConfig(subagentConfig);
  if (!effectiveSubagentConfig.enabled) return;

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
        confirmProjectAgents: { type: "boolean", default: true },
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

      if (modeCount !== 1) {
        const available = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "无可用 agent";
        return {
          content: [{ type: "text", text: `subagent 参数无效：必须且只能选择单任务、并行或 chain 模式。可用 agent：${available}` }],
          details: details([]),
          isError: true,
        };
      }

      if ((agentScope === "project" || agentScope === "both") && params.confirmProjectAgents !== false && ctx?.hasUI) {
        const projectNames = [...requestedAgentNames(params)].filter((name) => agentByName.get(name)?.source === "project");
        if (projectNames.length > 0) {
          const approved = await ctx.ui.confirm(
            "运行项目级 Agent？",
            `Agent：${projectNames.join(", ")}\n来源：${discovery.projectAgentsDir || "未知"}\n\n项目级 Agent 由仓库内容控制，请仅在可信仓库中继续。`,
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

      if (chain.length > 0) {
        const results = [];
        let previous = "";
        for (let index = 0; index < chain.length; index += 1) {
          const item = chain[index];
          const current = { ...item, task: item.task.replace(/\{previous\}/g, previous) };
          const result = await run(current, index + 1, (partial) => {
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
        const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, (item, index) => run(item, undefined, (partial) => {
          const partialResult = getPartialResultFromUpdate(partial);
          if (partialResult) allResults[index] = partialResult;
          emitParallelUpdate();
        }, index));
        const successCount = results.filter((result) => !isFailedResult(result)).length;
        const summary = results.map((result) => {
          const status = isFailedResult(result) ? "failed" : "completed";
          return `### [${result.agent}] ${status}\n\n${truncateText(getResultOutput(result), MAX_TASK_OUTPUT_BYTES)}`;
        }).join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: truncateText(`Parallel：${successCount}/${results.length} 成功\n\n${summary}`, MAX_TOOL_OUTPUT_BYTES) }],
          details: details(results),
          isError: successCount !== results.length,
        };
      }

      const item = { agent: nonEmptyString(params.agent) || "", task: nonEmptyString(params.task) || "", cwd: nonEmptyString(params.cwd) };
      const result = await run(item, undefined, onUpdate ? (partial) => {
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
