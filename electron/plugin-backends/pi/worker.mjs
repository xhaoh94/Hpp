import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { getPiMessageText, resolvePiForkEntryId } from "./pi-fork-utils.mjs";
import {
  buildShellEnvironmentContract,
  detectShellFamily,
  POWERSHELL_UTF8_COMMAND_PREFIX,
  rewritePowerShellPackageManagerCommand,
  validateShellCommand,
} from "./shell-environment.mjs";
import { findBlockedPlanCommand } from "./plan-mode-policy.mjs";
import { createHppSubagentExtension } from "./subagent-extension.mjs";

const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
const DISCOVERY_TOOL_NAMES = ["grep", "find", "ls"];
const QUESTIONNAIRE_TOOLS = new Set(["ask_user_question", "questionnaire", "question"]);
const BUILTIN_SUBAGENT_PROMPT_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "subagent-prompts");
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATING_TOOLS = new Set(["edit", "write"]);
const PLAN_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const PLAN_BLOCKED_TOOLS = new Set(["edit", "write", "update_plan"]);
const HIGH_RISK_COMMAND_PATTERN = /(?:\brm\s+(?:-[^\s]*r|--recursive)|\bsudo\b|\b(?:chmod|chown)\b|\bgit\s+(?:push|clean|reset\s+--hard)|\b(?:curl|wget|ssh|scp|rsync)\b|\b(?:npm|pnpm|yarn|pip|cargo)\s+(?:install|add|publish)|invoke-webrequest|start-process|\bshutdown\b|\breboot\b|\btaskkill\b)/i;
const SHELL_PROBE_TOKEN = "hpp-shell-ready";
const FILE_DISCOVERY_GUIDANCE = [
  "当目标文件路径未知时，先使用 ls、find 或 grep 发现文件，再调用 read。",
  "不要猜测多个文件名并逐个试错。",
  "如果 bash 不可用，继续使用 ls、find 和 grep，不要反复重试基于 Shell 的文件发现。",
].join(" ");
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const AGENT_COMPACTION_THINKING_LEVELS = new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_AGENT_COMPACTION_CONFIG = {
  thinkingLevel: "low",
  modelMode: "current",
  customModel: {
    baseUrl: "",
    apiKey: "",
    modelId: "",
    api: "openai-completions",
    reasoning: false,
  },
};
const normalizeAgentCompactionConfig = (value) => {
  const config = isRecord(value) ? value : {};
  const customModel = isRecord(config.customModel) ? config.customModel : {};
  return {
    thinkingLevel: AGENT_COMPACTION_THINKING_LEVELS.has(config.thinkingLevel)
      ? config.thinkingLevel
      : DEFAULT_AGENT_COMPACTION_CONFIG.thinkingLevel,
    modelMode: config.modelMode === "custom" ? "custom" : "current",
    customModel: {
      baseUrl: String(customModel.baseUrl || "").trim(),
      apiKey: String(customModel.apiKey || "").trim(),
      modelId: String(customModel.modelId || "").trim(),
      api: customModel.api === "openai-responses" ? "openai-responses" : "openai-completions",
      reasoning: customModel.reasoning === true,
    },
  };
};
const PLAN_MODE_SYSTEM_PROMPT = `[HPP 计划模式已启用]
当前回合处于计划模式。请在不改变环境的前提下，输出完整、可执行的实施计划。

- 当仓库中的事实可以消除不确定性时，先使用只读工具检查项目，再提问。
- 不要编辑或创建文件、应用补丁、安装依赖、修改配置、提交代码，或执行任何会改变环境的命令。
- 计划模式开启时，把“实施/修复/开发”请求视为“制定计划”请求。
- 只有在无法通过检查项目安全确定的重要产品决策时，才提出简洁的问题。
- 计划应覆盖行为变化、兼容性、测试和明确的假设，并使用简体中文。
- 不要询问用户是否要继续实施；用户关闭计划模式并发送实施请求后，才会进入实施阶段。`;

let sdk = null;
let session = null;
let modelRegistry = null;
let resourceLoader = null;
let uiBridge = null;
let activeSettingsManager = null;
let activeCompactionConfig = normalizeAgentCompactionConfig(undefined);
let unsubscribe = null;
let projectPath = "";
let activePromptId = null;
let activePermissionMode = "full-access";
let activePlanMode = false;
let activeHostSystemPrompt = "";
const pendingSubagentUIRequests = new Map();

const requestSubagentUI = (request, context = {}) => {
  const childRequestId = request?.id !== undefined && request?.id !== null
    ? String(request.id)
    : randomUUID();
  const requestId = `pi-subagent-ui-${randomUUID()}`;
  return new Promise((resolve) => {
    pendingSubagentUIRequests.set(requestId, {
      resolve,
      childRequestId,
      ownerId: context.ownerId,
      request,
    });
    send({
      type: "extension_ui_request",
      request: {
        ...request,
        id: requestId,
        requestId,
        source: "pi-subagent",
        subagentAgent: context.agent,
        subagentTask: context.task,
        subagentStep: context.step,
      },
    });
  });
};

const handleSubagentUIResponse = (response) => {
  const requestId = response?.id !== undefined && response?.id !== null ? String(response.id) : "";
  const pending = requestId ? pendingSubagentUIRequests.get(requestId) : undefined;
  if (!pending) return false;
  pendingSubagentUIRequests.delete(requestId);
  pending.resolve({
    ...response,
    id: pending.childRequestId,
  });
  return true;
};

const dismissSubagentUIRequests = (ownerId, reason = "dismissed") => {
  for (const [requestId, pending] of [...pendingSubagentUIRequests.entries()]) {
    if (ownerId && pending.ownerId !== ownerId) continue;
    pendingSubagentUIRequests.delete(requestId);
    pending.resolve({
      id: pending.childRequestId,
      cancelled: true,
      reason,
    });
    send({
      type: "process_event",
      id: requestId,
      requestId,
      entryType: "question",
      kind: "question",
      title: "子 Agent 交互已取消",
      detail: {
        ...pending.request,
        source: "pi-subagent",
        reason,
      },
      state: "interrupted",
      phase: "completed",
    });
  }
};

// Set after a guidance command resolves (steer is only queued at that point).
// Cleared when the steer message actually enters the agent message flow
// (message_start with a user message), which happens right before the agent
// starts the output that responds to the guidance.
let pendingGuidanceDelivered = false;
let fullAccessToolNames = [];
let planModeToolNames = [];
let shellWarning = "";
let shellNotice = "";
let shellAvailable = false;
let shellWarningEmitted = false;
let shellEnvironment = { platform: process.platform, shellFamily: "unknown", shellPath: "" };
let activeCompactionId = null;
const completedPromptIds = new Set();
const actionKeys = new Set();

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const finishPrompt = (id) => {
  if (!id || completedPromptIds.has(id)) return;
  completedPromptIds.add(id);
  if (activePromptId === id) activePromptId = null;
  send({ type: "prompt_done", id });
  setTimeout(() => completedPromptIds.delete(id), 60000);
};

const readPath = (value, path) => {
  if (!path?.startsWith("$.")) return undefined;
  let current = value;
  for (const part of path.slice(2).split(".").filter(Boolean)) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
};

const normalizeQuestions = (value) => {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.questions)) return value.questions;
  return [];
};

const normalizeToolName = (value) => String(value || "").trim().toLowerCase().replace(/-/g, "_");

const normalizeEventToken = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s._:-]+/g, "");

