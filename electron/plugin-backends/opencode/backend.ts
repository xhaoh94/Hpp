import { join } from "path";
import { homedir, tmpdir } from "os";
import { randomUUID } from "crypto";
import { execFile, spawn, type ChildProcess } from "child_process";
import * as http from "http";
import { existsSync, readFileSync } from "fs";
import { rm, writeFile } from "fs/promises";
import { AgentEventBuffer } from "../../plugin-runtime/agent-event-buffer";
import {
  normalizeNativeSubagentStopReason,
  type NativeSubagentStopReason,
} from "../../plugin-runtime/subagent-events";
import { buildDiffsFromToolEvent, isContextCompactionLike, normalizeQuestionProcessEvent, normalizeToolEvent } from "../../plugin-runtime/process-events";
import { ToolFileDiffFallback } from "../../plugin-runtime/turn-file-diff";
import { normalizeOpenCodeSessionDiffResult, normalizeOpenCodeSessionDiffs } from "./session-diff";
import {
  getCommandEnv,
  getNpmPackageBinTarget,
  isWindowsShellShim,
  resolveCommand,
} from "../../utils/command-utils";
import type { AgentImagePayload, AgentUIResponse, UnknownRecord } from "../../../src/types/ipc";
import type { AgentPermissionMode } from "../../../shared/agent-permissions";
import { isHighRiskAgentPermissionRequest } from "../../../shared/agent-permissions";
import { normalizeSupportedThinkingLevels, normalizeThinkingLevelId } from "../../../shared/models";
import {
  isCustomAgentCompactionModelConfigured,
  normalizeAgentCompactionConfig,
  type AgentCompactionConfig,
} from "../../../shared/agent-compaction";
import { isRecord } from "../../../src/types/ipc";
import type {
  AgentActionCatalogEntry,
  AgentActionInvocation,
  AgentActionListOptions,
} from "../../../shared/agent-actions";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
  supportedThinkingLevels?: string[];
}

interface AgentSendOptions {
  planModeEnabled?: boolean;
  clientMessageId?: string;
  displayMessage?: string;
  hostSystemPrompt?: string;
  permissionMode?: AgentPermissionMode;
  action?: AgentActionInvocation;
}

interface AgentInitOptions {
  hostSystemPrompt?: string;
  compaction?: AgentCompactionConfig;
}

interface AgentForkTarget {
  newSessionId: string;
  sourceSessionFilePath?: string;
  sourceUserMessageIndex: number;
  rollbackUserMessageCount?: number;
  targetTurnId?: string;
  sourceMessageContent?: string;
  throughMessageId?: string;
}

interface AgentForkResult {
  supported: boolean;
  success: boolean;
  sessionFilePath?: string;
  nativeEntryId?: string;
  error?: string;
  reason?: string;
}

function resolveOpenCodeCommand(): string {
  const command = resolveCommand("opencode");
  if (!isWindowsShellShim(command)) return command;
  return getNpmPackageBinTarget(command, "opencode-ai", join("bin", "opencode.exe")) || command;
}

interface PendingOpenCodeUIRequest {
  kind: "question" | "permission";
  sessionId?: string;
}

type OpenCodePromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; filename: string; url: string };

interface OpenCodePromptBody {
  parts: OpenCodePromptPart[];
  system?: string;
  agent?: "plan" | "build";
  model?: { providerID: string; modelID: string };
  variant?: string;
}

interface OpenCodeCommandBody {
  command: string;
  arguments: string;
  agent?: "plan" | "build";
  model?: { providerID: string; modelID: string };
  variant?: string;
  parts?: OpenCodePromptPart[];
}

const asRecord = (value: unknown): UnknownRecord =>
  isRecord(value) ? value : {};

