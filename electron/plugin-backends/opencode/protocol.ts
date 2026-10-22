import type { UnknownRecord } from "../../../src/types/ipc";

/**
 * OpenCode 协议适配层。
 *
 * OpenCode 2.x 有三处破坏性变更会直接影响 Hpp：服务器路由统一到 `/api/*`、
 * SSE 事件改成 `{ id, type, time, context, payload }` 信封、`prompt` 取代
 * `prompt_async`（载荷从 `parts` 变成 `text` + `files`）。
 *
 * 这里只抽象「路径 / 载荷 / 事件形状」，连接、状态机、diff 合并等仍在
 * backend 里复用；事件在适配层统一还原成 V1 的 `{ type, properties }` 形状，
 * 这样 backend 的事件处理逻辑对两个版本都成立。
 *
 * 路径都返回候选列表：V2 以 `/api/...` 为首选，遇到 404/405 时回退到 V1 路径。
 * OpenCode 2.0 的 spec 仍在演进，回退让个别端点改名时不至于整条链路失败。
 */
export type OpenCodeProtocolId = "v1" | "v2";

export interface NormalizedOpenCodeEvent {
  type: string;
  /** 统一还原成 V1 的 properties 形状，供 backend 的事件处理复用。 */
  properties: UnknownRecord;
}

export interface OpenCodeProtocol {
  readonly id: OpenCodeProtocolId;
  /**
   * 是否有明确的执行生命周期事件（2.x 的 session.execution.*）。
   *
   * 2.x 的 step 之间会长时间没有文本增量（工具执行/思考），不能再像 1.x 那样
   * 用「空闲 800ms」判定 turn 结束，否则会在工具执行中途把会话收尾（表现为
   * 「未收到响应结束事件」以及消息操作栏反复闪现）。有 lifecycle 事件时只在
   * execution 结束时收尾。
   */
  readonly executionLifecycle: boolean;

  healthPaths(): string | string[];
  eventPaths(): string | string[];
  sessionPaths(sessionId: string): string | string[];
  createSessionPaths(): string | string[];
  promptPaths(sessionId: string): string | string[];
  commandPaths(sessionId: string): string | string[];
  messagesPaths(sessionId: string): string | string[];
  abortPaths(sessionId: string): string | string[];
  diffPaths(sessionId: string, messageId: string): string | string[];
  forkPaths(sessionId: string): string | string[];
  /** 模型目录：V1 从 providers 元数据推导，V2 有独立的 /api/model。 */
  modelsPaths(): string | string[];
  skillsPaths(): string | string[];
  commandsPaths(): string | string[];
  permissionReplyPaths(sessionId: string, requestId: string): string | string[];
  /** 权限回复体：2.x 用 { decision }，1.x 用 { reply }。 */
  permissionReplyBody(reply: string): UnknownRecord;
  questionReplyPaths(sessionId: string, requestId: string): string | string[];
  /**
   * 取消问卷：2.x 是 DELETE /form/:id，1.x 是 POST reject。
   * 方法不同，所以这里连方法和请求体一起返回。
   */
  questionRejectRequest(sessionId: string, requestId: string): {
    method: "POST" | "DELETE";
    paths: string | string[];
    data?: unknown;
  };
  /** 问卷回答的提交体：2.x 用 { answer: { fieldKey: value } }。 */
  questionReplyBody(sessionId: string, requestId: string, answers: string[][]): UnknownRecord;