const isContextCompactionLike = (...values) => {
  const normalized = values.map(normalizeEventToken).filter(Boolean);
  return normalized.some((value) =>
    value.includes("contextcompaction") ||
    value.includes("compactedcontext") ||
    value.includes("compactcontext") ||
    value.includes("contextcompact") ||
    value.includes("contextsummary") ||
    value.includes("summarizecontext") ||
    value.includes("contextsummarized") ||
    value.includes("conversationcompaction") ||
    value.includes("conversationcompacted") ||
    value.includes("conversationcompact") ||
    value.includes("memorycompaction") ||
    value.includes("压缩上下文") ||
    value.includes("上下文压缩") ||
    value.includes("上下文已自动压缩")
  );
};

const forkSessionAtMessage = async (command) => {
  if (!sdk || !session) {
    return { supported: true, success: false, error: "Pi SDK session is not initialized" };
  }

  const sourcePath = command.sourceSessionFilePath || session.sessionFile;
  if (!sourcePath) {
    return { supported: true, success: false, reason: "source session is not persisted" };
  }

  const sessionManager = sdk.SessionManager.open(sourcePath, undefined, projectPath);
  const targetEntryId = resolvePiForkEntryId(sessionManager.getBranch(), command);
  if (!targetEntryId) {
    return {
      supported: true,
      success: false,
      reason: "could not map the Hpp message to a completed Pi turn",
    };
  }

  const sessionFilePath = sessionManager.createBranchedSession(targetEntryId);
  if (!sessionFilePath || !existsSync(sessionFilePath)) {
    return {
      supported: true,
      success: false,
      nativeEntryId: targetEntryId,
      reason: "Pi did not persist the forked session file",
    };
  }

  return {
    supported: true,
    success: true,
    sessionFilePath,
    nativeEntryId: targetEntryId,
  };
};

const normalizeQuestionOption = (option) => {
  if (typeof option === "string") return { value: option, label: option };
  if (!isRecord(option)) return { value: String(option), label: String(option) };
  const label = option.label ?? option.value ?? option.text ?? option.title ?? "";
  return {
    ...option,
    value: String(option.value ?? label),
    label: String(label),
  };
};

const buildQuestionFromArgs = (args) => {
  if (!isRecord(args)) return [];
  const options = readPath(args, "$.options");
  if (!Array.isArray(options)) return [];
  const prompt =
    readPath(args, "$.question") ||
    readPath(args, "$.prompt") ||
    readPath(args, "$.message") ||
    readPath(args, "$.title") ||
    "请选择答案";
  return [{
    id: readPath(args, "$.id") || "question",
    label: readPath(args, "$.label"),
    prompt,
    options: options.map(normalizeQuestionOption),
    allowOther: readPath(args, "$.allowOther"),
  }];
};

const buildQuestionResult = (response) => {
  const answer = Array.isArray(response?.answers) ? response.answers[0] : undefined;
  if (response?.cancelled || !answer) return null;
  return {
    answer: String(answer.label ?? answer.answer ?? answer.value ?? ""),
    wasCustom: !!answer.wasCustom || answer.kind === "custom",
    index: typeof answer.index === "number" ? answer.index : undefined,
  };
};

const getTextFromMessage = (message) => {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "thinking") return "";
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("");
};

const getThinkingFromMessage = (message) => {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((part) => (part?.type === "thinking" ? part.text || part.thinking || "" : ""))
    .filter(Boolean)
    .join("");
};

const stringifyErrorValue = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value.message === "string") return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getErrorFromMessage = (message) => {
  if (!message) return "";
  return (
    stringifyErrorValue(message.errorMessage) ||
    stringifyErrorValue(message.error) ||
    stringifyErrorValue(message.info?.error) ||
    stringifyErrorValue(message.metadata?.error) ||
    ""
  );
};

const getTimestamp = (entry, message) => {
  if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  const parsed = Date.parse(String(entry?.timestamp || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const buildHistorySnapshot = (sessionManager) => {
  const history = [];
  let activeTurnIndexes = [];
  for (const entry of sessionManager.getBranch()) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const role = entry.message.role;
    if (role === "user") {
      const content = getPiMessageText(entry.message).trim();
      if (!content || typeof entry.id !== "string") continue;
      history.push({
        id: `pi-history-${entry.id}`,
        role: "user",
        content,
        timestamp: getTimestamp(entry, entry.message),
        nativeTurnId: entry.id,
      });
      activeTurnIndexes = [history.length - 1];
      continue;
    }
    if (role !== "assistant" || typeof entry.id !== "string") continue;
    for (const historyIndex of activeTurnIndexes) history[historyIndex].nativeTurnId = entry.id;
    const content = getTextFromMessage(entry.message).trim();
    if (!content) continue;
    history.push({
      id: `pi-history-${entry.id}`,
      role: "assistant",
      content,
      timestamp: getTimestamp(entry, entry.message),
      nativeTurnId: entry.id,
    });
    activeTurnIndexes.push(history.length - 1);
  }
  return history;
};

const emitLatestAssistantTurnMetadata = (promptId, previousLeafId) => {
  queueMicrotask(() => {
    if (!promptId || !session) return;
    const leafEntry = session.sessionManager.getLeafEntry?.();
    if (
      !isRecord(leafEntry) ||
      leafEntry.id === previousLeafId ||
      leafEntry.type !== "message" ||
      !isRecord(leafEntry.message) ||
      leafEntry.message.role !== "assistant"
    ) {
      return;
    }
    send({ type: "turn_metadata", nativeTurnId: leafEntry.id, clientUserMessageId: promptId });
  });
};

const createDialogPromise = (emit, pending, request, parse, defaultValue, opts = {}) => {
  if (opts.signal?.aborted) return Promise.resolve(defaultValue);

  return new Promise((resolve, reject) => {
    let timeoutId;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      opts.signal?.removeEventListener("abort", onAbort);
      pending.delete(request.id);
    };
    const settle = (value) => {
      cleanup();
      resolve(value);
    };
    const onAbort = () => {
      opts.onDismiss?.(request.id, "abort");
      settle(defaultValue);
    };

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeout) {
      timeoutId = setTimeout(() => {
        opts.onDismiss?.(request.id, "timeout");
        settle(defaultValue);
      }, opts.timeout);
    }

    pending.set(request.id, {
      resolve: (response) => settle(parse(response)),
      reject: (error) => {
        cleanup();
        reject(error);
      },
      dismiss: (reason) => {
        opts.onDismiss?.(request.id, reason);
        settle(defaultValue);
      },
    });
    emit(request);
  });
};

class DesktopUIBridge {
  pending = new Map();
  lastAskPayload = null;
  interactArgs = null;
  unsubscribeAsk = null;

