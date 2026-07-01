import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

const DEFAULT_MODEL_ID = "default";
const CODEX_PROVIDER = "codex";
const VALID_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

let codex = null;
let thread = null;
let threadId = null;
let projectPath = "";
let currentModelId = null;
let thinkingLevel = "medium";
let activeAbortController = null;
let activePromptId = null;
let promptRunning = false;

let streamStarted = false;
let finalResponse = "";
let agentTextByItemId = new Map();
let reasoningTextByItemId = new Map();
let completedItemIds = new Set();

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const stringifyValue = (value) => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const truncate = (value, maxLength = 1200) => {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
};

const getImageExtension = (mimeType) => {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  return ".png";
};

const materializeImages = async (images) => {
  if (!Array.isArray(images) || images.length === 0) {
    return { entries: [], cleanup: async () => {} };
  }

  const dir = await mkdtemp(join(tmpdir(), "hpp-codex-images-"));
  const entries = [];

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const rawData = String(image?.data || "").replace(/^data:.*?;base64,/, "");
    if (!rawData) continue;

    const filePath = join(dir, `image-${index + 1}${getImageExtension(image?.mimeType)}`);
    await writeFile(filePath, Buffer.from(rawData, "base64"));
    entries.push({ type: "local_image", path: filePath });
  }

  return {
    entries,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

const getModels = () => {
  const models = [
    ...readConfiguredModels(),
    {
      id: DEFAULT_MODEL_ID,
      name: "Codex default",
      provider: CODEX_PROVIDER,
      reasoning: true,
    },
  ];
  const seen = new Set();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
};

const getCodexConfigPath = () => {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "config.toml");
};

const stripTomlComment = (line) => {
  let inString = false;
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = index > 0 ? line[index - 1] : "";
    if ((char === "\"" || char === "'") && previous !== "\\") {
      if (!inString) {
        inString = true;
        quote = char;
      } else if (quote === char) {
        inString = false;
        quote = "";
      }
    }
    if (char === "#" && !inString) return line.slice(0, index);
  }
  return line;
};

const parseTomlString = (value) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^["'](.+)["']$/);
  return match ? match[1] : trimmed;
};

const formatModelName = (modelId) =>
  modelId
    .split("-")
    .map((part) => part.toLowerCase() === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");

const parseConfiguredModels = (content) => {
  const models = [];
  const seen = new Set();
  let section = "";

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }

    const modelMatch = line.match(/^model\s*=\s*(.+)$/);
    if (!modelMatch) continue;
    if (section && !section.startsWith("profiles.")) continue;

    const modelId = parseTomlString(modelMatch[1]).trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    models.push({
      id: modelId,
      name: formatModelName(modelId),
      provider: CODEX_PROVIDER,
      reasoning: true,
    });
  }

  return models;
};

let configuredModelsCache = null;
const readConfiguredModels = () => configuredModelsCache || [];

const loadConfiguredModels = async () => {
  try {
    configuredModelsCache = parseConfiguredModels(await readFile(getCodexConfigPath(), "utf8"));
  } catch {
    configuredModelsCache = [];
  }
};

const normalizeReasoningEffort = (level) => {
  const normalized = String(level || "").trim();
  return VALID_REASONING_EFFORTS.has(normalized) ? normalized : undefined;
};

const buildThreadOptions = () => {
  const options = {
    workingDirectory: projectPath,
    skipGitRepoCheck: true,
  };

  const effort = normalizeReasoningEffort(thinkingLevel);
  if (effort) options.modelReasoningEffort = effort;

  if (currentModelId && currentModelId !== DEFAULT_MODEL_ID) {
    options.model = currentModelId;
  }

  return options;
};

const createThreadForTurn = () => {
  if (!codex) throw new Error("Codex SDK is not initialized");

  const options = buildThreadOptions();
  if (threadId) {
    thread = codex.resumeThread(threadId, options);
  } else if (!thread) {
    thread = codex.startThread(options);
  }
  return thread;
};

const startStream = () => {
  if (streamStarted) return;
  streamStarted = true;
  send({ type: "agent_start" });
  send({ type: "stream_start", role: "assistant" });
};

const getTextDelta = (map, id, nextText) => {
  const previous = map.get(id) || "";
  map.set(id, nextText);
  if (!nextText) return "";
  if (nextText.startsWith(previous)) return nextText.slice(previous.length);
  return nextText;
};