  /** 发送消息载荷：V2 把 parts 拆成 text + files。 */
  promptBody(body: UnknownRecord): UnknownRecord;
  /** 命令载荷：2.x 是 { name, text, files }，1.x 保持原样。 */
  commandBody(body: UnknownRecord): UnknownRecord;
  /** fork 载荷：2.x 是 { before }，1.x 是 { messageID }。 */
  forkBody(messageId: string): UnknownRecord;
  /** 会话级模型切换：2.x 需要单独的 POST /api/session/:id/model；1.x 随消息携带。 */
  modelPaths(sessionId: string): string | string[] | null;
  /** 会话级 agent 切换：2.x 需要单独的 POST /api/session/:id/agent；1.x 随消息携带。 */
  agentPaths(sessionId: string): string | string[] | null;
  /** 把挂载在会话上的宿主 system prompt 落到 2.x 的 instructions 条目上（1.x 用 prompt.system）。 */
  hostSystemPromptPaths(sessionId: string): string | string[] | null;
  /**
   * 归一化消息列表：2.x 返回扁平的 `{ type, content }` 结构且按 desc 请求，
   * 这里转回 backend 一直使用的 V1 `{ info, parts }` 升序形状。
   */
  normalizeMessages(messages: unknown[]): unknown[];
  /** 归一化一条 SSE 事件；返回 null 表示忽略。 */
  normalizeEvent(raw: unknown): NormalizedOpenCodeEvent | null;
}

const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};

const withFallback = (primary: string, fallback: string): string | string[] => (
  primary === fallback ? primary : [primary, fallback]
);

/**
 * 从 `opencode --version` 的输出里取主版本号。
 *
 * 各版本/包装脚本的输出格式不统一（`2.0.30`、`v2.1.0-beta.1`、`opencode 2.1.0`），
 * 这里按「第一个 x.y」宽松提取；严格整串匹配会把带前缀的输出误判成 V1。
 */
export function parseOpenCodeMajorVersion(version: string | undefined | null): number | null {
  const text = String(version || "").trim();
  if (!text) return null;
  const match = text.match(/(?:^|[^\d.])v?(\d+)(?:\.\d+)+/);
  if (match) {
    const major = Number.parseInt(match[1], 10);
    return Number.isFinite(major) ? major : null;
  }
  const bare = text.match(/^v?(\d+)$/);
  if (!bare) return null;
  const major = Number.parseInt(bare[1], 10);
  return Number.isFinite(major) ? major : null;
}

/**
 * 按安装版本选择协议。`override` 来自 HPP_OPENCODE_PROTOCOL，便于在
 * 用户环境里强制某一种协议做排查（值：v1 / v2 / auto）。
 */
export function resolveOpenCodeProtocolId(
  version: string | undefined | null,
  override?: string | null,
): OpenCodeProtocolId {
  const forced = String(override || "").trim().toLowerCase();
  if (forced === "v1" || forced === "1") return "v1";
  if (forced === "v2" || forced === "2") return "v2";
  const major = parseOpenCodeMajorVersion(version);
  return major !== null && major >= 2 ? "v2" : "v1";
}

const v1Protocol: OpenCodeProtocol = {
  id: "v1",
  executionLifecycle: false,
  healthPaths: () => "/global/health",
  eventPaths: () => "/event",
  sessionPaths: (sessionId) => `/session/${sessionId}`,
  createSessionPaths: () => "/session",
  promptPaths: (sessionId) => `/session/${sessionId}/prompt_async`,
  commandPaths: (sessionId) => `/session/${sessionId}/command`,
  messagesPaths: (sessionId) => `/session/${sessionId}/message`,
  abortPaths: (sessionId) => `/session/${sessionId}/abort`,
  diffPaths: (sessionId, messageId) => (
    `/session/${encodeURIComponent(sessionId)}/diff?messageID=${encodeURIComponent(messageId)}`
  ),
  forkPaths: (sessionId) => `/session/${sessionId}/fork`,
  modelsPaths: () => "/config/providers",
  skillsPaths: () => "/skill",
  commandsPaths: () => "/command",
  permissionReplyPaths: (_sessionId, requestId) => `/permission/${encodeURIComponent(requestId)}/reply`,
  permissionReplyBody: (reply) => ({ reply }),
  questionReplyPaths: (_sessionId, requestId) => `/question/${encodeURIComponent(requestId)}/reply`,
  questionRejectRequest: (_sessionId, requestId) => ({
    method: "POST",
    paths: `/question/${encodeURIComponent(requestId)}/reject`,
    data: {},
  }),
  questionReplyBody: (_sessionId, _requestId, answers) => ({ answers }),
  promptBody: (body) => body,
  commandBody: (body) => body,
  forkBody: (messageId) => ({ messageID: messageId }),
  modelPaths: () => null,
  agentPaths: () => null,
  hostSystemPromptPaths: () => null,
  normalizeMessages: (messages) => messages,
  normalizeEvent: (raw) => {
    const record = asRecord(raw);
    const type = typeof record.type === "string" ? record.type : "";
    if (!type) return null;
    return { type, properties: asRecord(record.properties || record) };
  },
};