  constructor(eventBus) {
    this.unsubscribeAsk = eventBus.on(ASK_USER_PROMPT_EVENT, (payload) => {
      if (isRecord(payload)) this.lastAskPayload = { questions: payload.questions };
    });

    this.uiContext = {
      select: (title, options, opts) =>
        createDialogPromise(
          (request) => send({ type: "extension_ui_request", request }),
          this.pending,
          { id: randomUUID(), method: "select", title, options, timeout: opts?.timeout },
          (response) => (response.cancelled ? undefined : response.value),
          undefined,
          opts
        ),
      confirm: (title, message, opts) =>
        createDialogPromise(
          (request) => send({ type: "extension_ui_request", request }),
          this.pending,
          { id: randomUUID(), method: "confirm", title, message, timeout: opts?.timeout },
          (response) => (response.cancelled ? false : !!response.confirmed),
          false,
          opts
        ),
      input: (title, placeholder, opts) =>
        createDialogPromise(
          (request) => send({ type: "extension_ui_request", request }),
          this.pending,
          { id: randomUUID(), method: "input", title, placeholder, timeout: opts?.timeout },
          (response) => (response.cancelled ? undefined : response.value),
          undefined,
          opts
        ),
      editor: (title, prefill) =>
        createDialogPromise(
          (request) => send({ type: "extension_ui_request", request }),
          this.pending,
          { id: randomUUID(), method: "editor", title, prefill },
          (response) => (response.cancelled ? undefined : response.value),
          undefined
        ),
      notify: (message, notifyType) => {
        send({ type: "extension_ui_request", request: { id: randomUUID(), method: "notify", message, notifyType } });
      },
      custom: async () => {
        const id = randomUUID();
        const questions = this.buildAskQuestions();
        const toolName = this.interactArgs?.toolName;
        const hasAskPayload = normalizeQuestions(this.lastAskPayload?.questions).length > 0;
        this.lastAskPayload = null;
        this.interactArgs = null;
        if ((!QUESTIONNAIRE_TOOLS.has(toolName) && !hasAskPayload) || questions.length === 0) {
          throw new Error(`Pi extension custom UI is not supported by Hpp${toolName ? `: ${toolName}` : ""}`);
        }
        return createDialogPromise(
          (request) => send({ type: "extension_ui_request", request }),
          this.pending,
          { id, method: "custom", kind: "ask_user_question", toolName, questions },
          (response) => {
            if (toolName === "question") return buildQuestionResult(response);
            return response.cancelled ? { cancelled: true, answers: [] } : response.result;
          },
          toolName === "question" ? null : { cancelled: true, answers: [] }
        );
      },
      onTerminalInput: () => () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported here" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      get theme() {
        return {};
      },
    };
  }

  cacheInteractArgs(toolName, args) {
    const normalizedToolName = normalizeToolName(toolName);
    if (normalizedToolName !== "ask_user_question" && normalizedToolName !== "questionnaire" && normalizedToolName !== "question") return;
    const questions = readPath(args, "$.questions");
    this.interactArgs = {
      schema: "questions",
      toolName: normalizedToolName,
      args: {
        questions: normalizeQuestions(questions).length > 0 ? questions : buildQuestionFromArgs(args),
        options: readPath(args, "$.options"),
      },
    };
  }

  handleResponse(response) {
    const pending = response?.id ? this.pending.get(response.id) : undefined;
    if (!pending) return false;
    pending.resolve(response);
    return true;
  }

  dismissAll(reason = "dismissed") {
    for (const pending of [...this.pending.values()]) pending.dismiss(reason);
  }

  buildAskQuestions() {
    const eventQuestions = normalizeQuestions(this.lastAskPayload?.questions);
    const toolQuestions = this.interactArgs?.schema === "questions"
      ? normalizeQuestions(this.interactArgs.args.questions)
      : [];

    if (toolQuestions.length === 0) return eventQuestions;
    if (eventQuestions.length === 0) return toolQuestions;

    return eventQuestions.map((eventQuestion, questionIndex) => {
      const toolQuestion = toolQuestions[questionIndex];
      if (!isRecord(eventQuestion) || !isRecord(toolQuestion) || !Array.isArray(toolQuestion.options)) return eventQuestion;
      const eventOptions = Array.isArray(eventQuestion.options) ? eventQuestion.options : [];
      const toolOptions = toolQuestion.options;
      const options = eventOptions.map((eventOption, optionIndex) => {
        const toolOption = toolOptions[optionIndex];
        if (!isRecord(eventOption) || !isRecord(toolOption) || typeof toolOption.preview !== "string") return eventOption;
        return { ...eventOption, preview: toolOption.preview };
      });
      return { ...eventQuestion, options };
    });
  }

  dispose() {
    this.unsubscribeAsk?.();
    for (const pending of [...this.pending.values()]) pending.reject(new Error("UI bridge disposed"));
    this.pending.clear();
  }
}

const buildCommandContextActions = (sess) => ({
  waitForIdle: () => sess.agent.waitForIdle(),
  newSession: async () => ({ cancelled: true }),
  fork: async () => ({ cancelled: true }),
  navigateTree: async (targetId, options) => {
    const result = await sess.navigateTree(targetId, {
      summarize: options?.summarize ?? false,
      customInstructions: options?.customInstructions,
      replaceInstructions: options?.replaceInstructions,
      label: options?.label,
    });
    return { cancelled: result.cancelled };
  },
  switchSession: async () => ({ cancelled: true }),
  reload: async () => {
    await sess.reload();
  },
});

const waitForPromise = (promise, timeoutMs) => new Promise((resolve) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(finish, timeoutMs);
  Promise.resolve(promise).then(finish, finish);
});

const disposeSession = async () => {
  const disposingSession = session;
  activePromptId = null;
  activePermissionMode = "full-access";
  activePlanMode = false;
  activeHostSystemPrompt = "";
  fullAccessToolNames = [];
  planModeToolNames = [];
  activeCompactionId = null;
  completedPromptIds.clear();
  dismissSubagentUIRequests(undefined, "dispose");
  unsubscribe?.();
  unsubscribe = null;
  uiBridge?.dismissAll("dispose");
  uiBridge?.dispose();
  uiBridge = null;

  if (disposingSession) {
    // 自动压缩发生在正文结束之后，但仍属于同一个 Pi 会话运行。
    // 退出时先取消压缩并等待异步运行收尾，避免进程在 SDK 尚未完成
    // 会话状态清理时被直接结束，导致下次恢复会话失败。
    try {
      disposingSession.abortCompaction?.();
      await waitForPromise(disposingSession.abort?.(), 1000);
    } catch {
      // dispose() 自身仍会执行兜底中止和资源清理。
    }
    disposingSession.dispose();
  }

  if (session === disposingSession) session = null;
  modelRegistry = null;
  resourceLoader = null;
  activeSettingsManager = null;
  activeCompactionConfig = normalizeAgentCompactionConfig(undefined);
  actionKeys.clear();
  builtinThinkingLevelMaps = null;
  builtinThinkingLevelMapsFailed = false;
};

const stripUtf8Bom = (filePath) => {
  if (!existsSync(filePath)) return;
  try {
    const content = readFileSync(filePath, "utf8");
    if (content.charCodeAt(0) === 0xfeff) {
      writeFileSync(filePath, content.slice(1), "utf8");
    }
  } catch {
    // Pi will surface the underlying config read error if the file is still invalid.
  }
};

const applyActiveToolMode = () => {
  if (!session?.setActiveToolsByName) return;
  session.setActiveToolsByName(activePlanMode ? planModeToolNames : fullAccessToolNames);
};

const setPermissionMode = (permissionMode) => {
  activePermissionMode = permissionMode;
  applyActiveToolMode();
};

const setPlanMode = (enabled) => {
  activePlanMode = enabled === true;
  applyActiveToolMode();
};

const getToolPaths = (event) => {
  const input = isRecord(event?.input) ? event.input : {};
  return [input.path, input.filePath, input.file_path, input.cwd, input.directory]
    .filter((value) => typeof value === "string" && value.trim())
    .map(String);
};

const isOutsideProject = (filePath) => {
  try {
    const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(projectPath, filePath);
    const projectRelativePath = relative(resolve(projectPath), absolutePath);
    return projectRelativePath === ".." || projectRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(projectRelativePath);
  } catch {
    return true;
  }
};

