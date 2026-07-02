import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";

let sdk = null;
let session = null;
let uiBridge = null;
let unsubscribe = null;
let projectPath = "";
let activePromptId = null;
const completedPromptIds = new Set();

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

const createDialogPromise = (emit, pending, request, parse, defaultValue, opts = {}) => {
  if (opts.signal?.aborted) return Promise.resolve(defaultValue);

  return new Promise((resolve, reject) => {
    let timeoutId;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      opts.signal?.removeEventListener("abort", onAbort);
      pending.delete(request.id);
    };
    const onAbort = () => {
      cleanup();
      opts.onDismiss?.(request.id, "abort");
      resolve(defaultValue);
    };

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeout) {
      timeoutId = setTimeout(() => {
        cleanup();
        opts.onDismiss?.(request.id, "timeout");
        resolve(defaultValue);
      }, opts.timeout);
    }

    pending.set(request.id, {
      cleanup,
      resolve: (response) => resolve(parse(response)),
      reject,
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
        this.lastAskPayload = null;
        this.interactArgs = null;
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
    pending.cleanup();
    pending.resolve(response);
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
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("UI bridge disposed"));
    }
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
  completedPromptIds.clear();
  unsubscribe?.();
  unsubscribe = null;
  uiBridge?.dispose();
  uiBridge = null;
  session?.dispose();
  session = null;
};

const init = async ({ projectPath: cwd, sessionFilePath }) => {
  disposeSession();
  projectPath = cwd;
  sdk = await import("@earendil-works/pi-coding-agent");
  const eventBus = sdk.createEventBus();
  const agentDir = sdk.getAgentDir();
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus });
  await resourceLoader.reload();
  const sessionManager = sessionFilePath
    ? sdk.SessionManager.open(sessionFilePath, undefined, cwd)
    : sdk.SessionManager.create(cwd);
  const result = await sdk.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager,
  });
  session = result.session;
  uiBridge = new DesktopUIBridge(eventBus);
  await session.bindExtensions({
    uiContext: uiBridge.uiContext,
    mode: "tui",
    commandContextActions: buildCommandContextActions(session),
  });
  unsubscribe = session.subscribe(handleSessionEvent);
  send({ type: "ready", sessionFilePath: session.sessionFile });
};

const handleSessionEvent = (event) => {
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
      {
        const promptId = activePromptId;
        setTimeout(() => finishPrompt(promptId), 250);
      }
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
      }
      break;
    }
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
  const models = session?.modelRegistry.getAvailable() || [];
  return models.map((model) => ({
    id: model.id || model.modelId,
    name: model.name || model.id || model.modelId,
    provider: model.provider,
    reasoning: !!model.reasoning,
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
        activePromptId = command.id;
        completedPromptIds.delete(command.id);
        send({ type: "accepted", id: command.id });
        session.prompt(command.message, { images: command.images })
          .then(() => {
            finishPrompt(command.id);
          })
          .catch((error) => {
            if (activePromptId === command.id) activePromptId = null;
            send({ type: "error", id: command.id, error: error?.message || String(error) });
          });
        break;
      case "abort":
        await session?.abort();
        send({ type: "aborted", id: command.id });
        break;
      case "getModels":
        send({ type: "models", id: command.id, models: getModels() });
        break;
      case "setModel": {
        const model = session?.modelRegistry.find(command.provider, command.modelId);
        if (model) await session?.setModel(model);
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
});
process.on("unhandledRejection", (error) => {
  send({ type: "error", error: error?.message || String(error) });
});