/** 2.x 的问卷是 session form；回复体需要 field key，按 form id 缓存顺序。 */
const pendingFormFields = new Map<string, Array<{ key: string; multi: boolean }>>();

/**
 * 2.x 没有 prompt.system 字段，宿主的 system prompt 通过官方 instructions
 * 条目挂到会话上（渲染成 `<context key="hpp-host-system">`），语义接近
 * 「随每一步注入的长期指令」，且 PUT 可替换。
 */
export const HOST_SYSTEM_PROMPT_ENTRY_KEY = "hpp-host-system";

const translateV2Form = (data: UnknownRecord): NormalizedOpenCodeEvent | null => {
  const form = asRecord(data.form || data);
  const formId = typeof form.id === "string" ? form.id : "";
  const fields = Array.isArray(form.fields) ? form.fields.map((field) => asRecord(field)) : [];
  if (!formId) return null;
  pendingFormFields.set(formId, fields.map((field) => ({
    key: typeof field.key === "string" ? field.key : "",
    multi: String(field.type || "").toLowerCase() === "multiselect",
  })));
  const questions = fields.map((field) => ({
    id: field.key,
    question: String(field.title || field.key || ""),
    header: field.title,
    multiSelect: String(field.type || "").toLowerCase() === "multiselect",
    options: (Array.isArray(field.options) ? field.options : []).map((option) => {
      const record = asRecord(option);
      const label = String(record.label ?? record.value ?? "");
      // 2.x 的 Form.Answer 要的是 option.value，不是展示用的 label。
      const value = record.value ?? record.label;
      return {
        label,
        ...(value === undefined || value === null ? {} : { value: String(value) }),
        ...(typeof record.description === "string" ? { description: record.description } : {}),
      };
    }),
  }));
  return {
    type: "question.asked",
    properties: {
      id: formId,
      sessionID: form.sessionID,
      title: form.title,
      questions,
    },
  };
};

const v2PartId = (data: UnknownRecord, suffix: string) => {
  const messageId = typeof data.assistantMessageID === "string" ? data.assistantMessageID : "";
  const ordinal = data.ordinal === undefined || data.ordinal === null ? "" : String(data.ordinal);
  return messageId ? `${messageId}:${suffix}:${ordinal}` : undefined;
};

/** 2.x 的附件是 { uri, name }；Hpp 的 file part 用 data URL（core 原生支持 data:）。 */
const v2FileAttachment = (part: UnknownRecord): UnknownRecord | undefined => {
  const uri = typeof part.url === "string" ? part.url : typeof part.uri === "string" ? part.uri : "";
  if (!uri) return undefined;
  const attachment: UnknownRecord = { uri };
  const name = part.filename ?? part.name;
  if (typeof name === "string" && name) attachment.name = name;
  return attachment;
};

const v2ToolPart = (
  data: UnknownRecord,
  state: UnknownRecord,
  tool?: unknown,
) => ({
  id: data.id,
  type: "tool",
  tool,
  callID: data.id,
  messageID: data.assistantMessageID,
  state,
});

/**
 * 把 2.x 的 `session.*` 事件翻译成 backend 已经认识的事件形状。
 *
 * 2.0 把流式输出拆成 session.text/reasoning/tool/step/execution 事件（见
 * packages/core 的事件 schema），与 1.x 的 message.part.* 完全不同；不翻译的话
 * 渲染层收不到任何增量，turn 也不会结束。未知事件原样透传，交给现有的
 * 「不认识就忽略」逻辑。
 */