const shouldRequestPiToolPermission = (event) => {
  if (activePermissionMode === "full-access") return false;
  const toolName = normalizeToolName(event?.toolName);
  if (QUESTIONNAIRE_TOOLS.has(toolName)) return false;
  const outsideProject = getToolPaths(event).some(isOutsideProject);
  if (activePermissionMode === "ask") {
    return outsideProject || !READ_ONLY_TOOLS.has(toolName);
  }
  if (outsideProject) return true;
  if (READ_ONLY_TOOLS.has(toolName) || MUTATING_TOOLS.has(toolName)) return false;
  if (toolName === "bash") {
    const command = String(isRecord(event?.input) ? event.input.command || "" : "");
    return !command.trim() || HIGH_RISK_COMMAND_PATTERN.test(command);
  }
  return true;
};

const describePiToolPermission = (event) => {
  const toolName = String(event?.toolName || "工具");
  const input = isRecord(event?.input) ? event.input : {};
  const detail = toolName === "bash"
    ? String(input.command || "")
    : getToolPaths(event).join("、") || JSON.stringify(input);
  return detail ? `${toolName}: ${detail}` : toolName;
};

const planModeToolBlockReason = (event) => {
  if (!activePlanMode) return "";
  const toolName = normalizeToolName(event?.toolName);
  if (PLAN_BLOCKED_TOOLS.has(toolName)) {
    return `Plan 模式为只读模式，不能使用 ${toolName} 修改项目。请关闭 Plan 模式后再实施。`;
  }
  if (toolName === "bash") {
    const command = String(isRecord(event?.input) ? event.input.command || "" : "");
    const blockedSegment = findBlockedPlanCommand(command, shellEnvironment.shellFamily);
    return blockedSegment
      ? `Plan 模式只允许只读 Shell 命令，已阻止：${blockedSegment}`
      : "";
  }
  if (!PLAN_READ_ONLY_TOOLS.has(toolName)) {
    return `Plan 模式未开放工具 ${toolName}，请使用只读检索工具完成规划。`;
  }
  return "";
};

const registerHppShellTool = (pi) => {
  if (!shellAvailable || typeof pi?.registerTool !== "function" || typeof sdk?.createBashToolDefinition !== "function") return;
  const isPowerShell = shellEnvironment.platform === "win32" && shellEnvironment.shellFamily === "powershell";
  const shellLabel = shellEnvironment.shellFamily === "powershell"
    ? "PowerShell"
    : shellEnvironment.shellFamily === "cmd"
      ? "Command Prompt"
      : shellEnvironment.shellFamily === "bash" || shellEnvironment.shellFamily === "posix"
        ? "POSIX shell"
        : "configured shell";
  const definition = sdk.createBashToolDefinition(projectPath, {
    shellPath: shellEnvironment.shellPath || undefined,
    ...(isPowerShell ? {
      commandPrefix: POWERSHELL_UTF8_COMMAND_PREFIX,
      spawnHook: (context) => ({
        ...context,
        command: rewritePowerShellPackageManagerCommand(context.command),
      }),
    } : {}),
  });
  definition.label = shellLabel;
  definition.description = `在当前工作目录执行 ${shellLabel} 命令。注册的工具名称仍为 bash，并返回标准输出和标准错误。`;
  definition.promptSnippet = `使用可用的 bash 工具执行 ${shellLabel} 命令`;
  definition.promptGuidelines = [
    ...(definition.promptGuidelines || []),
    `bash 工具已注册并可用；它实际执行的是 ${shellLabel}，不一定是 GNU Bash。`,
    ...(isPowerShell ? ["在 Windows PowerShell 中运行 Node 包管理器命令时，请使用 npm.cmd、npx.cmd、pnpm.cmd 和 yarn.cmd。"] : []),
  ];
  pi.registerTool(definition);
};

const hppPermissionExtension = (pi) => {
  registerHppShellTool(pi);
  pi.on("tool_call", async (event, context) => {
    if (normalizeToolName(event?.toolName) === "bash") {
      const input = isRecord(event?.input) ? event.input : {};
      const environmentError = validateShellCommand({
        ...shellEnvironment,
        command: input.command,
      });
      if (environmentError) return { block: true, reason: environmentError };
    }
    // Let the Plan hook reject mutating/unknown tools without first showing a
    // permission dialog. Read-only tools still follow the selected permission
    // mode, for example when a read targets a path outside the project.
    if (activePlanMode && planModeToolBlockReason(event)) return undefined;
    if (!shouldRequestPiToolPermission(event)) return undefined;
    if (!context?.hasUI) {
      return { block: true, reason: "Hpp permission approval is unavailable" };
    }
    const approved = await context.ui.confirm(
      "Pi 请求权限",
      `允许 Pi 执行以下操作？\n\n${describePiToolPermission(event)}`,
    );
    return approved ? undefined : { block: true, reason: "用户拒绝了该操作" };
  });
};

const isCompactionThinkingLevelSupported = (model, level) => {
  if (level === "off") return true;
  if (model?.reasoning !== true) return false;
  const map = isRecord(model?.thinkingLevelMap) ? model.thinkingLevelMap : null;
  if (!map) return level !== "xhigh" && level !== "max";
  const mapped = map[level];
  if (mapped === null) return false;
  if (level === "xhigh" || level === "max") return mapped !== undefined;
  return true;
};

const getCompactionThinkingLevel = (config, model, inheritedLevel) => {
  if (model?.reasoning !== true) return "off";
  const requested = config.thinkingLevel === "inherit"
    ? String(inheritedLevel || "off")
    : config.thinkingLevel;
  if (isCompactionThinkingLevelSupported(model, requested)) return requested;
  return ["minimal", "low", "medium", "high", "xhigh", "max"]
    .find((level) => isCompactionThinkingLevelSupported(model, level)) || "off";
};

const createCustomCompactionTarget = (config) => {
  const custom = config.customModel;
  if (config.modelMode !== "custom" || !custom.baseUrl || !custom.modelId) return null;
  return {
    model: {
      id: custom.modelId,
      name: custom.modelId,
      provider: "hpp-compaction",
      api: custom.api,
      baseUrl: custom.baseUrl.replace(/\/+$/, ""),
      reasoning: custom.reasoning,
      ...(custom.reasoning ? {
        // 用户已显式声明该自定义模型支持思考，因此允许手动选择全部通用档位。
        thinkingLevelMap: {
          minimal: "minimal",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      } : {}),
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 16384,
      ...(custom.api === "openai-completions" && custom.reasoning
        ? { compat: { supportsReasoningEffort: true } }
        : {}),
    },
    auth: {
      apiKey: custom.apiKey || "hpp-local",
    },
  };
};

const resolveCurrentCompactionTarget = async (context) => {
  const model = context?.model || session?.model;
  if (!model) throw new Error("当前 Agent 没有可用于压缩的模型");
  const registry = context?.modelRegistry || modelRegistry;
  if (!registry?.getApiKeyAndHeaders) {
    throw new Error("当前 Agent 运行时不支持解析压缩模型凭据");
  }
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth?.ok) throw new Error(auth?.error || "压缩模型认证失败");
  return { model, auth };
};

const runConfiguredCompaction = async (event, context, target, config) => {
  if (typeof sdk?.compact !== "function") {
    throw new Error("当前 Agent 运行时不支持自定义压缩");
  }
  const thinkingLevel = getCompactionThinkingLevel(config, target.model, context?.thinkingLevel || session?.thinkingLevel);
  return sdk.compact(
    event.preparation,
    target.model,
    target.auth.apiKey,
    target.auth.headers,
    event.customInstructions,
    event.signal,
    thinkingLevel,
    undefined,
    target.auth.env,
    activeSettingsManager?.getRetrySettings?.(),
  );
};