const getFilesFromChanges = (changes) => {
  if (!Array.isArray(changes)) return [];

  return changes
    .filter((change) => typeof change?.path === "string" && change.path.trim())
    .map((change) => ({
      file: change.path,
      label: basename(change.path),
      action: change.kind === "add" ? "written" : "edited",
      status:
        change.kind === "add"
          ? "added"
          : change.kind === "delete"
            ? "deleted"
            : "modified",
    }));
};

const emitCommandItem = (item, phase) => {
  const command = item.command || "";
  const outputText = item.aggregated_output || "";
  const terminal = phase === "completed" || item.status === "completed" || item.status === "failed";
  const payload = {
    toolName: "shell",
    toolCallId: item.id,
    toolKind: "run_command",
    args: { command },
    command,
    result: terminal
      ? { output: outputText, exit_code: item.exit_code, status: item.status }
      : undefined,
    outputText,
    detail: truncate([command ? `$ ${command}` : "", outputText].filter(Boolean).join("\n")),
    isError: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0),
  };

  send({ type: terminal ? "tool_end" : "tool_start", ...payload });
};

const emitFileChangeItem = (item, phase) => {
  const files = getFilesFromChanges(item.changes);
  const terminal = phase === "completed" || item.status === "completed" || item.status === "failed";
  send({
    type: terminal ? "tool_end" : "tool_start",
    toolName: "file_change",
    toolCallId: item.id,
    toolKind: "edit_file",
    args: { changes: item.changes },
    result: terminal ? { changes: item.changes, status: item.status } : undefined,
    detail: files.map((file) => file.file).join("\n"),
    files,
    isError: item.status === "failed",
  });
};

const emitMcpToolItem = (item, phase) => {
  const terminal = phase === "completed" || item.status === "completed" || item.status === "failed";
  const toolName = [item.server, item.tool].filter(Boolean).join(".") || "mcp_tool";
  const resultText = item.error?.message || stringifyValue(item.result);
  send({
    type: terminal ? "tool_end" : "tool_start",
    toolName,
    toolCallId: item.id,
    toolKind: "unknown",
    args: item.arguments,
    result: item.result,
    outputText: resultText,
    errorText: item.error?.message,
    detail: truncate(resultText),
    isError: item.status === "failed" || !!item.error,
  });
};

const emitWebSearchItem = (item, phase) => {
  send({
    type: phase === "completed" ? "tool_end" : "tool_start",
    toolName: "web_search",
    toolCallId: item.id,
    toolKind: "web_search",
    args: { query: item.query },
    result: phase === "completed" ? { query: item.query } : undefined,
    detail: item.query,
    isError: false,
  });
};