/**
 * 2.x 的 `session.tool.called/success/failed` 都不带工具名（只有
 * `session.tool.input.started` 有），这里按 tool call id 缓存，供后续终态事件补齐。
 */
const pendingToolNames = new Map<string, string>();

const toolNameOf = (data: UnknownRecord, fallback?: unknown) => {
  const id = typeof data.id === "string" ? data.id : "";
  const cached = id ? pendingToolNames.get(id) : undefined;
  return data.name ?? cached ?? fallback;
};

const forgetToolName = (data: UnknownRecord) => {
  if (typeof data.id === "string") pendingToolNames.delete(data.id);
};

/** 终态工具事件：取缓存/自带的名字，然后清掉缓存。 */
const terminalToolPart = (data: UnknownRecord, state: UnknownRecord) => {
  const part = v2ToolPart(data, state, toolNameOf(data, "tool"));
  forgetToolName(data);
  return part;
};

/** 2.x 的工具结果是一组 Content（text/file），抽出文本供渲染层使用。 */
const flattenV2ToolContent = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const texts: string[] = [];
  for (const rawItem of value) {
    if (typeof rawItem === "string") {
      texts.push(rawItem);
      continue;
    }
    const item = asRecord(rawItem);
    if (typeof item.text === "string") texts.push(item.text);
    else if (typeof item.uri === "string") texts.push(item.uri);
  }
  const joined = texts.filter(Boolean).join("\n");
  return joined || undefined;
};

const translateV2Event = (type: string, data: UnknownRecord): NormalizedOpenCodeEvent => {
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
  switch (type) {
    case "session.tool.input.started": {
      // 只用于缓存工具名，本身不产生渲染事件。
      if (typeof data.id === "string" && typeof data.name === "string") {
        pendingToolNames.set(data.id, data.name);
        if (pendingToolNames.size > 500) {
          const oldest = pendingToolNames.keys().next();
          if (!oldest.done) pendingToolNames.delete(oldest.value);
        }
      }
      return { type, properties: data };
    }
    case "session.text.delta":
      return {
        type: "message.part.delta",
        properties: {
          sessionID,
          partID: v2PartId(data, "text"),
          part: { type: "text" },
          delta: data.delta,
        },
      };
    case "session.reasoning.delta":
      return {
        type: "message.part.delta",
        properties: {
          sessionID,
          partID: v2PartId(data, "reasoning"),
          field: "thinking",
          delta: data.delta,
        },
      };
    case "session.step.started":
      return {
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            id: data.assistantMessageID,
            role: "assistant",
            ...(data.model
              ? {
                // 2.x 的 Model.Ref 用 { id, providerID, variant }，没有 modelID。
                modelID: asRecord(data.model).modelID ?? asRecord(data.model).id,
                providerID: asRecord(data.model).providerID,
              }
              : {}),
          },
        },
      };
    case "session.step.ended":
    case "session.step.failed": {
      // 2.x 每次模型调用的用量在 step 结束时一次性给出（TokenUsage.Info），
      // 而 1.x 是随 part.tokens 多次更新的增量。这里统一成一次 token_usage。
      const tokens = asRecord(data.tokens);
      const cache = asRecord(tokens.cache);
      const input = Number(tokens.input) || 0;
      const output = Number(tokens.output) || 0;
      const cacheRead = Number(cache.read) || 0;
      const cacheWrite = Number(cache.write) || 0;
      // 与 1.x 的 emitPartTokenUsageDelta 保持同一口径：input 不含缓存部分，
      // contextTokens 是这次请求实际携带的完整上下文。
      const contextTokens = input + cacheRead + cacheWrite;
      if (contextTokens <= 0 && output <= 0) {
        return { type, properties: data };
      }
      return {
        type: "token_usage",
        properties: {
          sessionID,
          inputTokens: contextTokens,
          outputTokens: output,
          cacheInputTokens: cacheRead,
          contextTokens,
          contextPrecision: "official",
        },
      };
    }
    case "session.execution.succeeded":
      return { type: "session.idle", properties: { sessionID } };
    case "session.execution.interrupted":
      // 2.x 会因 inactivity / user / shutdown 等原因中断 execution；映射成
      // Hpp 的 aborted，才能显示"已中断"而不是当成正常完成或超时。
      return { type: "aborted", properties: { sessionID, detail: data.reason } };
    case "session.execution.failed":
      return { type: "session.error", properties: { sessionID, error: data.error } };
    case "session.tool.called":
      return {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: v2ToolPart(data, {
            status: "running",
            input: data.input,
            time: { start: Date.now() },
          }, toolNameOf(data)),
        },
      };
    case "session.tool.success":
      return {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: terminalToolPart(data, {
            status: "completed",
            input: data.input,
            output: flattenV2ToolContent(data.content) ?? data.metadata,
            metadata: data.metadata,
            time: { start: Date.now(), end: Date.now() },
          }),
        },
      };
    case "session.tool.failed":
      return {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: terminalToolPart(data, {
            status: "error",
            input: data.input,
            error: data.error ?? flattenV2ToolContent(data.content),
            time: { start: Date.now(), end: Date.now() },
          }),
        },
      };
    case "session.compaction.started":
      return {
        type: "message.part.updated",
        properties: {
          sessionID,
          // 2.x 的事件字段是 { reason, recent, inputID }。
          part: { id: data.id ?? data.inputID, type: "compaction", messageID: data.inputID ?? data.messageID },
        },
      };
    case "session.compaction.ended":
      return { type: "session.compacted", properties: { sessionID } };
    case "form.created":
      return translateV2Form(data) ?? { type: "form.created", properties: data };
    case "form.replied":
      pendingFormFields.delete(String(data.id || ""));
      return { type: "question.replied", properties: data };
    case "form.cancelled":
      pendingFormFields.delete(String(data.id || ""));
      return { type: "question.rejected", properties: data };
    case "session.compaction.failed":
      return { type: "session.error", properties: { sessionID, error: data.error } };
    default:
      return { type, properties: data };
  }
};