const hppCompactionExtension = (pi) => {
  pi.on("session_before_compact", async (event, context) => {
    const config = normalizeAgentCompactionConfig(activeCompactionConfig);
    const customTarget = createCustomCompactionTarget(config);
    if (customTarget) {
      try {
        return { compaction: await runConfiguredCompaction(event, context, customTarget, config) };
      } catch (error) {
        if (event.signal?.aborted) return undefined;
        send({
          type: "status",
          id: `hpp-compaction-custom-model-fallback-${randomUUID()}`,
          status: "warning",
          title: "自定义压缩模型不可用，已回退当前模型",
          detail: error?.message || String(error),
        });
      }
    }

    try {
      const currentTarget = await resolveCurrentCompactionTarget(context);
      return { compaction: await runConfiguredCompaction(event, context, currentTarget, config) };
    } catch (error) {
      if (!event.signal?.aborted) {
        send({
          type: "status",
          id: `hpp-compaction-default-fallback-${randomUUID()}`,
          status: "warning",
          title: "独立压缩策略不可用，已使用 Agent 默认压缩",
          detail: error?.message || String(error),
        });
      }
      // 返回 undefined 让 Agent 的原生压缩流程接管，避免配置错误阻断会话恢复。
      return undefined;
    }
  });
};

const hppRuntimePolicyExtension = (pi) => {
  pi.on("before_agent_start", (event) => {
    const additions = [];
    if (activePlanMode) additions.push(PLAN_MODE_SYSTEM_PROMPT);
    // Keep the language policy last. Pi's base prompt, project context and
    // Plan policy contain substantial English text, so an earlier language
    // hint is too easy for models to mirror over visible reasoning.
    if (activeHostSystemPrompt) additions.push(activeHostSystemPrompt);
    if (additions.length === 0) return undefined;
    let systemPrompt = String(event?.systemPrompt || "").trim();
    for (const addition of additions) {
      // The host policy is also supplied through appendSystemPrompt so it is
      // present even for SDK turns that skip this hook. Move an existing copy
      // to the end instead of duplicating it; the language rule must remain
      // after Pi's English base/Plan instructions.
      if (!addition) continue;
      if (systemPrompt.includes(addition)) {
        systemPrompt = systemPrompt.split(addition).join("\n").trim();
      }
      systemPrompt = [systemPrompt, addition].filter(Boolean).join("\n\n").trim();
    }
    return {
      systemPrompt,
    };
  });
  pi.on("tool_call", (event) => {
    const reason = planModeToolBlockReason(event);
    return reason ? { block: true, reason } : undefined;
  });
};

const getShellEnvironment = (settingsManager) => {
  const configuredPath = settingsManager?.getShellPath?.();
  let shellPath = String(configuredPath || "");
  if (typeof sdk?.getShellConfig === "function") {
    try {
      shellPath = String(sdk.getShellConfig(configuredPath)?.shell || shellPath);
    } catch {
      // The existing shell probe will report an unusable configuration.
    }
  }
  return {
    platform: process.platform,
    shellPath,
    shellFamily: detectShellFamily(shellPath),
  };
};

const getAvailableToolNames = () => new Set(
  (session?.getAllTools?.() || [])
    .map((tool) => String(tool?.name || ""))
    .filter(Boolean),
);

const probeShell = (settingsManager) => {
  if (typeof sdk?.getShellConfig !== "function") return null;
  try {
    const config = sdk.getShellConfig(settingsManager?.getShellPath?.());
    if (!config?.shell || !Array.isArray(config.args)) {
      return "Pi 返回了无效的 Shell 配置";
    }
    // `echo` is available in POSIX shells, PowerShell, and cmd. Using `printf`
    // here incorrectly marked a healthy PowerShell as unavailable on Windows.
    const command = `echo ${SHELL_PROBE_TOKEN}`;
    const usesStdin = config.commandTransport === "stdin";
    const result = spawnSync(
      config.shell,
      usesStdin ? config.args : [...config.args, command],
      {
        input: usesStdin ? `${command}\n` : undefined,
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      },
    );
    if (result.status === 0 && String(result.stdout || "").includes(SHELL_PROBE_TOKEN)) return "";
    const detail = [
      result.error?.message,
      String(result.stderr || "").trim(),
      String(result.stdout || "").trim(),
      typeof result.status === "number" ? `退出码 ${result.status}` : "",
    ].filter(Boolean).join("\n");
    return detail || "Shell 启动检查失败";
  } catch (error) {
    return error?.message || String(error);
  }
};

