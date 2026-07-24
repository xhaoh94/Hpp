import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { getPiMessageText, resolvePiForkEntryId } from "./pi-fork-utils.mjs";

const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
const DISCOVERY_TOOL_NAMES = ["grep", "find", "ls"];
const PLAN_MODE_TOOLS = ["read", "grep", "find", "ls", "ask_user_question", "questionnaire", "question"];
const QUESTIONNAIRE_TOOLS = new Set(["ask_user_question", "questionnaire", "question"]);
const SHELL_PROBE_TOKEN = "hpp-shell-ready";
const FILE_DISCOVERY_GUIDANCE = [
  "When a target file path is unknown, use ls, find, or grep to discover it before calling read.",
  "Do not guess multiple filenames and probe them one by one.",
  "If bash is unavailable, continue with ls, find, and grep instead of retrying shell-based discovery.",
].join(" ");

let sdk = null;
let session = null;
let modelRegistry = null;
let resourceLoader = null;
let uiBridge = null;
let unsubscribe = null;
let projectPath = "";
let activePromptId = null;
let activePermissionMode = "full-access";
let fullAccessToolNames = [];
let shellWarning = "";
let shellNotice = "";
let shellWarningEmitted = false;
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

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

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
    if (!pending) return;
    pending.resolve(response);
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

const disposeSession = () => {
  activePromptId = null;
  activePermissionMode = "full-access";
  fullAccessToolNames = [];
  activeCompactionId = null;
  completedPromptIds.clear();
  unsubscribe?.();
  unsubscribe = null;
  uiBridge?.dispose();
  uiBridge = null;
  session?.dispose();
  session = null;
  modelRegistry = null;
  resourceLoader = null;
  actionKeys.clear();
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

const setPermissionMode = (permissionMode) => {
  if (!session?.setActiveToolsByName) return;
  if (permissionMode === "plan") {
    // Keep the complete set captured during initialization; a repeated plan
    // prompt must not overwrite it with the already-restricted tool set.
    if (activePermissionMode !== "plan" && fullAccessToolNames.length === 0) {
      fullAccessToolNames = session.getActiveToolNames?.() || fullAccessToolNames;
    }
    session.setActiveToolsByName(PLAN_MODE_TOOLS);
  } else {
    session.setActiveToolsByName(fullAccessToolNames);
  }
  activePermissionMode = permissionMode;
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
    const command = `printf ${SHELL_PROBE_TOKEN}`;
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

// Keep the user's configured shell untouched, but fall back to an installed
// shell (for example Git Bash) when that configuration points at a dead path.
const resolveShellSettings = (settingsManager) => {
  shellNotice = "";
  const configuredPath = settingsManager?.getShellPath?.();
  const configuredError = probeShell(settingsManager);
  if (!configuredError) return settingsManager;
  if (typeof sdk?.getShellConfig !== "function") return settingsManager;
  try {
    const fallback = sdk.getShellConfig();
    if (!fallback?.shell || !Array.isArray(fallback.args)) return settingsManager;
    const fallbackError = probeShell({ getShellPath: () => fallback.shell });
    if (fallbackError) return settingsManager;
    shellNotice = configuredPath
      ? `已将不可用的 Shell ${configuredPath} 自动切换为 ${fallback.shell}`
      : `已自动使用可用的 Shell ${fallback.shell}`;
    return new Proxy(settingsManager, {
      get(target, property, receiver) {
        if (property === "getShellPath") return () => fallback.shell;
        return Reflect.get(target, property, receiver);
      },
    });
  } catch {
    return settingsManager;
  }
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
  session?.setActiveToolsByName?.(fullAccessToolNames);
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

const init = async ({ id, projectPath: cwd, sessionFilePath }) => {
  disposeSession();
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
    await createdModelRegistry.refresh?.();
  } else {
    authStorage = requireSDKFactory("AuthStorage").create(join(agentDir, "auth.json"));
    createdModelRegistry = requireSDKFactory("ModelRegistry").create(authStorage, join(agentDir, "models.json"));
  }
  const settingsManager = requireSDKFactory("SettingsManager").create(cwd, agentDir);
  const effectiveSettingsManager = resolveShellSettings(settingsManager);
  resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: effectiveSettingsManager,
    eventBus,
    appendSystemPrompt: [FILE_DISCOVERY_GUIDANCE],
  });
  await resourceLoader.reload();
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
  modelRegistry = createdModelRegistry || session.modelRegistry || null;
  uiBridge = new DesktopUIBridge(eventBus);
  await session.bindExtensions({
    uiContext: uiBridge.uiContext,
    mode: "tui",
    commandContextActions: buildCommandContextActions(session),
  });
  configureFullAccessTools(effectiveSettingsManager);
  activePermissionMode = "full-access";
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
    return;
  }
  if (event.type === "compaction_end") {
    if (!event.aborted) send({ type: "context_compaction", id: activeCompactionId || randomUUID() });
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
        send({
          type: "message_end",
          message: {
            role: "assistant",
            text: getTextFromMessage(message),
            thinking: getThinkingFromMessage(message),
            stopReason: message.stopReason,
            errorMessage: getErrorFromMessage(message),
          },
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

const getModels = () => {
  const models = modelRegistry?.getAvailable?.() || [];
  return models.map((model) => ({
    id: model.id || model.modelId,
    name: model.name || model.id || model.modelId,
    provider: model.provider,
    reasoning: !!model.reasoning,
    supportsImages: Array.isArray(model.input) ? model.input.includes("image") : false,
  }));
};

const handleCommand = async (command) => {
  try {
    switch (command.type) {
      case "init":
        await init(command);
        break;
      case "prompt":
        if (!session) throw new Error("Pi SDK session is not initialized");
        setPermissionMode(command.permissionMode === "plan" || command.planModeEnabled ? "plan" : "full-access");
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
        await session.steer(command.message, command.images);
        send({ type: "guidance_done", id: command.id });
        break;
      case "forkSession": {
        const result = await forkSessionAtMessage(command);
        send({ type: "fork_session_result", id: command.id, ...result });
        break;
      }
      case "abort":
        uiBridge?.dismissAll("abort");
        await session?.abort();
        send({ type: "aborted", id: command.id });
        break;
      case "getModels":
        send({ type: "models", id: command.id, models: getModels() });
        break;
      case "listActions":
        send({ type: "actions", id: command.id, actions: await getActions(command.reload === true) });
        break;
      case "setModel": {
        if (!session) throw new Error("Pi SDK session is not initialized");
        const model = modelRegistry?.find?.(command.provider, command.modelId);
        if (!model) {
          const loadError = modelRegistry?.getError?.();
          throw new Error(
            loadError
              ? `Pi model config failed to load: ${loadError}`
              : `Pi model is not available: ${command.provider}/${command.modelId}`
          );
        }
        if (!modelRegistry?.hasConfiguredAuth?.(model)) {
          throw new Error(`No API key found for model: ${command.provider}/${command.modelId}`);
        }
        await session.setModel(model);
        send({ type: "model_changed", id: command.id, model: { id: command.modelId, provider: command.provider } });
        break;
      }
      case "setThinkingLevel":
        session?.setThinkingLevel(command.level);
        send({ type: "thinking_level_changed", id: command.id, level: command.level });
        break;
      case "uiResponse":
        uiBridge?.handleResponse(command.response);
        break;
      case "dispose":
        disposeSession();
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