function formatProcessDetail(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeToolPart(props: unknown) {
  const propsRecord = asRecord(props);
  const part = asRecord(propsRecord.part || propsRecord);
  const state = asRecord(part.state);
  const toolName =
    part.tool || part.toolName || part.name || part.type || propsRecord.tool || propsRecord.toolName || "tool";
  const toolCallId = part.id || part.callID || part.callId || propsRecord.partID || propsRecord.partId || propsRecord.id || toolName;
  const args = part.input || part.args || state.input || state.args || propsRecord.input || propsRecord.args;
  const output = part.output || part.result || state.output || state.result || propsRecord.output || propsRecord.result;
  const error = part.error || state.error || propsRecord.error;

  return {
    toolName,
    toolCallId: String(toolCallId),
    args,
    result: output,
    detail: formatProcessDetail(error ? { args, error } : output !== undefined ? { args, output } : args),
    isError: !!error,
  };
}

function normalizeEventName(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function isAskUserName(value: unknown) {
  return ["ask_user", "ask_user_question", "user_ask_question"].includes(normalizeEventName(value));
}

function isToolLikePart(props: unknown) {
  const propsRecord = asRecord(props);
  const part = asRecord(propsRecord.part || propsRecord);
  const partType = part.type || propsRecord.type;
  const toolName = part.tool || part.toolName || part.name || propsRecord.tool || propsRecord.toolName || partType;
  return (
    (partType && String(partType).startsWith("tool")) ||
    isAskUserName(partType) ||
    isAskUserName(toolName)
  );
}

function isToolPartComplete(props: unknown) {
  const propsRecord = asRecord(props);
  const part = asRecord(propsRecord.part || propsRecord);
  const partState = asRecord(part.state);
  const state = partState.status || part.state || part.status || propsRecord.status;
  const normalizedState = typeof state === "string" ? state.toLowerCase() : "";
  return (
    part.output !== undefined ||
    part.result !== undefined ||
    part.error !== undefined ||
    propsRecord.output !== undefined ||
    propsRecord.result !== undefined ||
    propsRecord.error !== undefined ||
    ["done", "completed", "complete", "success", "error", "failed"].includes(normalizedState)
  );
}

type OpenCodeSubagentStatus = "pending" | "running" | "completed" | "error" | "interrupted";
type OpenCodeSubagentAction = "spawnAgent" | "resumeAgent";

interface OpenCodeSubagentSnapshot {
  toolCallId: string;
  subagentId: string;
  sessionId?: string;
  label: string;
  status: OpenCodeSubagentStatus;
  action: OpenCodeSubagentAction;
  model?: string;
  detail?: string;
  prompt?: string;
  message?: string;
  startedAt?: number;
  stopReason?: NativeSubagentStopReason;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    cost?: number;
    turns?: number;
  };
}

const OPENCODE_SUBAGENT_TOOL_NAMES = new Set(["task", "delegate_task"]);

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getFirstNonEmptyString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = getNonEmptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function getOpenCodeToolName(props: unknown): string {
  const propsRecord = asRecord(props);
  const part = asRecord(propsRecord.part || propsRecord);
  return normalizeEventName(part.tool || part.toolName || part.name || propsRecord.tool || propsRecord.toolName)
    .replace(/[\s-]+/g, "_");
}

function isOpenCodeSubagentToolPart(props: unknown): boolean {
  if (OPENCODE_SUBAGENT_TOOL_NAMES.has(getOpenCodeToolName(props))) return true;
  const propsRecord = asRecord(props);
  const part = asRecord(propsRecord.part || propsRecord);
  const partType = normalizeEventName(part.type || propsRecord.type);
  // OpenCode 把子代理建模为 SubtaskPart / AgentPart，或把子会话 id 塞进
  // task 工具的 metadata.sessionId。无论确切的工具名是什么，这些都意味着
  // 当前 part 是一个子代理调用。
  if (partType === "subtask" || partType === "agent") return true;
  const state = asRecord(part.state);
  const metadata = asRecord(state.metadata || part.metadata || propsRecord.metadata);
  return !!getFirstNonEmptyString(metadata, [
    "sessionId", "sessionID", "session_id", "taskId", "taskID", "task_id",
  ]);
}

function humanizeOpenCodeSubagentLabel(value: string): string {
  const label = value.replace(/^agent[-_:]?/i, "").replace(/[_-]+/g, " ").trim();
  return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : "Subagent";
}

function getOpenCodeSubagentLabel(input: UnknownRecord, metadata: UnknownRecord): string | undefined {
  const value = getFirstNonEmptyString(input, ["subagent_type", "subagentType", "agent", "agentName", "category"])
    || getFirstNonEmptyString(metadata, ["subagent_type", "subagentType", "agent", "agentName", "category"]);
  return value ? humanizeOpenCodeSubagentLabel(value) : undefined;
}

function formatOpenCodeSubagentModel(value: unknown): string | undefined {
  const direct = getNonEmptyString(value);
  if (direct) return direct;
  const model = asRecord(value);
  const provider = getFirstNonEmptyString(model, ["providerID", "providerId", "provider"]);
  const modelId = getFirstNonEmptyString(model, ["modelID", "modelId", "id", "name"]);
  if (provider && modelId) return `${provider}/${modelId}`;
  return modelId || provider;
}

function getOpenCodeSubagentUsage(...records: UnknownRecord[]): OpenCodeSubagentSnapshot["usage"] {
  const sources = records.flatMap((record) => [record, asRecord(record.usage), asRecord(record.metadata), asRecord(record.result), asRecord(record.output)]);
  const numberValue = (...keys: string[]) => {
    for (const source of sources) {
      for (const key of keys) {
        const number = Number(source[key]);
        if (Number.isFinite(number) && number >= 0) return number;
      }
    }
    return undefined;
  };
  const usage = {
    inputTokens: numberValue("inputTokens", "input_tokens", "prompt_tokens", "promptTokens"),
    outputTokens: numberValue("outputTokens", "output_tokens", "completion_tokens", "completionTokens"),
    cacheReadTokens: numberValue("cacheReadTokens", "cache_read_input_tokens", "cacheReadInputTokens"),
    cacheWriteTokens: numberValue("cacheWriteTokens", "cache_creation_input_tokens", "cacheWriteInputTokens"),
    totalTokens: numberValue("totalTokens", "total_tokens"),
    cost: numberValue("cost", "cost_usd", "total_cost_usd"),
    turns: numberValue("turns"),
  };
  const compact = Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function getOpenCodeTaskOutputState(value: unknown): OpenCodeSubagentStatus | undefined {
  const output = getNonEmptyString(value);
  if (!output) return undefined;
  const taskState = output.match(/<task\b[^>]*\bstate=["']?([a-z_-]+)/i)?.[1]?.toLowerCase();
  if (taskState === "running" || taskState === "pending") return taskState;
  if (["completed", "complete", "done", "success", "succeeded"].includes(taskState || "")) return "completed";
  if (["cancelled", "canceled", "interrupted", "stopped"].includes(taskState || "")) return "interrupted";
  if (["error", "failed", "failure"].includes(taskState || "") || /<task_error>/i.test(output)) return "error";
  return undefined;
}

function getOpenCodeSubagentSessionId(
  part: UnknownRecord,
  state: UnknownRecord,
  metadata: UnknownRecord,
  input: UnknownRecord,
): string | undefined {
  const direct = getFirstNonEmptyString(metadata, ["sessionId", "sessionID", "session_id", "taskId", "taskID", "task_id", "jobId"])
    || getFirstNonEmptyString(state, ["sessionId", "sessionID", "session_id", "taskId", "taskID", "task_id"])
    || getFirstNonEmptyString(part, ["childSessionId", "childSessionID"])
    || getFirstNonEmptyString(input, ["task_id", "taskId", "session_id", "sessionId"]);
  if (direct) return direct;

  const output = getNonEmptyString(state.output ?? part.output ?? state.result ?? part.result);
  if (!output) return undefined;
  return output.match(/<task\b[^>]*\bid=["']([^"']+)/i)?.[1]
    || output.match(/(?:task[_ ]id|session[_ ]id)\*{0,2}\s*[:=]\s*["']?([\w.:-]+)/i)?.[1];
}

function getOpenCodeSubagentStatus(part: UnknownRecord): OpenCodeSubagentStatus {
  const state = asRecord(part.state);
  const metadata = asRecord(state.metadata || part.metadata);
  const output = state.output ?? part.output ?? state.result ?? part.result;
  const outputState = getOpenCodeTaskOutputState(output);
  if (outputState) return outputState;

  const rawStatus = String(state.status || part.status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["pending", "queued", "not_started"].includes(rawStatus)) return "pending";
  if (["running", "active", "working", "in_progress", "inprogress"].includes(rawStatus)) return "running";
  if (["error", "failed", "failure", "errored"].includes(rawStatus)) {
    const errorText = formatProcessDetail(state.error ?? part.error) || "";
    return metadata.interrupted === true || /abort|cancel|interrupt/i.test(errorText) ? "interrupted" : "error";
  }
  if (["cancelled", "canceled", "interrupted", "stopped"].includes(rawStatus)) return "interrupted";
  if (["completed", "complete", "done", "success", "succeeded"].includes(rawStatus)) {
    // OpenCode 的后台 task 工具调用会先结束，但子会话仍在运行；它通过
    // metadata.background 和 output 中的 task state 区分工具结束与任务结束。
    if (metadata.background === true) return "running";
    return "completed";
  }
  return "running";
}

function getOpenCodePartTime(part: UnknownRecord, key: "start" | "end"): number | undefined {
  const value = Number(asRecord(asRecord(part.state).time || part.time)[key]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isTerminalOpenCodeSubagentStatus(status: OpenCodeSubagentStatus): boolean {
  return status === "completed" || status === "error" || status === "interrupted";
}

function isOpenCodeSubagentInteractionEvent(eventType: string): boolean {
  return [
    "question.asked",
    "question.v2.asked",
    "question.replied",
    "question.rejected",
    "question.v2.replied",
    "question.v2.rejected",
    "permission.asked",
    "permission.v2.asked",
    "permission.replied",
    "permission.v2.replied",
  ].includes(eventType);
}

const HPP_OPENCODE_COMPACTION_PROVIDER = "hpp-compaction";
const HPP_OPENCODE_COMPACTION_PROVIDER_NAME = "Hpp 上下文压缩";

function stripJsonComments(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      result += "  ";
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n" && source[index + 1] !== "\r") {
        result += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      result += "  ";
      index += 1;
      while (index + 1 < source.length) {
        const commentChar = source[index + 1];
        const commentNext = source[index + 2];
        if (commentChar === "*" && commentNext === "/") {
          result += "  ";
          index += 2;
          break;
        }
        result += commentChar === "\n" || commentChar === "\r" ? commentChar : " ";
        index += 1;
      }
      continue;
    }
    result += char;
  }
  return result;
}

function stripTrailingCommas(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    result += char;
  }
  return result;
}

function parseOpenCodeConfigContent(source?: string): UnknownRecord {
  if (!source?.trim()) return {};
  try {
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(source.replace(/^\uFEFF/, ""))));
    if (!isRecord(parsed)) throw new Error("configuration root must be an object");
    return parsed;
  } catch (error) {
    throw new Error(`无法解析 OpenCode 配置：${error instanceof Error ? error.message : String(error)}`);
  }
}

function readOpenCodeConfigContent(): string | undefined {
  const inlineConfig = process.env.OPENCODE_CONFIG_CONTENT;
  if (inlineConfig?.trim()) return inlineConfig;
  const configuredPath = process.env.OPENCODE_CONFIG;
  const configDir = join(homedir(), ".config", "opencode");
  const jsonPath = join(configDir, "opencode.json");
  const jsoncPath = join(configDir, "opencode.jsonc");
  const configPath = configuredPath || (existsSync(jsonPath) ? jsonPath : jsoncPath);
  try {
    return readFileSync(configPath, "utf-8");
  } catch {
    return undefined;
  }
}

function getOpenCodeCompactionVariant(config: AgentCompactionConfig): string | undefined {
  if (config.thinkingLevel === "inherit") return undefined;
  if (config.modelMode === "custom" && !config.customModel.reasoning) return undefined;
  if (config.thinkingLevel === "xhigh") return "max";
  return config.thinkingLevel;
}

function getAvailableCompactionProviderId(providers: UnknownRecord): string {
  let providerId = HPP_OPENCODE_COMPACTION_PROVIDER;
  let index = 2;
  while (
    providers[providerId] !== undefined
    && asRecord(providers[providerId]).name !== HPP_OPENCODE_COMPACTION_PROVIDER_NAME
  ) {
    providerId = `${HPP_OPENCODE_COMPACTION_PROVIDER}-${index}`;
    index += 1;
  }
  return providerId;
}

export function buildOpenCodeConfigContent(
  source: string | undefined,
  value: unknown,
  currentModel?: { provider: string; id: string } | null,
): string {
  const config = normalizeAgentCompactionConfig(value);
  const parsed = parseOpenCodeConfigContent(source);
  const providers = { ...asRecord(parsed.provider) };
  const agents = { ...asRecord(parsed.agent) };
  const compactionAgent = { ...asRecord(agents.compaction) };
  delete compactionAgent.model;
  delete compactionAgent.variant;

  const customConfigured = isCustomAgentCompactionModelConfigured(config);
  if (customConfigured) {
    const providerId = getAvailableCompactionProviderId(providers);
    const custom = config.customModel;
    providers[providerId] = {
      npm: custom.api === "openai-responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
      name: HPP_OPENCODE_COMPACTION_PROVIDER_NAME,
      options: {
        baseURL: custom.baseUrl,
        ...(custom.apiKey ? { apiKey: custom.apiKey } : {}),
      },
      models: {
        [custom.modelId]: {
          name: custom.modelId,
          reasoning: custom.reasoning,
          attachment: false,
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    };
    compactionAgent.model = `${providerId}/${custom.modelId}`;
  } else if (config.thinkingLevel !== "inherit" && currentModel?.provider && currentModel.id) {
    // OpenCode 仅在 compaction agent 显式指定模型时应用 variant。
    // 因此独立思考等级需要把“当前模型”固定为用户刚选择的模型。
    compactionAgent.model = `${currentModel.provider}/${currentModel.id}`;
  }

  const variant = getOpenCodeCompactionVariant(customConfigured ? config : { ...config, modelMode: "current" });
  if (variant && compactionAgent.model) compactionAgent.variant = variant;
  agents.compaction = compactionAgent;

  const nextConfig: UnknownRecord = {
    ...parsed,
    provider: providers,
    agent: agents,
    ...(!("permission" in parsed) ? { permission: "allow" } : {}),
  };
  if (customConfigured && Array.isArray(parsed.enabled_providers)) {
    const customProviderId = String(compactionAgent.model).split("/")[0];
    nextConfig.enabled_providers = [...new Set([...parsed.enabled_providers.map(String), customProviderId])];
  }
  return JSON.stringify(nextConfig);
}

function modelSupportsImages(modelInfo: unknown): boolean {
  const info = asRecord(modelInfo);
  if (info.attachment === true || info.supportsImages === true || info.imageInput === true) return true;
  const capabilities = asRecord(info.capabilities);
  if (capabilities.attachment === true || asRecord(capabilities.input).image === true) return true;
  const modalities = asRecord(info.modalities);
  const input = info.input || modalities.input;
  return Array.isArray(input) && input.includes("image");
}

function modelSupportsReasoning(modelInfo: unknown): boolean {
  const info = asRecord(modelInfo);
  return info.reasoning === true || asRecord(info.capabilities).reasoning === true;
}

function getModelVariants(modelInfo: unknown): string[] {
  const variants = asRecord(asRecord(modelInfo).variants);
  return Object.entries(variants).flatMap(([variantId, value]) => {
    return asRecord(value).disabled === true ? [] : [variantId];
  });
}

// OpenCode historically exposes `max` as the wire-level name for Hpp's
// `xhigh` option. Keep that backend-specific alias here instead of collapsing
// the native Codex `max` level in the shared model layer.
function normalizeOpenCodeThinkingLevel(level: string): string {
  const normalized = normalizeThinkingLevelId(level);
  return normalized === "max" ? "xhigh" : normalized;
}

function normalizeOpenCodeThinkingLevels(levels: string[]): string[] {
  return normalizeSupportedThinkingLevels(levels.map(normalizeOpenCodeThinkingLevel));
}

function selectThinkingVariant(level: string, variants: string[]): string | undefined {
  const normalized = normalizeOpenCodeThinkingLevel(level);
  if (!normalized || variants.length === 0) return undefined;
  return variants.find((variant) => normalizeOpenCodeThinkingLevel(variant) === normalized);
}

function imageExtension(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "png";
}

function parseHttpBody(body: string): unknown {
  if (!body) return "";
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function createHttpError(method: string, path: string, statusCode: number, body: string) {
  const detail = body.trim().slice(0, 500);
  return new Error(`OpenCode ${method} ${path} failed (${statusCode})${detail ? `: ${detail}` : ""}`);
}

function getUIAnswerValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const answer = asRecord(value);
  const selected = Array.isArray(answer.selected) ? answer.selected : Array.isArray(answer.values) ? answer.values : null;
  if (selected) return selected.map(String).filter(Boolean);
  const scalar = answer.value ?? answer.answer ?? answer.label;
  return scalar === undefined || scalar === null || scalar === "" ? [] : [String(scalar)];
}

function getPermissionReply(response: AgentUIResponse): "once" | "always" | "reject" {
  if (response.cancelled === true) return "reject";
  const firstAnswer = Array.isArray(response.answers) ? getUIAnswerValues(response.answers[0])[0] : undefined;
  const value = String(firstAnswer || response.value || response.text || "once").toLowerCase();
  if (value === "always") return "always";
  if (["reject", "deny", "cancel", "cancelled"].includes(value)) return "reject";
  return "once";
}

const OPENCODE_BUILTIN_COMMANDS = new Set(["init", "review"]);

function normalizeOpenCodeCatalog(value: unknown, kind: "skill" | "command"): AgentActionCatalogEntry[] {
  const source = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.entries(value).map(([name, item]) => ({ name, ...asRecord(item) }))
      : [];
  return source.flatMap((rawEntry) => {
    const entry = asRecord(rawEntry);
    const name = String(entry.name || entry.id || entry.command || "").trim().replace(/^\//, "");
    if (!name) return [];
    const entrySource = String(entry.source || entry.type || "").trim().toLowerCase();
    if (kind === "command" && (entrySource === "mcp" || OPENCODE_BUILTIN_COMMANDS.has(name.toLowerCase()))) return [];
    const description = String(entry.description || entry.summary || "").trim();
    const argumentHint = String(entry.argumentHint || entry.argument_hint || entry.usage || entry.arguments || "").trim();
    return [{
      kind,
      name,
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
    }];
  });
}

function withoutToolDiffPayload<T extends object>(event: T): T {
  const record = event as UnknownRecord;
  const files = Array.isArray(record.files)
    ? record.files.map((rawFile) => {
        const file = { ...asRecord(rawFile) };
        delete file.patch;
        delete file.additions;
        delete file.deletions;
        delete file.status;
        delete file.statusExplicit;
        if (["edited", "modified", "written"].includes(String(file.action || ""))) file.action = undefined;
        return file;
      })
    : record.files;
  const sanitized = { ...record, files } as unknown as T & UnknownRecord;
  delete sanitized.patch;
  delete sanitized.additions;
  delete sanitized.deletions;
  delete sanitized.status;
  delete sanitized.statusExplicit;
  return sanitized;
}

// ============================================================
// OpenCode Agent - communicates with opencode serve via HTTP/SSE
// ============================================================
export class OpenCodeAgent {
  private process: ChildProcess | null = null;
  private processError: Error | null = null;
  private port = 0;
  private host = "127.0.0.1";
  private projectPath = "";
  private sessionId: string | null = null;
  private models: AgentModel[] = [];
  private currentModelId: string | null = null;
  private currentProviderId: string | null = null;
  private currentThinkingLevel = "medium";
  private modelVariants = new Map<string, string[]>();
  private eventSource: ReturnType<typeof http.get> | null = null;
  private sseBuffer = "";
  private streamedContent = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleSettlementInFlight = false;
  private idleSettlementRevision = 0;
  private runningToolParts = new Set<string>();
  private completedToolParts = new Set<string>();
  private pendingQuestionToolParts = new Set<string>();
  private partTypes = new Map<string, string>();
  private openCodeSubagentsByToolCallId = new Map<string, OpenCodeSubagentSnapshot>();
  private openCodeSubagentToolCallIdBySessionId = new Map<string, string>();
  // OpenCode 每次模型调用对应一个 step part，tokens 是该次调用用量；
  // 消息级 info.tokens 只反映最后一次调用，不能直接用。按 part id 记差值上报。
  private partTokenUsage = new Map<string, { input: number; output: number; cacheInput: number }>();
  private turnActive = false;
  private turnRevision = 0;
  private idleObservedWhileWaitingForUI = false;
  private activeClientMessageId: string | null = null;
  private activeOpenCodeUserMessageId: string | null = null;
  private activeOpenCodeUserMessageIds = new Set<string>();
  private activeTurnDiffByMessageId = new Map<string, ReturnType<typeof normalizeOpenCodeSessionDiffs>>();
  private activeTurnDiffs: ReturnType<typeof normalizeOpenCodeSessionDiffs> = [];
  private activeToolDiffs: ReturnType<typeof buildDiffsFromToolEvent> = [];
  private activeTurnDiffsAuthoritative = false;
  /**
   * provider 未回报补丁时的自算兜底：tool_start 抓修改前快照，tool_end 出差异。
   * 快照按「本轮最早观测」保留，因此同一文件被连续编辑时得到的是累计差异，
   * 与 OpenCode session diff 的语义一致。
   */
  private readonly toolFileDiffFallback = new ToolFileDiffFallback();
  private activeAssistantMessageId: string | null = null;
  private pendingUIRequests = new Map<string, PendingOpenCodeUIRequest>();
  private guidancePendingResponse = false;
  private guidanceUserMessageId: string | null = null;
  // OpenCode encodes a context compaction as ordinary messages (a user message
  // whose parts include a `compaction` part and an assistant message with
  // `info.summary === true`) instead of a dedicated compaction event. Track the
  // native message ids because `message.part.delta` does not repeat the
  // summary flag; a single "currently compacting" boolean would let summary
  // deltas leak into the normal assistant response.
  private compactionMessageIds = new Set<string>();
  private compactionEventIdByMessageId = new Map<string, string>();
  private activeCompactionId: string | null = null;
  private settledCompactionIds = new Set<string>();
  private permissionMode: AgentPermissionMode = "auto";
  private hostSystemPrompt = "";
  private compactionConfig = normalizeAgentCompactionConfig(undefined);
  private activeCompactionSignature = "";
  private openCodeConfigSource: string | undefined;
  private runtimeConfigPath: string | null = null;
  private actionKeys = new Set<string>();
  private eventBuffer: AgentEventBuffer;

  constructor(hppSessionId = "default", emit?: (event: UnknownRecord) => void) {
    this.eventBuffer = new AgentEventBuffer(hppSessionId, emit);
  }

  /** Start opencode serve and wait for it to be ready */
  async init(projectPath: string, existingSessionId?: string, options?: AgentInitOptions): Promise<void> {
    const nextHostSystemPrompt = String(options?.hostSystemPrompt || "").trim();
    const nextCompactionConfig = normalizeAgentCompactionConfig(options?.compaction);
    const nextCompactionSignature = this.getCompactionSignature(nextCompactionConfig);
    if (
      this.process
      && this.projectPath === projectPath
      && this.hostSystemPrompt === nextHostSystemPrompt
      && this.activeCompactionSignature === nextCompactionSignature
    ) {
      if (existingSessionId) this.sessionId = existingSessionId;
      return;
    }
    if (this.process && !this.isIdle()) {
      throw new Error("OpenCode 会话正在运行，无法立即重载上下文压缩设置");
    }
    const sessionToResume = existingSessionId || this.sessionId || undefined;

    this.projectPath = projectPath;
    this.stopSSEListener();
    await this.killProcess();
    this.hostSystemPrompt = nextHostSystemPrompt;
    this.compactionConfig = nextCompactionConfig;
    this.processError = null;
    this.port = 10000 + Math.floor(Math.random() * 55000);
    this.sessionId = null;
    this.openCodeConfigSource = readOpenCodeConfigContent();
    this.runtimeConfigPath = join(tmpdir(), `hpp-opencode-${process.pid}-${randomUUID()}.json`);
    await this.writeRuntimeConfig();
    this.emitEvent({ type: "agent_init", agentId: "opencode" });

    const opencodeCommand = resolveOpenCodeCommand();
    const processEnv = getCommandEnv({
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      // 使用进程专属临时配置，避免污染用户的 OpenCode 配置。
      OPENCODE_CONFIG: this.runtimeConfigPath,
    });
    // 即使父进程设置过内联配置，也必须移除该变量，确保本会话只读取
    // Hpp 生成的进程专属配置。
    delete processEnv.OPENCODE_CONFIG_CONTENT;
    this.process = spawn(opencodeCommand, ["serve", "--port", String(this.port), "--hostname", this.host], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWindowsShellShim(opencodeCommand),
      env: processEnv,
    });

    const childProcess = this.process!;
    childProcess.stdout?.on("data", () => undefined);
    childProcess.stderr?.on("data", (chunk: Buffer) => {
      console.log("[opencode]", chunk.toString().trim());
    });

    childProcess.on("error", (error) => {
      if (this.process !== childProcess) return;
      this.processError = error;
      this.process = null;
      if (this.turnActive) this.failActiveTurn("OpenCode process failed", error.message);
      else this.emitEvent({ type: "agent_disconnected", detail: error.message });
    });

    childProcess.on("exit", (code, signal) => {
      if (this.process !== childProcess) return;
      this.process = null;
      const detail = `OpenCode exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`;
      if (this.turnActive) this.failActiveTurn("OpenCode disconnected", detail);
      else this.emitEvent({ type: "agent_disconnected", detail });
    });

    await this.waitForReady(childProcess);

    // If an existing session ID was provided, verify it exists on the server.
    // Otherwise create one now so the renderer can persist the real OpenCode
    // session id before the first prompt is sent.
    if (sessionToResume) {
      const valid = await this.verifySession(sessionToResume);
      if (valid) {
        this.sessionId = sessionToResume;
        console.log("[opencode] Resumed session:", sessionToResume);
      } else {
        console.log("[opencode] Session", sessionToResume, "not found on server, will create new");
      }
    }

    if (!this.sessionId) {
      const createdSessionId = await this.createSession();
      if (createdSessionId) {
        console.log("[opencode] Created session:", createdSessionId);
      }
    }
    this.activeCompactionSignature = nextCompactionSignature;
  }

  /** Verify a session exists on the server */
  private async verifySession(sessionId: string): Promise<boolean> {
    try {
      const result = await this.httpGet(`/session/${sessionId}`);
      return asRecord(result).id !== undefined;
    } catch {
      return false;
    }
  }

  private async waitForReady(childProcess: ChildProcess): Promise<void> {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      if (this.process !== childProcess) {
        throw this.processError || new Error("OpenCode exited before becoming ready");
      }
      try {
        const result = await this.httpGet("/global/health");
        if (asRecord(result).healthy) {
          this.emitEvent({ type: "agent_ready", agentId: "opencode", mock: false });
          return;
        }
      } catch {
        // server not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.killProcess();
    throw new Error("OpenCode server did not become ready within 30 seconds");
  }

  /** Create a new opencode session, or reuse existing if session ID is already set */
  async createSession(): Promise<string | null> {
    // Reuse existing session ID if available
    if (this.sessionId) return this.sessionId;

    try {
      const result = await this.httpPost("/session", {});
      const sessionId = asRecord(result).id;
      if (sessionId !== undefined && sessionId !== null) {
        this.sessionId = String(sessionId);
        return this.sessionId;
      }
    } catch (e) {
      console.error("[opencode] createSession failed:", e);
    }
    return null;
  }

  /** Send a message to the opencode session */
  async sendMessage(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    const turnRevision = ++this.turnRevision;
    this.clearActiveTurn();
    this.turnActive = true;
    this.permissionMode = options?.permissionMode || "auto";
    this.idleObservedWhileWaitingForUI = false;
    this.activeClientMessageId = options?.clientMessageId?.trim() || null;
    if (!this.sessionId) {
      await this.createSession();
    }
    if (!this.isCurrentTurn(turnRevision)) return;
    if (!this.sessionId) {
      this.emitEvent({ type: "stream_start", role: "assistant" });
      this.emitEvent({ type: "stream_delta", delta: "无法创建会话，请检查 opencode 是否已安装。" });
      this.finishTurn(turnRevision);
      return;
    }

    let selectedAction: AgentActionInvocation | null;
    try {
      selectedAction = options?.action ? await this.resolveAction(options.action) : null;
    } catch (error) {
      if (this.isCurrentTurn(turnRevision)) {
        this.turnRevision += 1;
        this.clearTurnRuntime();
      }
      throw error;
    }
    if (!this.isCurrentTurn(turnRevision)) return;

    this.emitEvent({ type: "stream_start", role: "assistant" });
    try {
      if (!this.isCurrentTurn(turnRevision)) return;
      await this.startSSEListener();
      if (!this.isCurrentTurn(turnRevision)) return;
      if (!this.eventSource) throw new Error("OpenCode event stream closed before the prompt was sent");
      const parts: OpenCodePromptPart[] = [{ type: "text", text: message }];
      if (images?.length) {
        images.forEach((image, index) => {
          const mimeType = image.mimeType || "image/png";
          parts.push({
            type: "file",
            mime: mimeType,
            filename: `image-${index + 1}.${imageExtension(mimeType)}`,
            url: `data:${mimeType};base64,${image.data}`,
          });
        });
      }
      const body: OpenCodePromptBody = {
        parts,
      };
      const hostSystemPrompt = String(options?.hostSystemPrompt ?? this.hostSystemPrompt).trim();
      this.hostSystemPrompt = hostSystemPrompt;
      if (hostSystemPrompt) body.system = hostSystemPrompt;
      this.activeAssistantMessageId = null;
      if (options?.planModeEnabled) {
        body.agent = "plan";
      } else {
        body.agent = "build";
      }
      if (this.currentModelId && this.currentProviderId) {
        body.model = { providerID: this.currentProviderId, modelID: this.currentModelId };
        const variants = this.modelVariants.get(`${this.currentProviderId}:${this.currentModelId}`) || [];
        const variant = selectThinkingVariant(this.currentThinkingLevel, variants);
        if (variant) body.variant = variant;
      }
      if (selectedAction) {
        // OpenCode's native /command payload has no system field. Keep native
        // command/skill expansion intact instead of lowering host policy into
        // user arguments; ordinary and Plan prompts use PromptInput.system.
        const commandParts = parts.filter((part) => part.type === "file");
        const commandBody: OpenCodeCommandBody = {
          command: selectedAction.name,
          arguments: message,
          ...(commandParts.length > 0 ? { parts: commandParts } : {}),
          ...(body.agent ? { agent: body.agent } : {}),
          ...(body.model ? { model: body.model } : {}),
          ...(body.variant ? { variant: body.variant } : {}),
        };
        await this.httpPost(`/session/${this.sessionId}/command`, commandBody);
      } else {
        await this.httpPost(`/session/${this.sessionId}/prompt_async`, body);
      }
    } catch (e) {
      if (!this.isCurrentTurn(turnRevision)) return;
      console.error("[opencode] sendMessage failed:", e);
      this.emitEvent({ type: "stream_delta", delta: `\n\n发送失败: ${e}` });
      this.finishTurn(turnRevision);
    }
  }

  /**
   * Inject a steer message into the currently running opencode turn. Requires
   * opencode >= 1.18.18 where prompts admitted while the session is running are
   * steered into the current turn at the next safe provider-turn boundary
   * instead of being rejected or deferred.
   */
  async sendGuidance(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    if (!this.turnActive) throw new Error("SESSION_NOT_RUNNING");
    if (!this.sessionId) throw new Error("SESSION_NOT_READY");
    if (!this.eventSource) await this.startSSEListener();
    this.permissionMode = options?.permissionMode || "auto";
    const parts: OpenCodePromptPart[] = [{ type: "text", text: message }];
    if (images?.length) {
      images.forEach((image, index) => {
        const mimeType = image.mimeType || "image/png";
        parts.push({
          type: "file",
          mime: mimeType,
          filename: `image-${index + 1}.${imageExtension(mimeType)}`,
          url: `data:${mimeType};base64,${image.data}`,
        });
      });
    }
    const body: OpenCodePromptBody = { parts };
    const hostSystemPrompt = String(options?.hostSystemPrompt ?? this.hostSystemPrompt).trim();
    this.hostSystemPrompt = hostSystemPrompt;
    if (hostSystemPrompt) body.system = hostSystemPrompt;
    body.agent = options?.planModeEnabled ? "plan" : "build";
    if (this.currentModelId && this.currentProviderId) {
      body.model = { providerID: this.currentProviderId, modelID: this.currentModelId };
      const variants = this.modelVariants.get(`${this.currentProviderId}:${this.currentModelId}`) || [];
      const variant = selectThinkingVariant(this.currentThinkingLevel, variants);
      if (variant) body.variant = variant;
    }
    this.guidancePendingResponse = true;
    this.guidanceUserMessageId = null;
    try {
      await this.httpPost(`/session/${this.sessionId}/prompt_async`, body);
    } catch (error) {
      this.guidancePendingResponse = false;
      this.guidanceUserMessageId = null;
      throw error;
    }
  }

  async listActions(_options?: AgentActionListOptions): Promise<AgentActionCatalogEntry[]> {
    const [skillsResult, commandsResult] = await Promise.allSettled([
      this.httpGet("/skill"),
      this.httpGet("/command"),
    ]);
    const actions = [
      ...(skillsResult.status === "fulfilled" ? normalizeOpenCodeCatalog(skillsResult.value, "skill") : []),
      ...(commandsResult.status === "fulfilled" ? normalizeOpenCodeCatalog(commandsResult.value, "command") : []),
    ];
    if (skillsResult.status === "rejected" && commandsResult.status === "rejected") {
      throw skillsResult.reason instanceof Error ? skillsResult.reason : new Error(String(skillsResult.reason));
    }
    const unique = actions.filter((entry, index) =>
      actions.findIndex((candidate) => candidate.kind === entry.kind && candidate.name === entry.name) === index
    );
    this.actionKeys = new Set(unique.map((entry) => `${entry.kind}:${entry.name}`));
    return unique;
  }

  private async resolveAction(action: AgentActionInvocation): Promise<AgentActionInvocation> {
    const kind = action.kind === "skill" || action.kind === "command" ? action.kind : null;
    const name = String(action.name || "").trim().replace(/^\//, "");
    if (!kind || !name) throw new Error("ACTION_NOT_SUPPORTED: Invalid OpenCode action");
    const key = `${kind}:${name}`;
    await this.listActions();
    if (!this.actionKeys.has(key)) throw new Error(`ACTION_NOT_FOUND: ${name}`);
    return { kind, name };
  }

  isIdle(): boolean {
    return (
      !this.turnActive &&
      !this.eventSource &&
      !this.idleTimer &&
      this.runningToolParts.size === 0 &&
      this.pendingQuestionToolParts.size === 0
    );
  }

  /** Listen to SSE events for streaming responses */
  private startSSEListener(): Promise<void> {
    this.stopSSEListener();
    this.sseBuffer = "";
    this.streamedContent = false;
    this.idleObservedWhileWaitingForUI = false;
    this.runningToolParts.clear();
    this.completedToolParts.clear();
    this.pendingQuestionToolParts.clear();
    this.partTypes.clear();
    this.openCodeSubagentsByToolCallId.clear();
    this.openCodeSubagentToolCallIdBySessionId.clear();
    this.partTokenUsage.clear();

    return new Promise((resolve, reject) => {
      let connected = false;
      const req = http.get(
        `http://${this.host}:${this.port}/event`,
        { timeout: 10000 },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            this.eventSource = null;
            req.destroy();
            reject(new Error(`OpenCode event stream failed (${res.statusCode || 0})`));
            return;
          }
          connected = true;
          req.setTimeout(0);
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => {
            if (this.eventSource !== req) return;
            this.sseBuffer += chunk;
            this.processSSEBuffer();
          });
          res.on("end", () => this.handleSSEDisconnect(req, "OpenCode event stream ended"));
          res.on("aborted", () => this.handleSSEDisconnect(req, "OpenCode event stream was aborted"));
          res.on("close", () => this.handleSSEDisconnect(req, "OpenCode event stream closed"));
          res.on("error", (error) => this.handleSSEDisconnect(req, error.message));
          resolve();
        }
      );

      req.on("error", (error) => {
        if (this.eventSource === req) this.eventSource = null;
        if (!connected) reject(error);
        else this.handleSSEDisconnect(req, error.message);
      });
      req.on("timeout", () => {
        if (this.eventSource === req) this.eventSource = null;
        req.destroy();
        if (!connected) reject(new Error("OpenCode event stream timed out"));
      });
      this.eventSource = req;
    });
  }

  private handleSSEDisconnect(request: ReturnType<typeof http.get>, detail: string) {
    if (this.eventSource !== request) return;
    this.eventSource = null;
    if (this.turnActive) this.failActiveTurn("OpenCode event stream disconnected", detail);
  }

  private processSSEBuffer() {
    const lines = this.sseBuffer.split("\n");
    this.sseBuffer = lines.pop() || "";

    for (const line of lines) {
      // OpenCode SSE format: each line is "data: {json}"
      // Event type is inside the JSON "type" field
      if (line.startsWith("data:")) {
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(jsonStr); } catch { continue; }
        if (isRecord(parsed) && typeof parsed.type === "string") {
          this.handleSSEEvent(parsed.type, parsed);
        }
      }
    }
  }

  private normalizeCompactionMessageId(value: unknown): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const normalized = String(value).trim();
    return normalized || undefined;
  }

  private isCompactionMessageId(value: unknown): boolean {
    const messageId = this.normalizeCompactionMessageId(value);
    return !!messageId && this.compactionMessageIds.has(messageId);
  }

  private getCompactionEventId(messageId: unknown, parentId?: unknown): string | undefined {
    const normalizedMessageId = this.normalizeCompactionMessageId(messageId);
    const normalizedParentId = this.normalizeCompactionMessageId(parentId);
    return (normalizedMessageId && this.compactionEventIdByMessageId.get(normalizedMessageId))
      || (normalizedParentId && this.compactionEventIdByMessageId.get(normalizedParentId))
      || this.activeCompactionId
      || normalizedParentId
      || normalizedMessageId;
  }

  private rememberCompactionMessage(messageId: unknown, eventId?: unknown) {
    const normalizedMessageId = this.normalizeCompactionMessageId(messageId);
    const normalizedEventId = this.normalizeCompactionMessageId(eventId) || normalizedMessageId;
    if (!normalizedMessageId) return;
    this.compactionMessageIds.add(normalizedMessageId);
    if (normalizedEventId) this.compactionEventIdByMessageId.set(normalizedMessageId, normalizedEventId);
  }

  private emitCompactionStarted(value: unknown) {
    const id = this.normalizeCompactionMessageId(value);
    if (!id || this.settledCompactionIds.has(id) || this.activeCompactionId === id) return;
    this.activeCompactionId = id;
    this.emitEvent({ type: "context_compaction", id, phase: "started" });
  }

  private emitCompactionFinished(value: unknown, phase: "completed" | "interrupted" = "completed", detail?: unknown) {
    const id = this.normalizeCompactionMessageId(value) || this.activeCompactionId;
    if (!id || this.settledCompactionIds.has(id)) return;
    this.settledCompactionIds.add(id);
    this.emitEvent({ type: "context_compaction", id, phase, detail });
    if (this.activeCompactionId === id) this.activeCompactionId = null;
  }

  private isOpenCodeMessageFinished(info: UnknownRecord): boolean {
    const time = asRecord(info.time);
    return info.finish !== undefined
      || info.error !== undefined && info.error !== null
      || info.completed === true
      || time.completed !== undefined;
  }

  private handleSSEEvent(eventType: string, data: unknown) {
    const dataRecord = asRecord(data);
    const props = asRecord(dataRecord.properties || dataRecord);
    const part = asRecord(props.part || props);
    const info = asRecord(props.info);
    const eventSessionId = String(props.sessionID || part.sessionID || info.sessionID || "");
    const isForeignSessionEvent = !!(
      this.sessionId
      && eventSessionId
      && eventSessionId !== this.sessionId
    );
    if (isForeignSessionEvent) {
      const isTrackedSubagent = this.handleOpenCodeSubagentSessionEvent(eventType, props, eventSessionId);
      if (!isTrackedSubagent || !isOpenCodeSubagentInteractionEvent(eventType)) return;
    }
    if (eventType === "session.compacted") {
      this.emitCompactionFinished(this.activeCompactionId);
      return;
    }
    if (
      !eventType.startsWith("message.")
      && isContextCompactionLike(
        eventType,
        props.type,
        props.name,
        props.title,
        props.message,
        props.status,
        part.type,
        part.name,
        part.title,
        part.message
      )
    ) {
      const messageId = part.messageID || props.messageID || props.messageId || info.id;
      const rawPhase = normalizeEventName(props.phase || part.phase || props.status || part.status);
      const compactionId = this.getCompactionEventId(
        messageId,
        part.id || props.partID || props.partId || props.id || dataRecord.id,
      );
      this.rememberCompactionMessage(messageId, compactionId);
      if (["started", "starting", "running", "begin", "began"].some((value) => rawPhase.includes(value))) {
        this.emitCompactionStarted(compactionId);
      } else if (["interrupted", "error", "failed", "aborted"].some((value) => rawPhase.includes(value))) {
        this.emitCompactionFinished(compactionId, "interrupted", props.error || part.error || props.message);
      } else {
        this.emitCompactionFinished(compactionId);
      }
      return;
    }

    switch (eventType) {
      case "question.asked":
      case "question.v2.asked":
        if (typeof props.id === "string") {
          if (this.cancelIdleTimer()) this.idleObservedWhileWaitingForUI = true;
          this.pendingUIRequests.set(props.id, { kind: "question", sessionId: eventSessionId || undefined });
          this.emitEvent(normalizeQuestionProcessEvent({
            type: eventType,
            requestId: props.id,
            method: "opencode.question",
            questions: props.questions,
            detail: props,
          }));
        }
        break;
      case "permission.asked":
      case "permission.v2.asked":
        if (typeof props.id === "string") {
          if (this.cancelIdleTimer()) this.idleObservedWhileWaitingForUI = true;
          const action = String(props.action || props.permission || "requested action");
          const resources = Array.isArray(props.resources)
            ? props.resources.map(String)
            : Array.isArray(props.patterns)
              ? props.patterns.map(String)
              : [];
          const shouldApproveAutomatically = this.permissionMode === "full-access"
            || (this.permissionMode === "auto" && !isHighRiskAgentPermissionRequest(action, resources));
          if (shouldApproveAutomatically) {
            const requestId = props.id;
            const turnRevision = this.turnRevision;
            this.pendingUIRequests.set(requestId, { kind: "permission", sessionId: eventSessionId || undefined });
            void this.httpPost(`/permission/${encodeURIComponent(props.id)}/reply`, { reply: "once" })
              .then(() => this.completePendingUIRequest(requestId, turnRevision))
              .catch((error) => {
                if (this.turnRevision !== turnRevision || !this.pendingUIRequests.has(requestId)) return;
                this.failActiveTurn(
                  "OpenCode permission response failed",
                  error instanceof Error ? error.message : String(error)
                );
              });
            break;
          }
          this.pendingUIRequests.set(props.id, { kind: "permission", sessionId: eventSessionId || undefined });
          this.emitEvent(normalizeQuestionProcessEvent({
            type: eventType,
            requestId: props.id,
            method: "opencode.permission",
            title: "OpenCode 请求权限",
            message: resources.length > 0 ? `${action}\n\n${resources.join("\n")}` : action,
            questions: [{
              header: "权限",
              question: resources.length > 0 ? `${action}: ${resources.join(", ")}` : action,
              options: [
                { label: "允许一次", value: "once" },
                { label: "始终允许", value: "always" },
                { label: "拒绝", value: "reject" },
              ],
            }],
            detail: props,
          }));
        }
        break;
      case "question.replied":
      case "question.rejected":
      case "question.v2.replied":
      case "question.v2.rejected":
      case "permission.replied":
      case "permission.v2.replied":
        {
          const requestId = typeof props.id === "string" ? props.id : typeof props.requestID === "string" ? props.requestID : "";
          if (requestId) this.completePendingUIRequest(requestId);
        }
        break;
      case "message.updated":
        if (info.role === "assistant") {
          if (info.summary) {
            // OpenCode 先创建 summary 消息，再流式写入摘要，最后才补上
            // finish/time.completed。创建阶段只能标记“开始”，不能提前发
            // completed，否则前端会结束压缩状态并把后续摘要当普通正文处理。
            const summaryId = this.normalizeCompactionMessageId(info.id);
            const parentId = this.normalizeCompactionMessageId(info.parentID);
            const compactionId = this.getCompactionEventId(summaryId, parentId);
            this.rememberCompactionMessage(summaryId, compactionId);
            this.rememberCompactionMessage(parentId, compactionId);
            this.emitCompactionStarted(compactionId);
            if (this.isOpenCodeMessageFinished(info)) {
              this.emitCompactionFinished(compactionId, info.error ? "interrupted" : "completed", info.error);
            }
            break;
          }
          this.recordAssistantMessageId(info.id);
          if (
            this.guidancePendingResponse
            && this.guidanceUserMessageId
            && info.parentID === this.guidanceUserMessageId
          ) {
            // prompt_async 会立刻创建并发布 steer 的 user 消息；这只表示消息已
            // 入队，不能据此移动引导气泡。OpenCode 真正开始处理该引导时会创建
            // 一条 parentID 指向该 user 消息的新 assistant 消息，这才与 Pi 的
            // guidance_delivered / message_start(user) 时机等价。
            this.activeOpenCodeUserMessageIds.add(this.guidanceUserMessageId);
            this.activeOpenCodeUserMessageId = this.guidanceUserMessageId;
            this.guidancePendingResponse = false;
            this.guidanceUserMessageId = null;
            this.emitEvent({ type: "guidance_response_started" });
          }
        } else if (info.role === "user") {
          const summaryDiff = normalizeOpenCodeSessionDiffResult(asRecord(info.summary).diffs);
          if (typeof info.id === "string" && summaryDiff.recognized) {
            this.activeOpenCodeUserMessageIds.add(info.id);
            this.activeTurnDiffByMessageId.set(info.id, summaryDiff.diffs);
            this.activeTurnDiffs = this.mergeTurnDiffs();
            this.activeTurnDiffsAuthoritative = true;
          }
          const parts = Array.isArray(props.parts) ? props.parts : [];
          if (parts.some((part) => asRecord(part).type === "compaction")) {
            // 压缩触发消息本身不是用户正文。它标志着压缩开始，摘要
            // assistant message 完成后才会发出 completed。
            const messageId = this.normalizeCompactionMessageId(info.id);
            if (messageId === this.activeOpenCodeUserMessageId) this.activeOpenCodeUserMessageId = null;
            if (messageId) {
              this.activeOpenCodeUserMessageIds.delete(messageId);
              this.activeTurnDiffByMessageId.delete(messageId);
              this.activeTurnDiffs = this.mergeTurnDiffs();
            }
            this.rememberCompactionMessage(messageId, messageId);
            this.emitCompactionStarted(messageId);
            break;
          }
          if (!this.guidancePendingResponse && typeof info.id === "string") {
            this.activeOpenCodeUserMessageIds.add(info.id);
            this.activeOpenCodeUserMessageId = info.id;
          }
          if (this.guidancePendingResponse && !this.guidanceUserMessageId && typeof info.id === "string") {
            // 这里只记录 prompt_async 立即创建的引导 user 消息。必须继续等待它
            // 对应的新 assistant 消息，旧 assistant 的尾部输出不能触发确认。
            this.guidanceUserMessageId = info.id;
          }
        }
        break;
      case "message.part.added":
      case "message.part.updated": {
        this.rememberPartType(part);
        this.emitPartTokenUsageDelta(part);
        if (process.env.HPP_OPENCODE_DEBUG_PARTS) {
          const dbgPart = asRecord(props.part || props);
          console.log("[opencode:debug-part]", JSON.stringify({
            eventType,
            type: dbgPart.type,
            tool: dbgPart.tool,
            toolName: dbgPart.toolName,
            name: dbgPart.name,
            partKeys: Object.keys(dbgPart),
          }));
        }
        const partMessageId = part.messageID || props.messageID || props.messageId || info.id;
        if (normalizeEventName(part.type || props.type) === "compaction") {
          const normalizedPartMessageId = this.normalizeCompactionMessageId(partMessageId);
          if (normalizedPartMessageId === this.activeOpenCodeUserMessageId) this.activeOpenCodeUserMessageId = null;
          if (normalizedPartMessageId) {
            this.activeOpenCodeUserMessageIds.delete(normalizedPartMessageId);
            this.activeTurnDiffByMessageId.delete(normalizedPartMessageId);
            this.activeTurnDiffs = this.mergeTurnDiffs();
          }
          const compactionId = this.getCompactionEventId(partMessageId);
          this.rememberCompactionMessage(partMessageId, compactionId);
          this.emitCompactionStarted(compactionId);
          break;
        }
        if (info.summary === true) {
          const compactionId = this.getCompactionEventId(partMessageId, info.parentID);
          this.rememberCompactionMessage(partMessageId, compactionId);
          this.emitCompactionStarted(compactionId);
          break;
        }
        if (this.isCompactionMessageId(partMessageId)) break;
        if (isToolLikePart(props)) {
          const tool = summarizeToolPart(props);
          if (isOpenCodeSubagentToolPart(props)) {
            this.emitOpenCodeSubagentToolPart(props, tool.toolCallId);
            if (isToolPartComplete(props)) {
              this.runningToolParts.delete(tool.toolCallId);
              this.completedToolParts.add(tool.toolCallId);
            } else {
              this.runningToolParts.add(tool.toolCallId);
            }
            break;
          }
          if (this.completedToolParts.has(tool.toolCallId)) break;

          if (isAskUserName(tool.toolName)) {
            if (!this.pendingQuestionToolParts.has(tool.toolCallId)) {
              this.pendingQuestionToolParts.add(tool.toolCallId);
              this.runningToolParts.add(tool.toolCallId);
              this.emitEvent(normalizeQuestionProcessEvent({
                ...tool,
                id: tool.toolCallId,
                requestId: tool.toolCallId,
                method: tool.toolName,
                args: tool.args,
                detail: tool.args || tool.detail,
              }));
            }
            break;
          }

          if (!this.runningToolParts.has(tool.toolCallId)) {
            this.runningToolParts.add(tool.toolCallId);
            const startEvent = normalizeToolEvent("tool_start", tool);
            // 工具尚未完成，此刻文件通常还是修改前的状态——抓快照的最佳时机。
            this.toolFileDiffFallback.onToolStart(this.projectPath, startEvent);
            this.emitEvent(startEvent);
          } else if (tool.detail) {
            const startEvent = normalizeToolEvent("tool_start", tool);
            this.toolFileDiffFallback.onToolStart(this.projectPath, startEvent);
            this.emitEvent(startEvent);
          }

          if (isToolPartComplete(props)) {
            const toolEvent = normalizeToolEvent("tool_end", tool);
            const fallback = this.toolFileDiffFallback.resolve(this.projectPath, toolEvent);
            const toolDiffs = buildDiffsFromToolEvent(toolEvent, fallback);
            this.activeToolDiffs = this.toolFileDiffFallback.mergeDiffs(
              this.activeToolDiffs, toolDiffs, fallback,
            );
            this.emitEvent(withoutToolDiffPayload(toolEvent));
            // 立即把兜底差异发出去：用户从 AI 回复完毕到 OpenCode delayed idle
            // 触发之间常会立刻打开审核弹窗，这段时间里若不主动发，弹窗拿到的
            // 就只有 provider 的过期快照——那正是「无法安全撤销」的成因。
            // turn 结束时会再发一次，但 frontend 按 patch 字符串去重，不会重复计数。
            if (fallback && toolDiffs.length > 0) {
              this.emitEvent({ type: "diff_update", diffs: toolDiffs });
            }
            // OpenCode 的工具结果 patch 与 message-scoped session diff 是同一
            // 改动的不同表示。只保留 idle 时的最终快照，避免增量+累计混入
            // 通用审核事务后重复计数或无法重建。
            this.runningToolParts.delete(tool.toolCallId);
            this.completedToolParts.add(tool.toolCallId);
          }
        } else if (props.delta) {
          this.emitPartDelta(part.type, props.delta);
        }
        break;
      }
      case "message.part.done":
      case "message.part.removed": {
        const partId = String(part.id || props.partID || props.partId || "");
        const partType = part.type || props.type || this.partTypes.get(partId);
        const partMessageId = part.messageID || props.messageID || props.messageId || info.id;
        if (this.isCompactionMessageId(partMessageId) || info.summary === true) {
          this.emitPartTokenUsageDelta(part);
          if (partId) {
            this.partTypes.delete(partId);
            this.partTokenUsage.delete(partId);
          }
          break;
        }
        if (this.isReasoningPartType(partType)) {
          this.emitEvent({ type: "thinking_end" });
        } else if (isToolLikePart(props)) {
          const tool = summarizeToolPart(props);
          if (isOpenCodeSubagentToolPart(props)) {
            this.emitOpenCodeSubagentToolPart(props, tool.toolCallId);
            this.runningToolParts.delete(tool.toolCallId);
            this.completedToolParts.add(tool.toolCallId);
          } else if (this.completedToolParts.has(tool.toolCallId)) {
            break;
          } else if (isAskUserName(tool.toolName)) {
            this.runningToolParts.delete(tool.toolCallId);
            this.pendingQuestionToolParts.delete(tool.toolCallId);
            this.completedToolParts.add(tool.toolCallId);
            break;
          } else {
            const toolEvent = normalizeToolEvent("tool_end", tool);
            // 这里不走 onToolStart：part.done 时文件早已写盘，此刻抓到的快照
            // 是改后内容，当基线用只会算出空差异。没有 tool_start 快照时
            // resolve 直接返回 null，宁可不出 diff 也不编造。
            const fallback = this.toolFileDiffFallback.resolve(this.projectPath, toolEvent);
            const toolDiffs = buildDiffsFromToolEvent(toolEvent, fallback);
            this.activeToolDiffs = this.toolFileDiffFallback.mergeDiffs(
              this.activeToolDiffs, toolDiffs, fallback,
            );
            this.emitEvent(withoutToolDiffPayload(toolEvent));
            // part.done 时文件早已写盘，工具事件里若没有 patch 就直接走 tool_end
            // 路径：兜底同样能算（如果 baseline 是在 message.part.updated 流里
            // 抓到的），还是立即发出去避免 idle 延迟窗口里弹窗拿不到。
            if (fallback && toolDiffs.length > 0) {
              this.emitEvent({ type: "diff_update", diffs: toolDiffs });
            }
            this.runningToolParts.delete(tool.toolCallId);
            this.completedToolParts.add(tool.toolCallId);
          }
        }
        if (partId) this.partTypes.delete(partId);
        // part 结束时再对齐一次最终用量，随后清理追踪记录。
        this.emitPartTokenUsageDelta(part);
        if (partId) this.partTokenUsage.delete(partId);
        break;
      }
      case "message.part.delta": {
        // session.idle can be followed by one or more trailing deltas. Treat
        // the timer as a debounce: restart it after the delta instead of
        // cancelling the only terminal signal and leaving the turn busy.
        const idleEndWasPending = this.idleTimer !== null || this.idleSettlementInFlight;
        this.cancelIdleTimer();
        const partId = String(props.partID || props.partId || part.id || "");
        const partType = props.field === "thinking"
          ? "thinking"
          : part.type || this.partTypes.get(partId);
        const partMessageId = part.messageID || props.messageID || props.messageId || info.id;
        this.emitPartDelta(partType, props.delta, partMessageId);
        if (idleEndWasPending) this.scheduleIdleEnd();
        break;
      }
      case "session.status": {
        const status = asRecord(props.status);
        const statusType = status.type || props.status;
        if (statusType === "busy") {
          // Session is busy - cancel pending idle timer (sub-agent done but main agent continues)
          this.cancelIdleTimer();
          this.idleObservedWhileWaitingForUI = false;
        } else if (statusType === "idle") {
          // Session is truly idle - schedule stream end with a small delay
          // to catch trailing message.part.delta events
          this.scheduleIdleEnd();
        }
        break;
      }
      case "session.error": {
        this.cancelIdleTimer();
        const err = asRecord(props.error);
        const errData = asRecord(err.data);
        const message =
          typeof errData.message === "string" ? errData.message :
          typeof err.message === "string" ? err.message :
          "OpenCode request failed";
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          title: "OpenCode 错误",
          detail: message,
          state: "error",
        });
        this.emitEvent({ type: "stream_delta", delta: `\n\n错误: ${message || "未知错误"}` });
        this.finishTurn();
        break;
      }
      case "session.diff": {
        // 新版 OpenCode 在 summarize 开始时先发布空 session.diff，最终的
        // per-turn diff 保存在 user message summary 中；SSE 事件本身可能不再
        // 携带结果。非空事件仍兼容旧版服务，并缓存到 idle 前统一发出，避免
        // 同一累计快照被工具事件和 REST fallback 重复附加。
        const diffs = normalizeOpenCodeSessionDiffs(props.diff);
        if (diffs.length > 0 && !this.activeTurnDiffsAuthoritative) this.activeTurnDiffs = diffs;
        break;
      }
      case "session.idle": {
        // Don't end immediately - sub-agent may have finished but main agent continues
        // Schedule a delayed end; if session.status becomes "busy" again, the timer is cancelled
        this.scheduleIdleEnd();
        break;
      }
    }
  }

  private emitOpenCodeSubagentToolPart(props: UnknownRecord, toolCallId: string) {
    const part = asRecord(props.part || props);
    const state = asRecord(part.state);
    const metadata = asRecord(state.metadata || part.metadata || props.metadata);
    const input = asRecord(state.input || part.input || props.input);
    const previous = this.openCodeSubagentsByToolCallId.get(toolCallId);
    const sessionId = getOpenCodeSubagentSessionId(part, state, metadata, input) || previous?.sessionId;
    const taskId = getFirstNonEmptyString(input, ["task_id", "taskId", "session_id", "sessionId"]);
    const action: OpenCodeSubagentAction = taskId || previous?.action === "resumeAgent"
      ? "resumeAgent"
      : "spawnAgent";
    const detail = getFirstNonEmptyString(input, ["prompt", "assignment", "task"])
      || previous?.detail;
    const prompt = getFirstNonEmptyString(input, ["prompt", "assignment", "task"])
      || previous?.prompt;
    const label = getOpenCodeSubagentLabel(input, metadata)
      || previous?.label
      || "Subagent";
    const background = input.background === true
      || input.run_in_background === true
      || input.runInBackground === true
      || metadata.background === true
      || metadata.run_in_background === true
      || metadata.runInBackground === true;
    const model = formatOpenCodeSubagentModel(metadata.model ?? state.model ?? part.model)
      || previous?.model;
    const stopReason = normalizeNativeSubagentStopReason(
      metadata.stopReason ?? state.stopReason ?? part.stopReason,
    );
    const usage = getOpenCodeSubagentUsage(part, state, metadata);
    const parsedStatus = stopReason === "timeout" ? "error" : getOpenCodeSubagentStatus(part);
    const status = previous && isTerminalOpenCodeSubagentStatus(previous.status)
      && !isTerminalOpenCodeSubagentStatus(parsedStatus)
      ? previous.status
      : parsedStatus;
    const errorMessage = status === "error" || status === "interrupted"
      ? formatProcessDetail(state.error ?? part.error)
      : undefined;
    const resultMessage = status === "completed" && !background
      ? formatProcessDetail(state.output ?? part.output ?? state.result ?? part.result)
      : undefined;
    const snapshot: OpenCodeSubagentSnapshot = {
      toolCallId,
      subagentId: sessionId || previous?.subagentId || `opencode-subagent-${toolCallId}`,
      sessionId,
      label,
      status,
      action,
      model,
      detail,
      prompt,
      message: errorMessage || resultMessage || previous?.message,
      startedAt: getOpenCodePartTime(part, "start") ?? previous?.startedAt,
      stopReason: stopReason || previous?.stopReason,
      ...(usage ? { usage } : {}),
    };

    if (previous?.sessionId && previous.sessionId !== sessionId) {
      this.openCodeSubagentToolCallIdBySessionId.delete(previous.sessionId);
    }
    this.openCodeSubagentsByToolCallId.set(toolCallId, snapshot);
    if (sessionId) this.openCodeSubagentToolCallIdBySessionId.set(sessionId, toolCallId);
    this.emitOpenCodeSubagentSnapshot(snapshot, getOpenCodePartTime(part, "end"));
  }

  private handleOpenCodeSubagentSessionEvent(
    eventType: string,
    props: UnknownRecord,
    eventSessionId: string,
  ): boolean {
    const toolCallId = this.openCodeSubagentToolCallIdBySessionId.get(eventSessionId);
    if (!toolCallId) return false;
    const previous = this.openCodeSubagentsByToolCallId.get(toolCallId);
    if (!previous) return false;

    let status: OpenCodeSubagentStatus | undefined;
    let message: string | undefined;
    if (eventType === "message.part.updated") {
      const part = asRecord(props.part || props);
      if (part.type === "text") {
        const fullText = getNonEmptyString(part.text);
        const delta = getNonEmptyString(props.delta);
        message = fullText || (delta ? `${previous.message || ""}${delta}` : undefined);
        if (message) {
          this.openCodeSubagentsByToolCallId.set(toolCallId, { ...previous, message });
        }
      }
      return true;
    }
    if (eventType === "session.status") {
      const statusType = normalizeEventName(asRecord(props.status).type || props.status);
      if (["busy", "running", "retry"].includes(statusType)) status = "running";
      if (statusType === "idle") {
        const isWaitingForUI = Array.from(this.pendingUIRequests.values())
          .some((request) => request.sessionId === eventSessionId);
        if (!isWaitingForUI) status = "completed";
      }
    } else if (eventType === "session.idle") {
      const isWaitingForUI = Array.from(this.pendingUIRequests.values())
        .some((request) => request.sessionId === eventSessionId);
      if (!isWaitingForUI) status = "completed";
    } else if (eventType === "session.error") {
      const error = asRecord(props.error);
      const errorData = asRecord(error.data);
      message = getNonEmptyString(errorData.message)
        || getNonEmptyString(error.message)
        || "OpenCode subagent failed";
      status = /abort|cancel|interrupt/i.test(message) ? "interrupted" : "error";
    } else if (["session.deleted", "session.interrupted"].includes(eventType)) {
      status = "interrupted";
    }

    if (!status || (isTerminalOpenCodeSubagentStatus(previous.status) && status === "running")) return true;
    if (status === "running") {
      this.cancelIdleTimer();
      this.idleObservedWhileWaitingForUI = false;
    }
    const next = { ...previous, status, message: message || previous.message };
    this.openCodeSubagentsByToolCallId.set(toolCallId, next);
    this.emitOpenCodeSubagentSnapshot(next, isTerminalOpenCodeSubagentStatus(status) ? Date.now() : undefined);
    return true;
  }

  private emitOpenCodeSubagentSnapshot(snapshot: OpenCodeSubagentSnapshot, completedAt?: number) {
    const terminal = isTerminalOpenCodeSubagentStatus(snapshot.status);
    const state = snapshot.status === "pending" || snapshot.status === "running"
      ? "running"
      : snapshot.status;
    const title = snapshot.stopReason === "timeout"
      ? "已超时"
      : snapshot.status === "error"
        ? "工作失败"
        : snapshot.status === "interrupted"
        ? "已中断"
        : snapshot.action === "resumeAgent"
          ? "已继续工作"
          : "已开始工作";
    this.emitEvent({
      type: "subagent_event",
      id: snapshot.toolCallId,
      toolCallId: snapshot.toolCallId,
      phase: terminal ? "completed" : "started",
      action: snapshot.action,
      tool: snapshot.action,
      title,
      detail: snapshot.detail,
      prompt: snapshot.prompt,
      state,
      subagents: [{
        id: snapshot.subagentId,
        label: snapshot.label,
        status: snapshot.status,
        model: snapshot.model,
        message: snapshot.message,
        stopReason: snapshot.stopReason,
        ...(snapshot.usage ? { usage: snapshot.usage } : {}),
      }],
      timestamp: snapshot.startedAt,
      startedAt: snapshot.startedAt,
      completedAt: terminal ? completedAt : undefined,
      agentThreadId: snapshot.sessionId,
      receiverThreadIds: snapshot.sessionId ? [snapshot.sessionId] : undefined,
      stopReason: snapshot.stopReason,
      source: "opencode",
    });
  }

  private isCurrentTurn(revision: number) {
    return this.turnActive && this.turnRevision === revision;
  }

  private clearTurnRuntime() {
    this.turnActive = false;
    this.stopSSEListener();
    this.toolFileDiffFallback.reset();
    this.sseBuffer = "";
    this.streamedContent = false;
    this.runningToolParts.clear();
    this.completedToolParts.clear();
    this.pendingQuestionToolParts.clear();
    this.pendingUIRequests.clear();
    this.openCodeSubagentsByToolCallId.clear();
    this.openCodeSubagentToolCallIdBySessionId.clear();
    this.guidancePendingResponse = false;
    this.guidanceUserMessageId = null;
    this.compactionMessageIds.clear();
    this.compactionEventIdByMessageId.clear();
    this.activeCompactionId = null;
    this.settledCompactionIds.clear();
    this.partTokenUsage.clear();
    this.idleObservedWhileWaitingForUI = false;
    this.clearActiveTurn();
  }

  private finishTurn(revision = this.turnRevision) {
    if (!this.isCurrentTurn(revision)) return false;
    this.emitCachedTurnDiffs();
    this.turnRevision += 1;
    this.clearTurnRuntime();
    this.emitEvent({ type: "stream_end" });
    this.emitEvent({ type: "agent_end" });
    return true;
  }

  private emitCachedTurnDiffs() {
    const base = this.activeTurnDiffs.length > 0 ? this.activeTurnDiffs : this.activeToolDiffs;
    // 自算兜底由磁盘真实内容算出，反向应用必然成功；provider 的累计快照可能因
    // 上下文过期而 apply 不上。同一文件以兜底为准，其余仍用 provider 数据。
    const diffs = this.toolFileDiffFallback.mergeWithProviderDiffs(base);
    if (diffs.length === 0) {
      // 没有待发的差异，但也要把兜底缓存清掉，避免下轮沿用上轮的 baseline。
      this.toolFileDiffFallback.reset();
      return;
    }
    this.emitEvent({ type: "diff_update", diffs });
    this.activeTurnDiffs = [];
    this.activeToolDiffs = [];
    this.activeTurnDiffsAuthoritative = true;
    // 兜底在 tool_end 立即发出过；turn 结束时清空缓存，避免下轮误用上一轮的快照。
    this.toolFileDiffFallback.reset();
  }

  private completePendingUIRequest(requestId: string, turnRevision = this.turnRevision) {
    if (this.turnRevision !== turnRevision) return;
    this.pendingUIRequests.delete(requestId);
    if (this.pendingUIRequests.size === 0 && this.idleObservedWhileWaitingForUI) {
      this.scheduleIdleEnd();
    }
  }

  private cancelIdleTimer() {
    this.idleSettlementRevision += 1;
    const hadTimer = this.idleTimer !== null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    return hadTimer;
  }

  private scheduleIdleEnd() {
    this.cancelIdleTimer();
    if (!this.turnActive) return;
    if (this.pendingUIRequests.size > 0) {
      this.idleObservedWhileWaitingForUI = true;
      return;
    }
    this.idleObservedWhileWaitingForUI = false;
    const turnRevision = this.turnRevision;
    const settlementRevision = this.idleSettlementRevision;
    const userMessageId = this.activeOpenCodeUserMessageId;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.isCurrentIdleSettlement(turnRevision, settlementRevision)) return;
      this.idleSettlementInFlight = true;
      void this.finishIdleTurn(turnRevision, settlementRevision, userMessageId)
        .finally(() => {
          if (this.idleSettlementRevision === settlementRevision) this.idleSettlementInFlight = false;
        });
    }, 800);
  }

  private isCurrentIdleSettlement(turnRevision: number, settlementRevision: number) {
    return this.isCurrentTurn(turnRevision) && this.idleSettlementRevision === settlementRevision;
  }

  private async finishIdleTurn(
    turnRevision: number,
    settlementRevision: number,
    userMessageId: string | null,
  ) {
    await this.fetchTurnDiff(userMessageId, turnRevision, settlementRevision);
    if (!this.isCurrentIdleSettlement(turnRevision, settlementRevision)) return;
    if (this.streamedContent) {
      this.finishTurn(turnRevision);
    } else {
      // Fallback: fetch final message via REST (for older opencode versions)
      await this.fetchAssistantMessage(turnRevision, settlementRevision);
    }
  }

  private captureTurnSummaryDiffs(value: unknown, preferredMessageId?: string | null) {
    if (!Array.isArray(value)) return false;
    const messageIds = new Set(this.activeOpenCodeUserMessageIds);
    if (preferredMessageId) messageIds.add(preferredMessageId);
    let foundSummary = false;
    for (const rawMessage of value) {
      const message = asRecord(rawMessage);
      const info = asRecord(message.info);
      const messageId = typeof info.id === "string" ? info.id : "";
      if (!messageId || info.role !== "user" || !messageIds.has(messageId)) continue;
      const summaryDiff = normalizeOpenCodeSessionDiffResult(asRecord(info.summary).diffs);
      if (!summaryDiff.recognized) continue;
      foundSummary = true;
      this.activeOpenCodeUserMessageIds.add(messageId);
      this.activeTurnDiffByMessageId.set(messageId, summaryDiff.diffs);
    }
    if (foundSummary) {
      this.activeTurnDiffs = this.mergeTurnDiffs();
      this.activeTurnDiffsAuthoritative = true;
    }
    return foundSummary;
  }

  private async fetchTurnDiff(
    userMessageId: string | null,
    turnRevision: number,
    settlementRevision = this.idleSettlementRevision,
  ) {
    if (!this.isCurrentIdleSettlement(turnRevision, settlementRevision)) return;
    if (this.activeTurnDiffsAuthoritative) {
      this.emitCachedTurnDiffs();
      return;
    }
    if (!this.sessionId || !userMessageId) return;
    try {
      const result = await this.httpGet(
        `/session/${encodeURIComponent(this.sessionId)}/diff?messageID=${encodeURIComponent(userMessageId)}`,
        2000,
      );
      if (!this.isCurrentIdleSettlement(turnRevision, settlementRevision)) return;
      const normalized = normalizeOpenCodeSessionDiffResult(result);
      if (normalized.recognized && normalized.diffs.length > 0) {
        this.activeTurnDiffs = normalized.diffs;
        this.activeTurnDiffsAuthoritative = true;
        this.emitCachedTurnDiffs();
        return;
      }
      if (this.activeTurnDiffs.length > 0 || this.activeToolDiffs.length > 0) {
        // OpenCode 1.18 在 summary 计算完成前也返回 []；已有非空 SSE
        // 快照比这个暧昧空值更可靠。
        this.emitCachedTurnDiffs();
        return;
      }
      if (!normalized.recognized) return;

      // 空的 message-scoped diff 既可能表示确实没有改动，也可能只是
      // summary 尚未写回。再读取一次消息列表，从已持久化的 user summary
      // 获取权威补丁，避免在 SSE 顺序稍晚时过早结束并丢失 diff。
      const messages = await this.httpGet(
        `/session/${encodeURIComponent(this.sessionId)}/message`,
        2000,
      );
      if (!this.isCurrentIdleSettlement(turnRevision, settlementRevision)) return;
      if (this.captureTurnSummaryDiffs(messages, userMessageId)) {
        this.emitCachedTurnDiffs();
      }
    } catch {
      // OpenCode 旧版本没有 message-scoped diff endpoint；使用此前非空
      // session.diff SSE 的快照，不能因 REST 获取失败丢弃正常回复。
      if (this.isCurrentIdleSettlement(turnRevision, settlementRevision)) {
        this.emitCachedTurnDiffs();
      }
    }
  }

  /** Fetch the latest assistant message content via REST after session.idle */
  private async fetchAssistantMessage(
    turnRevision = this.turnRevision,
    settlementRevision?: number,
  ) {
    const isCurrent = () => settlementRevision === undefined
      ? this.isCurrentTurn(turnRevision)
      : this.isCurrentIdleSettlement(turnRevision, settlementRevision);
    if (!isCurrent()) return;
    if (!this.sessionId) {
      this.finishTurn(turnRevision);
      return;
    }

    try {
      const messages = await this.httpGet(`/session/${this.sessionId}/message`);
      if (!isCurrent()) return;
      if (Array.isArray(messages)) {
        const records = messages.map((message) => asRecord(message));
        // A summary assistant message is the persisted result of compaction,
        // not the response that should be copied into the chat bubble. Older
        // OpenCode versions may not stream the final message.updated event, so
        // recognize and settle it here as a fallback.
        const summaryIndex = records.findLastIndex((message) => (
          asRecord(message.info).role === "assistant" && asRecord(message.info).summary === true
        ));
        const summaryMsg = summaryIndex >= 0 ? records[summaryIndex] : undefined;
        const summaryInfo = asRecord(summaryMsg?.info);
        if (summaryMsg) {
          const summaryId = this.normalizeCompactionMessageId(summaryInfo.id);
          const parentId = this.normalizeCompactionMessageId(summaryInfo.parentID);
          const compactionId = this.getCompactionEventId(summaryId, parentId);
          this.rememberCompactionMessage(summaryId, compactionId);
          this.rememberCompactionMessage(parentId, compactionId);
          this.emitCompactionStarted(compactionId);
          this.emitCompactionFinished(compactionId, summaryInfo.error ? "interrupted" : "completed", summaryInfo.error);
        } else if (this.activeCompactionId) {
          // session.idle is authoritative when the native summary event was
          // lost; do not leave the renderer in an endless "压缩中" state.
          this.emitCompactionFinished(this.activeCompactionId);
        }

        // Find the last non-summary assistant message after the summary. A
        // pre-compaction response must not be replayed merely because the
        // summary is the latest assistant message.
        const visibleAssistantCandidates = summaryIndex >= 0
          ? records.slice(summaryIndex + 1)
          : records;
        const assistantMsg = [...visibleAssistantCandidates]
          .reverse()
          .find((message) => {
            const info = asRecord(message.info);
            return info.role === "assistant" && info.summary !== true;
          });
        this.recordAssistantMessageId(asRecord(assistantMsg?.info).id);
        const assistantParts = Array.isArray(assistantMsg?.parts) ? assistantMsg.parts : [];
        if (assistantParts.length > 0) {
          for (const rawPart of assistantParts) {
            const part = asRecord(rawPart);
            if (part.type === "text" && typeof part.text === "string") {
              this.emitEvent({ type: "stream_delta", delta: part.text });
            } else if (part.type === "thinking" && typeof part.text === "string") {
              this.emitEvent({ type: "thinking_delta", delta: part.text });
              this.emitEvent({ type: "thinking_end" });
            }
          }
        } else if (asRecord(assistantMsg?.info).error) {
          // Message completed with error
          const error = asRecord(asRecord(assistantMsg?.info).error);
          const errorData = asRecord(error.data);
          const errMsg =
            typeof errorData.message === "string" ? errorData.message :
            typeof error.message === "string" ? error.message :
            "请求失败";
          this.emitEvent({ type: "stream_delta", delta: `\n\n错误: ${errMsg}` });
        } else if (!summaryMsg) {
          this.emitEvent({ type: "stream_delta", delta: "\n\n(无响应内容)" });
        }
      }
    } catch (e) {
      if (!isCurrent()) return;
      this.emitEvent({ type: "stream_delta", delta: `\n\n获取响应失败: ${e}` });
    }

    if (!isCurrent()) return;
    this.finishTurn(turnRevision);
  }

  private stopSSEListener() {
    this.cancelIdleTimer();
    const request = this.eventSource;
    this.eventSource = null;
    request?.destroy();
  }

  /** Abort the current response */
  async abort() {
    const turnRevision = this.turnRevision;
    let errorMessage = "";
    if (this.sessionId) {
      try {
        await this.httpPost(`/session/${this.sessionId}/abort`, {});
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }
    // A slow abort reply must never settle a newer turn that started after an
    // independent disconnect/error already completed this one.
    if (turnRevision !== this.turnRevision) return;
    this.emitCachedTurnDiffs();
    this.turnRevision += 1;
    this.clearTurnRuntime();
    this.emitEvent({ type: "aborted", detail: errorMessage || undefined });
  }

  async forkSession(target: AgentForkTarget): Promise<AgentForkResult> {
    const sourceSessionId = target.sourceSessionFilePath || this.sessionId;
    if (!sourceSessionId) {
      return {
        supported: true,
        success: false,
        reason: "OpenCode source session is unavailable",
      };
    }

    if (!target.targetTurnId && (target.rollbackUserMessageCount || 0) > 0) {
      return {
        supported: true,
        success: false,
        reason: "OpenCode native message id is unavailable for this historical turn",
      };
    }

    try {
      const body = target.targetTurnId ? { messageID: target.targetTurnId } : {};
      const result = asRecord(await this.httpPost(`/session/${sourceSessionId}/fork`, body));
      const forkedSessionId = typeof result.id === "string" ? result.id : "";
      if (!forkedSessionId) {
        return {
          supported: true,
          success: false,
          reason: "OpenCode did not return a forked session id",
        };
      }

      return {
        supported: true,
        success: true,
        sessionFilePath: forkedSessionId,
        nativeEntryId: target.targetTurnId,
      };
    } catch (error) {
      return {
        supported: true,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Get available models from providers */
  async getModels(): Promise<AgentModel[]> {
    console.log("[opencode] getModels called, cached:", this.models.length, "port:", this.port);
    if (this.models.length > 0) return this.models;

    this.modelVariants.clear();
    this.actionKeys.clear();
    try {
      const result = asRecord(await this.httpGet("/config/providers"));
      if (Array.isArray(result.providers)) {
        const models: AgentModel[] = [];
        for (const rawProvider of result.providers) {
          const provider = asRecord(rawProvider);
          const providerIdValue = provider.id || provider.name;
          if (providerIdValue === undefined || providerIdValue === null) continue;
          const providerId = String(providerIdValue);
          if (
            providerId.startsWith(HPP_OPENCODE_COMPACTION_PROVIDER)
            && String(provider.name || "") === HPP_OPENCODE_COMPACTION_PROVIDER_NAME
          ) continue;
          if (Array.isArray(provider.models)) {
            for (const rawModel of provider.models) {
              const model = asRecord(rawModel);
              const modelId = model.id || model.name;
              if (modelId === undefined || modelId === null) continue;
              const normalizedModelId = String(modelId);
              const variants = getModelVariants(model);
              this.modelVariants.set(`${providerId}:${normalizedModelId}`, variants);
              models.push({
                id: normalizedModelId,
                name: String(model.name || model.id || modelId),
                provider: providerId,
                reasoning: modelSupportsReasoning(model),
                supportsImages: modelSupportsImages(model),
                supportedThinkingLevels: normalizeOpenCodeThinkingLevels(variants),
              });
            }
          } else if (isRecord(provider.models)) {
            // models may be a record: { modelId: modelInfo }
            for (const [modelId, modelInfo] of Object.entries(provider.models)) {
              const model = asRecord(modelInfo);
              const variants = getModelVariants(modelInfo);
              this.modelVariants.set(`${providerId}:${modelId}`, variants);
              models.push({
                id: modelId,
                name: typeof model.name === "string" ? model.name : modelId,
                provider: providerId,
                reasoning: modelSupportsReasoning(modelInfo),
                supportsImages: modelSupportsImages(modelInfo),
                supportedThinkingLevels: normalizeOpenCodeThinkingLevels(variants),
              });
            }
          } else {
            const defaults = asRecord(result.default);
            const defaultModel = defaults[providerId];
            if (defaultModel === undefined || defaultModel === null) continue;
            models.push({
              id: String(defaultModel),
              name: String(defaultModel),
              provider: providerId,
              reasoning: false,
              supportsImages: false,
            });
          }
        }
        if (models.length > 0) {
          this.models = models;
          return this.models;
        }
      }
    } catch (e) {
      console.error("[opencode] getModels failed:", e);
    }

    return this.models;
  }

  /** Set model for the session - stored and applied per-message */
  async setModel(provider: string, modelId: string) {
    const modelChanged = this.currentModelId !== modelId || this.currentProviderId !== provider;
    this.currentModelId = modelId;
    this.currentProviderId = provider;
    if (
      modelChanged
      && this.process
      && this.compactionConfig.modelMode === "current"
      && this.compactionConfig.thinkingLevel !== "inherit"
    ) {
      await this.restartRuntimeForCompaction();
    }
    this.emitEvent({ type: "model_changed", model: { id: modelId, provider } });
  }

  async setCompactionConfig(value: AgentCompactionConfig): Promise<void> {
    const normalized = normalizeAgentCompactionConfig(value);
    const previousSignature = this.getCompactionSignature(this.compactionConfig);
    this.compactionConfig = normalized;
    if (this.process && this.getCompactionSignature(normalized) !== previousSignature) {
      await this.restartRuntimeForCompaction();
    }
  }

  /** Set the OpenCode model variant used by subsequent prompts. */
  async setThinkingLevel(level: string) {
    const variants = this.modelVariants.get(`${this.currentProviderId}:${this.currentModelId}`) || [];
    const variant = selectThinkingVariant(level, variants);
    if (!variant) throw new Error("UNSUPPORTED_THINKING_LEVEL");
    const effectiveLevel = normalizeOpenCodeThinkingLevel(variant);
    this.currentThinkingLevel = effectiveLevel;
    this.emitEvent({ type: "thinking_level_changed", level: effectiveLevel });
  }

  async sendUIResponse(response: AgentUIResponse): Promise<void> {
    await this.respondToUIRequest(response);
  }

  /** For OpenCode, the session ID serves as the session file path equivalent */
  get sessionFilePath(): string | null { return this.sessionId; }

  /** Dispose and clean up */
  async dispose() {
    this.cancelIdleTimer();
    this.stopSSEListener();
    this.eventBuffer.flush();
    await this.killProcess();
  }

  private async killProcess() {
    const childProcess = this.process;
    this.process = null;
    childProcess?.stdin?.end();
    if (!this.finishTurn()) {
      this.turnRevision += 1;
      this.clearTurnRuntime();
    }
    this.sessionId = null;
    this.activeCompactionSignature = "";
    this.models = [];
    this.modelVariants.clear();
    if (childProcess) await this.killProcessTree(childProcess);
    const runtimeConfigPath = this.runtimeConfigPath;
    this.runtimeConfigPath = null;
    this.openCodeConfigSource = undefined;
    if (runtimeConfigPath) await rm(runtimeConfigPath, { force: true }).catch(() => undefined);
  }

  private getCompactionSignature(config: AgentCompactionConfig): string {
    const pinnedCurrentModel = config.modelMode === "current" && config.thinkingLevel !== "inherit"
      ? { provider: this.currentProviderId, id: this.currentModelId }
      : null;
    return JSON.stringify({ config, pinnedCurrentModel });
  }

  private async restartRuntimeForCompaction(): Promise<void> {
    if (!this.process || !this.projectPath) return;
    if (!this.isIdle()) throw new Error("OpenCode 会话正在运行，无法立即重载上下文压缩设置");
    const sessionId = this.sessionId || undefined;
    await this.init(this.projectPath, sessionId, {
      hostSystemPrompt: this.hostSystemPrompt,
      compaction: this.compactionConfig,
    });
    await this.getModels();
  }

  private async writeRuntimeConfig(): Promise<void> {
    if (!this.runtimeConfigPath) return;
    const content = buildOpenCodeConfigContent(
      this.openCodeConfigSource,
      this.compactionConfig,
      this.currentProviderId && this.currentModelId
        ? { provider: this.currentProviderId, id: this.currentModelId }
        : null,
    );
    await writeFile(this.runtimeConfigPath, `${content}\n`, "utf8");
  }

  private async killProcessTree(childProcess: ChildProcess) {
    if (process.platform !== "win32" || !childProcess.pid) {
      childProcess.kill("SIGKILL");
      return;
    }
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(childProcess.pid), "/t", "/f"], { windowsHide: true }, () => resolve());
    });
  }

  // ---- HTTP helpers ----

  private httpGet(path: string, timeoutMs = 10000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://${this.host}:${this.port}${path}`,
        { timeout: timeoutMs },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            const statusCode = res.statusCode || 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(createHttpError("GET", path, statusCode, body));
              return;
            }
            resolve(parseHttpBody(body));
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
  }

  private httpPost(path: string, data: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const req = http.request(
        `http://${this.host}:${this.port}${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 30000,
        },
        (res) => {
          let resBody = "";
          res.on("data", (chunk) => (resBody += chunk));
          res.on("end", () => {
            const statusCode = res.statusCode || 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(createHttpError("POST", path, statusCode, resBody));
              return;
            }
            resolve(parseHttpBody(resBody));
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.write(body);
      req.end();
    });
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }

  private failActiveTurn(title: string, detail: string) {
    const turnRevision = this.turnRevision;
    this.emitEvent({
      type: "process_event",
      entryType: "error",
      title,
      detail,
      state: "error",
    });
    if (!this.finishTurn(turnRevision)) this.clearTurnRuntime();
  }

  private async respondToUIRequest(response: AgentUIResponse) {
    const requestId = typeof response.id === "string"
      ? response.id
      : typeof response.requestId === "string"
        ? response.requestId
        : "";
    if (!requestId) throw new Error("OpenCode UI response is missing request id");
    const pending = this.pendingUIRequests.get(requestId);
    if (!pending) throw new Error(`Unknown OpenCode UI request: ${requestId}`);
    const kind = pending.kind;
    const turnRevision = this.turnRevision;

    if (kind === "permission") {
      await this.httpPost(`/permission/${encodeURIComponent(requestId)}/reply`, {
        reply: getPermissionReply(response),
      });
    } else if (response.cancelled === true) {
      await this.httpPost(`/question/${encodeURIComponent(requestId)}/reject`, {});
    } else {
      const rawAnswers = Array.isArray(response.answers) ? response.answers : [];
      const answers = rawAnswers.length > 0
        ? rawAnswers.map(getUIAnswerValues)
        : [[String(response.text || response.value || "")].filter(Boolean)];
      await this.httpPost(`/question/${encodeURIComponent(requestId)}/reply`, { answers });
    }
    this.completePendingUIRequest(requestId, turnRevision);
  }

  // step part 的 tokens（input/output/reasoning/cache）随流式输出可能多次更新，
  // 只在差值为正时上报，渲染端按回合累加即为全部调用的总消耗。
  private emitPartTokenUsageDelta(part: UnknownRecord) {
    const partId = typeof part.id === "string" ? part.id : "";
    if (!partId) return;
    const tokens = asRecord(part.tokens);
    // tokens.input 不含缓存部分，缓存命中/写入的输入一并计入总消耗；
    // 缓存命中单独记 cacheInput（写入不算命中）。
    const cache = asRecord(tokens.cache);
    const cacheRead = Number(cache.read) || 0;
    const cacheWrite = Number(cache.write) || 0;
    const input = (Number(tokens.input) || 0) + cacheRead + cacheWrite;
    const output = Number(tokens.output) || 0;
    if (input <= 0 && output <= 0) return;
    const previous = this.partTokenUsage.get(partId) || { input: 0, output: 0, cacheInput: 0 };
    const deltaInput = input - previous.input;
    const deltaOutput = output - previous.output;
    const deltaCacheInput = cacheRead - previous.cacheInput;
    if (deltaInput <= 0 && deltaOutput <= 0) return;
    this.partTokenUsage.set(partId, { input, output, cacheInput: cacheRead });
    this.emitEvent({
      type: "token_usage",
      inputTokens: Math.max(0, deltaInput),
      outputTokens: Math.max(0, deltaOutput),
      cacheInputTokens: Math.max(0, deltaCacheInput),
    });
  }

  private recordAssistantMessageId(value: unknown) {
    if (!this.activeClientMessageId || typeof value !== "string" || !value.startsWith("msg")) return;
    if (value === this.activeAssistantMessageId) return;
    this.activeAssistantMessageId = value;
    this.emitEvent({
      type: "turn_metadata",
      nativeTurnId: value,
      clientUserMessageId: this.activeClientMessageId,
    });
  }

  private rememberPartType(part: UnknownRecord) {
    const partId = typeof part.id === "string" ? part.id : "";
    const partType = typeof part.type === "string" ? part.type : "";
    if (partId && partType) this.partTypes.set(partId, partType);
  }

  private isReasoningPartType(value: unknown) {
    const normalized = normalizeEventName(value);
    return normalized === "reasoning" || normalized === "thinking";
  }

  private emitPartDelta(partType: unknown, delta: unknown, messageId?: unknown) {
    if (delta === undefined || delta === null || delta === "") return;
    // Summary text is an internal compaction artifact. OpenCode's delta event
    // does not carry `info.summary`, so filter by messageID before marking the
    // turn as having visible streamed content.
    if (this.isCompactionMessageId(messageId)) return;
    this.streamedContent = true;
    if (this.isReasoningPartType(partType)) {
      this.emitEvent({ type: "thinking_delta", delta: String(delta) });
      return;
    }
    this.emitEvent({ type: "stream_delta", delta: String(delta) });
  }

  private mergeTurnDiffs() {
    // 每条 user message 的 summary.diff 是一段独立的增量补丁。不能按文件
    // last-write-wins，也不能把两个完整 unified patch 拼成一个字符串：后者
    // 会丢失前一段改动，或让审核事务把多个文件头误判为不安全补丁。
    return [...this.activeOpenCodeUserMessageIds].flatMap((messageId) => (
      this.activeTurnDiffByMessageId.get(messageId) || []
    ));
  }

  private clearActiveTurn() {
    this.activeClientMessageId = null;
    this.activeOpenCodeUserMessageId = null;
    this.activeOpenCodeUserMessageIds.clear();
    this.activeTurnDiffByMessageId.clear();
    this.activeTurnDiffs = [];
    this.activeToolDiffs = [];
    this.activeTurnDiffsAuthoritative = false;
    this.idleSettlementInFlight = false;
    this.activeAssistantMessageId = null;
    this.partTypes.clear();
  }
}