const getWindowsShellCandidates = () => {
  if (process.platform !== "win32") return [];
  const candidates = [];
  const add = (path) => {
    const value = String(path || "").trim();
    if (value && existsSync(value)) candidates.push(value);
  };
  add(process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"));
  add(process.env.ProgramW6432 && join(process.env.ProgramW6432, "Git", "bin", "bash.exe"));
  add(process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"));
  add(process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  add(process.env.ProgramFiles && join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"));
  add(process.env.SystemRoot && join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ));
  return candidates;
};

const overrideShellPath = (settingsManager, shellPath) => new Proxy(settingsManager, {
  get(target, property, receiver) {
    if (property === "getShellPath") return () => shellPath;
    return Reflect.get(target, property, receiver);
  },
});

// Keep the user's configured shell untouched, but fall back to the first
// healthy installed shell. This explicitly includes PowerShell because Pi's
// Windows auto-detection can otherwise stop at the unusable WSL bash launcher.
const resolveShellSettings = (settingsManager) => {
  shellNotice = "";
  const configuredPath = settingsManager?.getShellPath?.();
  const configuredError = probeShell(settingsManager);
  if (!configuredError) return settingsManager;
  if (typeof sdk?.getShellConfig !== "function") return settingsManager;

  const candidates = [];
  try {
    const fallback = sdk.getShellConfig();
    if (fallback?.shell && Array.isArray(fallback.args)) candidates.push(fallback.shell);
  } catch {
    // An unavailable SDK default must not prevent explicit Windows fallbacks.
  }
  candidates.push(...getWindowsShellCandidates());

  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = process.platform === "win32"
      ? String(candidate).replaceAll("/", "\\").toLowerCase()
      : String(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    if (configuredPath && normalized === String(configuredPath).replaceAll("/", "\\").toLowerCase()) continue;
    const fallbackError = probeShell({ getShellPath: () => candidate });
    if (fallbackError) continue;
    shellNotice = configuredPath
      ? `已将不可用的 Shell ${configuredPath} 自动切换为 ${candidate}`
      : `已自动使用可用的 Shell ${candidate}`;
    return overrideShellPath(settingsManager, candidate);
  }
  return settingsManager;
};

const configureFullAccessTools = (settingsManager) => {
  const availableToolNames = getAvailableToolNames();
  const supportsTool = (name) => availableToolNames.size === 0 || availableToolNames.has(name);
  const currentToolNames = session?.getActiveToolNames?.() || [];
  shellWarning = probeShell(settingsManager) || "";
  if (shellNotice) shellWarning = "";
  shellWarningEmitted = false;
  fullAccessToolNames = [...new Set([
    ...currentToolNames.filter((name) => name !== "bash" || !shellWarning),
    ...DISCOVERY_TOOL_NAMES.filter(supportsTool),
  ])];
  planModeToolNames = fullAccessToolNames.filter((name) =>
    PLAN_READ_ONLY_TOOLS.has(normalizeToolName(name)) ||
    (normalizeToolName(name) === "bash" && !shellWarning));
  applyActiveToolMode();
};

const loadPiSDK = async () => {
  const packageRoot = String(process.env.PI_SDK_PACKAGE_ROOT || "").trim();
  if (!packageRoot) throw new Error("Pi SDK 未安装，请先在 Hpp Agent 设置中安装 Pi");
  const packageDir = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  try {
    const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const rootExport = packageJson.exports?.["."];
    const entry = typeof rootExport === "string"
      ? rootExport
      : rootExport?.import || packageJson.main;
    if (!entry) throw new Error("package.json does not define an ESM entry");
    const entryPath = resolve(packageDir, entry);
    if (!entryPath.startsWith(resolve(packageDir)) || !existsSync(entryPath)) {
      throw new Error(`Pi SDK entry does not exist: ${entryPath}`);
    }
    return import(pathToFileURL(entryPath).href);
  } catch {
    throw new Error("Pi SDK 未安装或安装不完整，请在 Hpp Agent 设置中重新安装 Pi");
  }
};

const requireSDKFactory = (name) => {
  const factory = sdk?.[name];
  if (!factory || typeof factory.create !== "function") {
    throw new Error(`Pi SDK 不兼容：缺少 ${name}.create，请在 Hpp Agent 设置中重新安装或更新 Pi`);
  }
  return factory;
};

const init = async ({ id, projectPath: cwd, sessionFilePath, hostSystemPrompt, compactionConfig }) => {
  await disposeSession();
  activeHostSystemPrompt = String(hostSystemPrompt || "").trim();
  activeCompactionConfig = normalizeAgentCompactionConfig(compactionConfig);
  projectPath = cwd;
  sdk = await loadPiSDK();
  const eventBus = sdk.createEventBus();
  const agentDir = sdk.getAgentDir();
  stripUtf8Bom(join(agentDir, "models.json"));
  stripUtf8Bom(join(agentDir, "auth.json"));
  // Pi 0.81+ replaced the public AuthStorage factory with ModelRuntime.
  // Keep compatibility with older SDKs while using the current API when it is
  // available.
  let authStorage;
  let createdModelRegistry;
  let modelRuntime;
  if (sdk.ModelRuntime && typeof sdk.ModelRuntime.create === "function") {
    modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    createdModelRegistry = new sdk.ModelRegistry(modelRuntime);
    try {
      await createdModelRegistry.refresh?.();
    } catch {
      // Offline or network error – fall back to whatever models.json already
      // contains from a previous successful refresh.
    }
  } else {
    authStorage = requireSDKFactory("AuthStorage").create(join(agentDir, "auth.json"));
    createdModelRegistry = requireSDKFactory("ModelRegistry").create(authStorage, join(agentDir, "models.json"));
  }
  const settingsManager = requireSDKFactory("SettingsManager").create(cwd, agentDir);
  const effectiveSettingsManager = resolveShellSettings(settingsManager);
  activeSettingsManager = effectiveSettingsManager;
  shellEnvironment = getShellEnvironment(effectiveSettingsManager);
  shellAvailable = !probeShell(effectiveSettingsManager);
  const shellEnvironmentContract = buildShellEnvironmentContract({
    ...shellEnvironment,
    cwd,
    shellAvailable,
  });
  const hppSubagentExtension = createHppSubagentExtension({
    packageRoot: process.env.PI_SDK_PACKAGE_ROOT,
    agentDir,
    hostSystemPrompt: activeHostSystemPrompt,
    nodePath: process.env.PI_NODE_PATH || process.execPath,
    getPermissionMode: () => activePermissionMode,
    requestUI: requestSubagentUI,
    dismissUI: dismissSubagentUIRequests,
  });
  resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: effectiveSettingsManager,
    eventBus,
    // Keep workflow prompt templates after user/project prompt paths. Pi's
    // prompt loader keeps the first template with a given name, so an explicit
    // user or project /implement prompt overrides this built-in fallback.
    additionalPromptTemplatePaths: existsSync(BUILTIN_SUBAGENT_PROMPT_DIR)
      ? [BUILTIN_SUBAGENT_PROMPT_DIR]
      : [],
    // Pi loads configured extensions before inline factories and resolves
    // duplicate tool names using the first registration. Keep the built-in
    // subagent last so a user/project/installed Pi extension wins.
    extensionFactories: [
      hppPermissionExtension,
      hppRuntimePolicyExtension,
      hppCompactionExtension,
      hppSubagentExtension,
    ],
    appendSystemPrompt: [
      FILE_DISCOVERY_GUIDANCE,
      shellEnvironmentContract,
      // Put the host policy in Pi's native base prompt as well as the
      // per-turn hook. This mirrors a project SYSTEM.md without creating or
      // mutating one, and covers autonomous/continuation turns.
      activeHostSystemPrompt,
    ].filter(Boolean),
  });
  await resourceLoader.reload();
  const loadedExtensions = resourceLoader.getExtensions?.()?.extensions || [];
  const permissionExtensionLoaded = loadedExtensions.some((extension) =>
    String(extension?.path || "") === "<inline:1>" &&
    typeof extension?.handlers?.get === "function" &&
    (extension.handlers.get("tool_call")?.length || 0) > 0);
  if (!permissionExtensionLoaded) {
    throw new Error("Pi SDK 不支持 Hpp 权限钩子，请在 Hpp Agent 设置中更新 Pi SDK");
  }
  const sessionManager = sessionFilePath
    ? sdk.SessionManager.open(sessionFilePath, undefined, cwd)
    : requireSDKFactory("SessionManager").create(cwd);
  const result = await sdk.createAgentSession({
    cwd,
    agentDir,
    ...(modelRuntime ? { modelRuntime } : { authStorage, modelRegistry: createdModelRegistry }),
    settingsManager: effectiveSettingsManager,
    resourceLoader,
    sessionManager,
  });
  session = result.session;
  // Re-evaluate a restored setting so the session enforces the current
  // model's supported levels; sessions opened from disk may carry a value
  // the SDK accepted before the model catalogue was known.
  if (typeof session?.thinkingLevel === "string") {
    session?.setThinkingLevel?.(session.thinkingLevel);
  }
  modelRegistry = createdModelRegistry || session.modelRegistry || null;
  uiBridge = new DesktopUIBridge(eventBus);
  await session.bindExtensions({
    uiContext: uiBridge.uiContext,
    mode: "tui",
    commandContextActions: buildCommandContextActions(session),
  });
  configureFullAccessTools(effectiveSettingsManager);
  activePermissionMode = "full-access";
  activePlanMode = false;
  unsubscribe = session.subscribe(handleSessionEvent);
  send({ type: "history_snapshot", messages: buildHistorySnapshot(session.sessionManager) });
  send({ type: "ready", id, sessionFilePath: session.sessionFile });
};

const actionText = (value) => typeof value === "string" ? value.trim() : "";

const actionEntry = (kind, value) => {
  if (!isRecord(value)) return null;
  const name = actionText(value.name || value.command || value.id).replace(/^\//, "");
  if (!name) return null;
  const description = actionText(value.description || value.summary);
  const argumentHint = actionText(value.argumentHint || value.argument_hint || value.usage || value.arguments);
  return {
    kind,
    name,
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
  };
};

const getActions = async (reload = false) => {
  if (!resourceLoader) throw new Error("Pi SDK resource loader is not initialized");
  if (reload) await resourceLoader.reload();
  const entries = [];
  const skills = resourceLoader.getSkills?.()?.skills;
  if (Array.isArray(skills)) {
    for (const value of skills) {
      const entry = actionEntry("skill", value);
      if (entry) entries.push(entry);
    }
  }
  const prompts = resourceLoader.getPrompts?.()?.prompts;
  if (Array.isArray(prompts)) {
    for (const value of prompts) {
      const entry = actionEntry("command", value);
      if (entry) entries.push(entry);
    }
  }
  const extensions = resourceLoader.getExtensions?.()?.extensions;
  if (Array.isArray(extensions)) {
    for (const extension of extensions) {
      const commands = isRecord(extension) && Array.isArray(extension.commands) ? extension.commands : [];
      for (const value of commands) {
        const entry = actionEntry("command", value);
        if (entry) entries.push(entry);
      }
    }
  }
  const unique = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  actionKeys.clear();
  for (const key of seen) actionKeys.add(key);
  return unique;
};

const resolveActionPrompt = async (action, message) => {
  if (!action) return message;
  const kind = action.kind === "skill" || action.kind === "command" ? action.kind : "";
  const name = actionText(action.name).replace(/^\//, "");
  if (!kind || !name) throw new Error("ACTION_NOT_SUPPORTED: Invalid Pi action");
  await getActions(false);
  if (!actionKeys.has(`${kind}:${name}`)) throw new Error(`ACTION_NOT_FOUND: ${name}`);
  const command = kind === "skill" ? `/skill:${name}` : `/${name}`;
  return message ? `${command} ${message}` : command;
};

const handleSessionEvent = (event) => {
  if (event.type === "compaction_start") {
    activeCompactionId = randomUUID();
    send({ type: "context_compaction", id: activeCompactionId, phase: "started" });
    return;
  }
  if (event.type === "compaction_end") {
    send({
      type: "context_compaction",
      id: activeCompactionId || randomUUID(),
      phase: event.aborted ? "interrupted" : "completed",
      error: event.errorMessage,
    });
    activeCompactionId = null;
    return;
  }
  if (isContextCompactionLike(event.type, event.name, event.title, event.message)) {
    send({ type: "context_compaction", id: event.id || event.itemId || event.messageId });
    return;
  }

  switch (event.type) {
    case "agent_start":
      send({ type: "agent_start" });
      break;
    case "message_start": {
      // Pi's steer() only queues the message; the agent consumes it right
      // before its next assistant output and emits message_start (user) at
      // that point. Signal the backend so the guidance bubble is placed at
      // the start of the guidance response, not earlier.
      if (pendingGuidanceDelivered && isRecord(event.message) && event.message.role === "user") {
        pendingGuidanceDelivered = false;
        send({ type: "guidance_delivered" });
      }
      break;
    }
    case "agent_end":
      send({ type: "agent_end" });
      break;
    case "agent_settled":
      finishPrompt(activePromptId);
      break;
    case "message_update": {
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent?.type === "text_delta") {
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: assistantEvent.delta || "" } });
      } else if (assistantEvent?.type === "thinking_delta") {
        send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: assistantEvent.delta || "" } });
      }
      break;
    }
    case "message_end": {
      const message = event.message;
      if (message?.role === "assistant") {
        const promptId = activePromptId;
        const previousLeafId = session?.sessionManager.getLeafId?.();
        const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
        // Pi 的 usage.input 只是未命中缓存的部分，缓存命中的输入记在 cacheRead；
        // 服务商侧统计的输入 token = input + cacheRead + cacheWrite，这里保持一致。
        const inputTokens = (Number(usage?.input) || 0)
          + (Number(usage?.cacheRead) || 0)
          + (Number(usage?.cacheWrite) || 0);
        send({
          type: "message_end",
          message: {
            role: "assistant",
            text: getTextFromMessage(message),
            thinking: getThinkingFromMessage(message),
            stopReason: message.stopReason,
            errorMessage: getErrorFromMessage(message),
          },
          inputTokens,
          outputTokens: Number(usage?.output) || 0,
          cacheInputTokens: Number(usage?.cacheRead) || 0,
        });
        emitLatestAssistantTurnMetadata(promptId, previousLeafId);
      }
      break;
    }
    case "auto_retry_start":
      send({
        type: "status",
        id: `pi-retry-${event.attempt}`,
        status: "retrying",
        title: `Pi 正在自动重试 (${event.attempt}/${event.maxAttempts})`,
        detail: event.errorMessage,
      });
      break;
    case "auto_retry_end":
      send({
        type: "status",
        id: `pi-retry-${event.attempt}`,
        status: event.success ? "completed" : "error",
        title: event.success ? "Pi 自动重试成功" : "Pi 自动重试失败",
        detail: event.finalError,
      });
      break;
    case "tool_execution_start":
      uiBridge?.cacheInteractArgs(event.toolName, event.args);
      send({
        type: "tool_execution_start",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
      });
      break;
    case "tool_execution_update":
      send({
        type: "tool_execution_update",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
        partialResult: event.partialResult,
      });
      break;
    case "tool_execution_end":
      send({
        type: "tool_execution_end",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
        result: event.result,
        isError: event.isError,
      });
      break;
  }
};