const emitTodoListItem = (item, phase) => {
  const detail = Array.isArray(item.items)
    ? item.items.map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`).join("\n")
    : "";

  send({
    type: "process_event",
    entryType: "status",
    title: "Codex todo list",
    detail,
    state: phase === "completed" ? "completed" : "running",
  });
};

const handleItemEvent = (item, phase) => {
  if (!item?.id || !item?.type) return;
  if (phase === "completed" && completedItemIds.has(item.id)) return;

  switch (item.type) {
    case "agent_message": {
      const text = item.text || "";
      const delta = getTextDelta(agentTextByItemId, item.id, text);
      if (delta) send({ type: "stream_delta", delta });
      if (phase === "completed") {
        finalResponse = text;
        send({ type: "stream_snapshot", content: text });
      }
      break;
    }
    case "reasoning": {
      const text = item.text || "";
      const delta = getTextDelta(reasoningTextByItemId, item.id, text);
      if (delta) send({ type: "thinking_delta", delta });
      if (phase === "completed") send({ type: "thinking_end" });
      break;
    }
    case "command_execution":
      emitCommandItem(item, phase);
      break;
    case "file_change":
      emitFileChangeItem(item, phase);
      break;
    case "mcp_tool_call":
      emitMcpToolItem(item, phase);
      break;
    case "web_search":
      emitWebSearchItem(item, phase);
      break;
    case "todo_list":
      emitTodoListItem(item, phase);
      break;
    case "error":
      send({
        type: "process_event",
        entryType: "error",
        title: "Codex error",
        detail: item.message || "Unknown Codex error",
        state: "error",
      });
      break;
  }

  if (phase === "completed") completedItemIds.add(item.id);
};

const handleThreadEvent = (event) => {
  switch (event.type) {
    case "thread.started":
      threadId = event.thread_id;
      send({ type: "session_file_path", sessionFilePath: threadId, threadId });
      break;
    case "turn.started":
      startStream();
      send({
        type: "process_event",
        entryType: "status",
        title: "Codex is processing",
        state: "running",
      });
      break;
    case "item.started":
      handleItemEvent(event.item, "started");
      break;
    case "item.updated":
      handleItemEvent(event.item, "updated");
      break;
    case "item.completed":
      handleItemEvent(event.item, "completed");
      break;
    case "turn.completed":
      send({
        type: "process_event",
        entryType: "status",
        title: "Codex completed",
        detail: event.usage ? stringifyValue(event.usage) : undefined,
        state: "completed",
      });
      break;
    case "turn.failed":
      send({
        type: "process_event",
        entryType: "error",
        title: "Codex turn failed",
        detail: event.error?.message || "Codex turn failed",
        state: "error",
      });
      break;
    case "error":
      send({
        type: "process_event",
        entryType: "error",
        title: "Codex stream error",
        detail: event.message || "Codex stream error",
        state: "error",
      });
      break;
  }
};

const resetTurnState = () => {
  streamStarted = false;
  finalResponse = "";
  agentTextByItemId = new Map();
  reasoningTextByItemId = new Map();
  completedItemIds = new Set();
};

const init = async ({ projectPath: cwd, sessionFilePath }) => {
  disposeSession();
  projectPath = cwd;
  threadId = sessionFilePath || null;
  await loadConfiguredModels();
  const sdk = await import("@openai/codex-sdk");
  codex = new sdk.Codex();
  send({ type: "ready", sessionFilePath: threadId });
};

const runPrompt = async (command) => {
  if (promptRunning) throw new Error("Codex is already running");

  promptRunning = true;
  activePromptId = command.id;
  activeAbortController = new AbortController();
  resetTurnState();
  send({ type: "accepted", id: command.id });
  startStream();

  const imagePayload = await materializeImages(command.images);
  try {
    const input = imagePayload.entries.length > 0
      ? [
          { type: "text", text: command.message || "Please inspect the attached image(s)." },
          ...imagePayload.entries,
        ]
      : command.message;

    const activeThread = createThreadForTurn();
    const { events } = await activeThread.runStreamed(input, {
      signal: activeAbortController.signal,
    });

    for await (const event of events) {
      handleThreadEvent(event);
    }
  } catch (error) {
    if (activeAbortController?.signal.aborted) {
      send({
        type: "process_event",
        entryType: "status",
        title: "Codex interrupted",
        state: "interrupted",
      });
    } else {
      send({
        type: "process_event",
        entryType: "error",
        title: "Codex request failed",
        detail: error?.message || String(error),
        state: "error",
      });
    }
  } finally {
    await imagePayload.cleanup();
    send({ type: "stream_end", content: finalResponse, force: true });
    send({ type: "agent_end" });
    send({ type: "prompt_done", id: command.id });
    promptRunning = false;
    activePromptId = null;
    activeAbortController = null;
  }
};

const disposeSession = () => {
  activeAbortController?.abort();
  activeAbortController = null;
  activePromptId = null;
  promptRunning = false;
  thread = null;
  codex = null;
  resetTurnState();
};

const handleCommand = async (command) => {
  try {
    switch (command.type) {
      case "init":
        await init(command);
        break;
      case "prompt":
        void runPrompt(command);
        break;
      case "abort":
        activeAbortController?.abort();
        send({ type: "aborted", id: command.id, promptId: activePromptId });
        break;
      case "getModels":
        await loadConfiguredModels();
        send({ type: "models", id: command.id, models: getModels() });
        break;
      case "setModel":
        currentModelId =
          command.provider === CODEX_PROVIDER && command.modelId !== DEFAULT_MODEL_ID
            ? command.modelId
            : null;
        send({ type: "model_changed", id: command.id, model: { id: command.modelId, provider: command.provider } });
        break;
      case "setThinkingLevel":
        thinkingLevel = String(command.level || "medium");
        send({ type: "thinking_level_changed", id: command.id, level: thinkingLevel });
        break;
      case "uiResponse":
        send({ type: "ui_response_ignored", id: command.id });
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