const v2Protocol: OpenCodeProtocol = {
  id: "v2",
  executionLifecycle: true,
  // 2.x 没有 JSON 健康端点：CLI 自己也是先探 /api/info（返回 version/pid/urls）。
  healthPaths: () => ["/api/info", "/api/health", "/api/global/health", "/health", "/global/health"],
  eventPaths: () => withFallback("/api/event", "/event"),
  sessionPaths: (sessionId) => withFallback(`/api/session/${sessionId}`, `/session/${sessionId}`),
  createSessionPaths: () => withFallback("/api/session", "/session"),
  promptPaths: (sessionId) => withFallback(`/api/session/${sessionId}/prompt`, `/session/${sessionId}/prompt_async`),
  commandPaths: (sessionId) => withFallback(`/api/session/${sessionId}/command`, `/session/${sessionId}/command`),
  // 2.x 的 message 列表默认只给一页（最旧的），显式要最新一页：
  // diff 回读和「无流式输出」兜底都只看最近的 assistant 消息。
  messagesPaths: (sessionId) => withFallback(
    `/api/session/${sessionId}/message?limit=200&order=desc`,
    `/session/${sessionId}/message`,
  ),
  // 2.x 没有 abort，只有 interrupt。
  abortPaths: (sessionId) => withFallback(`/api/session/${sessionId}/interrupt`, `/session/${sessionId}/abort`),
  diffPaths: (sessionId, messageId) => {
    // 2.x 的 query 是 from/to/context；messageID 是 1.x 的写法。
    const v2Query = `from=${encodeURIComponent(messageId)}`;
    const v1Query = `messageID=${encodeURIComponent(messageId)}`;
    return [
      `/api/session/${encodeURIComponent(sessionId)}/diff?${v2Query}`,
      `/session/${encodeURIComponent(sessionId)}/diff?${v1Query}`,
    ];
  },
  forkPaths: (sessionId) => withFallback(`/api/session/${sessionId}/fork`, `/session/${sessionId}/fork`),
  // 2.x 的 fork 载荷是 { before: messageId }，1.x 是 { messageID }。
  forkBody: (messageId) => ({ before: messageId }),
  modelsPaths: () => withFallback("/api/model", "/config/providers"),
  skillsPaths: () => withFallback("/api/skill", "/skill"),
  commandsPaths: () => withFallback("/api/command", "/command"),
  // 2.x 把回复挂在 session 下：/api/session/:sessionID/permission/:requestID/reply
  permissionReplyPaths: (sessionId, requestId) => withFallback(
    `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
    `/permission/${encodeURIComponent(requestId)}/reply`,
  ),
  // 2.x 的请求体字段是 decision，1.x 才是 reply。
  permissionReplyBody: (reply) => ({ decision: reply }),
  // 2.x 的问卷改用 session form：/api/session/:sessionID/form/:formID/reply。
  questionReplyPaths: (sessionId, requestId) => withFallback(
    `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}/reply`,
    `/question/${encodeURIComponent(requestId)}/reply`,
  ),
  // 2.x 取消表单是 DELETE /form/:id（1.x 是 POST /question/:id/reject）。
  questionRejectRequest: (sessionId, requestId) => ({
    method: "DELETE",
    paths: [
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}`,
      `/question/${encodeURIComponent(requestId)}/reject`,
    ],
  }),
  // 会话级模型/agent 切换：2.x 有独立端点，1.x 随消息携带。
  modelPaths: (sessionId) => withFallback(
    `/api/session/${encodeURIComponent(sessionId)}/model`,
    `/session/${encodeURIComponent(sessionId)}/model`,
  ),
  agentPaths: (sessionId) => withFallback(
    `/api/session/${encodeURIComponent(sessionId)}/agent`,
    `/session/${encodeURIComponent(sessionId)}/agent`,
  ),
  hostSystemPromptPaths: (sessionId) => (
    `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${HOST_SYSTEM_PROMPT_ENTRY_KEY}`
  ),
  normalizeMessages: (messages) => {
    if (messages.length === 0) return messages;
    // 回退到 V1 端点时拿到的仍是 { info, parts }，原样返回。
    const first = asRecord(messages[0]);
    if (first.info !== undefined) return messages;
    const normalized: unknown[] = [];
    // 请求用的是 order=desc（最新在前），backend 的逻辑按升序处理。
    for (const rawMessage of [...messages].reverse()) {
      const message = asRecord(rawMessage);
      const id = typeof message.id === "string" ? message.id : "";
      if (!id) continue;
      const time = message.time;
      if (message.type === "user") {
        const parts: UnknownRecord[] = [];
        if (typeof message.text === "string" && message.text) {
          parts.push({ type: "text", text: message.text });
        }
        for (const rawFile of Array.isArray(message.files) ? message.files : []) {
          const file = asRecord(rawFile);
          const source = asRecord(file.source);
          // 2.x 的 user 消息附件是 { data, mime, source }；fetchAssistantMessage
          // 的兜底只需要把文件还原成 V1 的 url/filename 形状。
          const uri = typeof file.uri === "string" && file.uri
            ? file.uri
            : typeof source.uri === "string" && source.uri
              ? source.uri
              : typeof file.data === "string" && typeof file.mime === "string"
                ? `data:${file.mime};base64,${file.data}`
                : "";
          if (!uri) continue;
          const part: UnknownRecord = { type: "file", url: uri };
          if (typeof file.name === "string" && file.name) part.filename = file.name;
          parts.push(part);
        }
        normalized.push({ info: { id, role: "user", time }, parts });
        continue;
      }
      if (message.type === "assistant") {
        const parts: UnknownRecord[] = [];
        for (const rawContent of Array.isArray(message.content) ? message.content : []) {
          const content = asRecord(rawContent);
          if (typeof content.text !== "string") continue;
          if (content.type === "text") parts.push({ type: "text", text: content.text });
          // V1 的推理片段类型是 thinking。
          else if (content.type === "reasoning") parts.push({ type: "thinking", text: content.text });
        }
        normalized.push({
          info: {
            id,
            role: "assistant",
            time,
            ...(message.error ? { error: message.error } : {}),
          },
          parts,
        });
        continue;
      }
      if (message.type === "compaction") {
        // V1 把压缩结果编码成 summary === true 的 assistant 消息。
        normalized.push({
          info: {
            id,
            role: "assistant",
            summary: true,
            time,
            ...(message.status === "failed" && message.error ? { error: message.error } : {}),
          },
          parts: [],
        });
      }
      // 其余类型（system/synthetic/skill/shell/idle/agent-switched…）不参与
      // 回复回读与 diff 兜底，直接跳过。
    }
    return normalized;
  },
  questionReplyBody: (_sessionId, requestId, answers) => {
    const fields = pendingFormFields.get(requestId);
    pendingFormFields.delete(requestId);
    const answer: UnknownRecord = {};
    if (fields && fields.length > 0) {
      fields.forEach((field, index) => {
        const values = answers[index] || [];
        answer[field.key] = field.multi ? values : (values[0] ?? "");
      });
    } else {
      answers.forEach((values, index) => {
        answer[`field-${index + 1}`] = values.length > 1 ? values : (values[0] ?? "");
      });
    }
    return { answer };
  },
  promptBody: (body) => {
    const parts = Array.isArray(body.parts) ? body.parts : [];
    const texts: string[] = [];
    const files: UnknownRecord[] = [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (part.type === "file") {
        const attachment = v2FileAttachment(part);
        if (attachment) files.push(attachment);
      } else if (typeof part.text === "string") {
        texts.push(part.text);
      }
    }
    const { parts: _parts, system: _system, model: _model, agent: _agent, variant: _variant, ...rest } = body;
    // 2.x 的 PromptInput 没有 system/model/agent（model/agent 用独立的 session
    // 级端点切换，system 用 instructions 条目）。variant 也不在顶层。
    const payload: UnknownRecord = { ...rest, text: texts.join("\n") };
    if (files.length > 0) payload.files = files;
    // 2.x 的 delivery 取值是 steer / queue：Hpp 自己管理队列，这里用 steer
    // 把消息直接交给当前执行流（没有运行时等价于立即开始）。
    if (payload.delivery === undefined) payload.delivery = "steer";
    return payload;
  },
  commandBody: (body) => {
    const parts = Array.isArray(body.parts) ? body.parts : [];
    const files = parts
      .map((rawPart) => asRecord(rawPart))
      .filter((part) => part.type === "file")
      .map((part) => v2FileAttachment(part))
      .filter((attachment): attachment is UnknownRecord => !!attachment);
    const payload: UnknownRecord = {
      name: body.command,
      text: typeof body.arguments === "string" ? body.arguments : "",
    };
    if (files.length > 0) payload.files = files;
    // 与 promptBody 一致：Hpp 自己管理队列，命令直接交给当前执行流。
    if (payload.delivery === undefined) payload.delivery = "steer";
    return payload;
  },
  normalizeEvent: (raw) => {
    const record = asRecord(raw);
    const type = typeof record.type === "string" ? record.type : "";
    if (!type) return null;
    // 实测 2.0.32 的信封是 { id, created, type, location?, data, durable? }；
    // 早期 spec 写的是 payload，这里三种都兜底。
    const data = asRecord(record.data || record.payload || record.properties || record);
    return translateV2Event(type, data);
  },
};

export const OPEN_CODE_PROTOCOLS: Record<OpenCodeProtocolId, OpenCodeProtocol> = {
  v1: v1Protocol,
  v2: v2Protocol,
};

export function getOpenCodeProtocol(id: OpenCodeProtocolId): OpenCodeProtocol {
  return OPEN_CODE_PROTOCOLS[id] || v1Protocol;
}