// Mirrors pi-ai's getSupportedThinkingLevels so every registry model (not just
// the active session model) can expose its own thinking levels without
// depending on pi-ai's internal compat entrypoint. Unknown level ids are
// preserved as-is by Hpp's UI label helper.
const PI_STANDARD_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 内置目录的能力 map 是否声明完整（7 个标准档位都有键）。 */
const isCompleteThinkingLevelMap = (map) =>
  PI_STANDARD_THINKING_LEVELS.every((level) => Object.prototype.hasOwnProperty.call(map, level));

/** 能力 map 中显式声明“不支持”(null) 的档位数。 */
const countNullThinkingLevels = (map) =>
  PI_STANDARD_THINKING_LEVELS.filter((level) => map[level] === null).length;

// Lazy index of the SDK's built-in catalogue capability maps. Hpp-synced
// models.json entries for custom channels carry only id/name/reasoning/input,
// so pi reports the default 5 levels for them. When a model omits its own
// map, fall back to the built-in entry (provider+id first, then id) so
// well-known models expose their real levels without manual configuration.
let builtinThinkingLevelMaps = null;
let builtinThinkingLevelMapsFailed = false;

const getBuiltinThinkingLevelMaps = async () => {
  if (builtinThinkingLevelMaps || builtinThinkingLevelMapsFailed) return builtinThinkingLevelMaps;
  try {
    if (typeof sdk?.ModelRuntime?.create !== "function" || typeof sdk?.ModelRegistry !== "function") {
      builtinThinkingLevelMapsFailed = true;
      return null;
    }
    // modelsPath: null keeps only the built-in catalogue (no custom models.json).
    const runtime = await sdk.ModelRuntime.create({ modelsPath: null });
    const registry = new sdk.ModelRegistry(runtime);
    const maps = new Map();
    for (const model of registry.getAll?.() || []) {
      if (!isRecord(model) || !model.id) continue;
      const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : null;
      if (!map || Object.keys(map).length === 0) continue;
      const provider = String(model.provider || "");
      if (!maps.has(`provider:${provider}:${model.id}`)) maps.set(`provider:${provider}:${model.id}`, map);
      // 按 id 兜底时优先采用“声明完整”的能力 map：目录中同一模型可能有多个
      // provider 条目且声明质量不一（例如 azure 条目只写了 off/xhigh/max，其余
      // 档位缺键会被“缺键=支持”误读为全部支持，导致多出本不支持的档位）。
      // 完整声明（7 个标准档都有键）能给出准确的支持列表；完整声明之间优先
      // “显式排除(null)更多”的保守声明，避免向自定义渠道过度承诺其不支持的档位。
      const idKey = `id:${model.id}`;
      const existing = maps.get(idKey);
      if (!existing) {
        maps.set(idKey, map);
      } else if (isCompleteThinkingLevelMap(map) && !isCompleteThinkingLevelMap(existing)) {
        maps.set(idKey, map);
      } else if (
        isCompleteThinkingLevelMap(map)
        && isCompleteThinkingLevelMap(existing)
        && countNullThinkingLevels(map) > countNullThinkingLevels(existing)
      ) {
        maps.set(idKey, map);
      }
    }
    builtinThinkingLevelMaps = maps;
    return maps;
  } catch {
    builtinThinkingLevelMapsFailed = true;
    return null;
  }
};

const getModelSupportedThinkingLevels = async (model) => {
  if (!isRecord(model)) return undefined;
  if (model.reasoning !== true) return { levels: ["off"], hasDeclaredLevels: false };
  let map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : null;
  let hasDeclaredLevels = !!map && Object.keys(map).length > 0;
  if (!map) {
    const builtinMaps = await getBuiltinThinkingLevelMaps();
    if (builtinMaps) {
      map = builtinMaps.get(`provider:${model.provider}:${model.id}`)
        || builtinMaps.get(`id:${model.id}`)
        || null;
      // 目录/条目声明过档位（如 deepseek 的 high/max）才视为“有档位”；
      // 无任何档位声明的模型（如 mimo）只有思考开关，走默认 5 档。
      hasDeclaredLevels = !!map;
    }
  }
  const effectiveMap = map || {};
  if (Object.keys(effectiveMap).length === 0) {
    return { levels: ["off", "minimal", "low", "medium", "high"], hasDeclaredLevels: false };
  }
  return {
    levels: PI_STANDARD_THINKING_LEVELS.filter((level) => {
      const mapped = effectiveMap[level];
      if (mapped === null) return false;
      if (level === "xhigh" || level === "max") return mapped !== undefined;
      return true;
    }),
    hasDeclaredLevels: true,
  };
};

const getModels = async () => {
  const models = modelRegistry?.getAvailable?.() || [];
  const activeModel = session?.model;
  // Fallback for SDKs whose catalogue records lack a thinkingLevelMap.
  const activeThinkingLevels = typeof session?.getAvailableThinkingLevels === "function"
    ? session.getAvailableThinkingLevels()
    : undefined;
  const results = [];
  for (const model of models) {
    const computed = await getModelSupportedThinkingLevels(model);
    const isActive = activeModel &&
      model.provider === activeModel.provider &&
      (model.id || model.modelId) === (activeModel.id || activeModel.modelId);
    // 思考档位呈现模式：声明了档位且非 off 档位 >1 → 下拉；否则（无声明 / 只 1 档）→ 开关。
    const declaredLevels = (computed?.levels || []).filter((level) => level !== "off");
    const hasMultipleDeclaredLevels = computed?.hasDeclaredLevels === true && declaredLevels.length > 1;
    results.push({
      id: model.id || model.modelId,
      name: model.name || model.id || model.modelId,
      provider: model.provider,
      reasoning: !!model.reasoning,
      supportsImages: Array.isArray(model.input) ? model.input.includes("image") : false,
      supportedThinkingLevels: computed?.levels || (isActive ? activeThinkingLevels : undefined),
      thinkingLevelMode: model.reasoning === true
        ? (hasMultipleDeclaredLevels ? "levels" : "toggle")
        : undefined,
    });
  }
  return results;
};

const handleCommand = async (command) => {
  try {
    switch (command.type) {
      case "init":
        await init(command);
        break;
      case "prompt":
        if (!session) throw new Error("Pi SDK session is not initialized");
        setPermissionMode(["ask", "auto", "full-access"].includes(command.permissionMode)
          ? command.permissionMode
          : "auto");
        setPlanMode(command.planModeEnabled === true);
        if (typeof command.hostSystemPrompt === "string") {
          activeHostSystemPrompt = command.hostSystemPrompt.trim();
        }
        activePromptId = command.id;
        completedPromptIds.delete(command.id);
        if (shellWarning && !shellWarningEmitted) {
          shellWarningEmitted = true;
          send({
            type: "status",
            id: "pi-shell-unavailable",
            status: "warning",
            title: "Pi Shell 不可用，已改用文件发现工具",
            detail: shellWarning,
          });
        }
        send({ type: "accepted", id: command.id });
        session.prompt(await resolveActionPrompt(command.action, command.message), { images: command.images })
          .then(() => {
            finishPrompt(command.id);
          })
          .catch((error) => {
            if (activePromptId === command.id) activePromptId = null;
            send({ type: "error", id: command.id, error: error?.message || String(error) });
          });
        break;
      case "guidance":
        if (!session) throw new Error("Pi SDK session is not initialized");
        if (typeof session.steer !== "function") {
          throw new Error("Pi SDK session does not support guidance");
        }
        if (typeof command.hostSystemPrompt === "string") {
          activeHostSystemPrompt = command.hostSystemPrompt.trim();
        }
        await session.steer(command.message, command.images);
        send({ type: "guidance_done", id: command.id });
        pendingGuidanceDelivered = true;
        break;
      case "forkSession": {
        const result = await forkSessionAtMessage(command);
        send({ type: "fork_session_result", id: command.id, ...result });
        break;
      }
      case "abort":
        uiBridge?.dismissAll("abort");
        dismissSubagentUIRequests(undefined, "abort");
        await session?.abort();
        send({ type: "aborted", id: command.id });
        break;
      case "getModels":
        send({ type: "models", id: command.id, models: await getModels() });
        break;
      case "listActions":
        send({ type: "actions", id: command.id, actions: await getActions(command.reload === true) });
        break;
      case "setModel": {
        if (!session) throw new Error("Pi SDK session is not initialized");
        const registeredModel = modelRegistry?.find?.(command.provider, command.modelId);
        if (!registeredModel) {
          const loadError = modelRegistry?.getError?.();
          throw new Error(
            loadError
              ? `Pi model config failed to load: ${loadError}`
              : `Pi model is not available: ${command.provider}/${command.modelId}`
          );
        }
        if (!modelRegistry?.hasConfiguredAuth?.(registeredModel)) {
          throw new Error(`No API key found for model: ${command.provider}/${command.modelId}`);
        }
        await session.setModel(registeredModel);
        send({ type: "model_changed", id: command.id, model: { id: command.modelId, provider: command.provider } });
        break;
      }
      case "setThinkingLevel":
        session?.setThinkingLevel(command.level);
        send({ type: "thinking_level_changed", id: command.id, level: session?.thinkingLevel || command.level });
        break;
      case "setCompactionConfig":
        activeCompactionConfig = normalizeAgentCompactionConfig(command.config);
        send({ type: "compaction_config_changed", id: command.id, config: activeCompactionConfig });
        break;
      case "uiResponse":
        if (!uiBridge?.handleResponse(command.response) && !handleSubagentUIResponse(command.response)) {
          const responseId = command.response?.id;
          throw new Error(responseId
            ? `Unknown Pi UI request: ${responseId}`
            : "Pi UI response is missing request id");
        }
        send({ type: "ui_response_done", id: command.id });
        break;
      case "dispose":
        await disposeSession();
        process.exit(0);
        break;
    }
  } catch (error) {
    send({ type: "error", id: command.id, error: error?.message || String(error) });
  }
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    void handleCommand(JSON.parse(line));
  } catch (error) {
    send({ type: "error", error: error?.message || String(error) });
  }
});

process.on("uncaughtException", (error) => {
  send({ type: "error", error: error?.message || String(error) });
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
  send({ type: "error", error: error?.message || String(error) });
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});
