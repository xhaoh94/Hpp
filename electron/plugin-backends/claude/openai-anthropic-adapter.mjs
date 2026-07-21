import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const asRecord = (value) => isRecord(value) ? value : {};
const asString = (value) => typeof value === "string" ? value : "";

export const buildChatCompletionsUrl = (rawBaseUrl) => {
  const url = new URL(String(rawBaseUrl || "").trim());
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(path)) url.pathname = path;
  else if (/\/v1$/i.test(path)) url.pathname = `${path}/chat/completions`;
  else url.pathname = `${path}/v1/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

const contentBlockText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((rawBlock) => {
    const block = asRecord(rawBlock);
    if (block.type === "text") return [asString(block.text)];
    if (block.type === "tool_result") return [contentBlockText(block.content)];
    return [];
  }).join("\n");
};

const convertImageBlock = (block) => {
  const source = asRecord(block.source);
  if (source.type === "base64" && source.data) {
    return {
      type: "image_url",
      image_url: { url: `data:${asString(source.media_type) || "image/png"};base64,${source.data}` },
    };
  }
  if (source.type === "url" && source.url) {
    return { type: "image_url", image_url: { url: String(source.url) } };
  }
  return null;
};

const convertUserParts = (blocks) => {
  const parts = [];
  for (const rawBlock of blocks) {
    const block = asRecord(rawBlock);
    if (block.type === "text" && block.text) parts.push({ type: "text", text: String(block.text) });
    else if (block.type === "image") {
      const image = convertImageBlock(block);
      if (image) parts.push(image);
    }
  }
  if (parts.length === 0) return "";
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("\n");
  return parts;
};

const convertAnthropicMessages = (messages) => {
  const converted = [];
  for (const rawMessage of Array.isArray(messages) ? messages : []) {
    const message = asRecord(rawMessage);
    const role = message.role === "assistant" ? "assistant" : "user";
    if (typeof message.content === "string") {
      converted.push({ role, content: message.content });
      continue;
    }
    const blocks = Array.isArray(message.content) ? message.content.map(asRecord) : [];
    if (role === "assistant") {
      const text = blocks.filter((block) => block.type === "text").map((block) => asString(block.text)).join("\n");
      const reasoning = blocks.filter((block) => block.type === "thinking").map((block) => asString(block.thinking)).join("\n");
      const toolCalls = blocks.filter((block) => block.type === "tool_use").map((block) => ({
        id: asString(block.id) || `call_${randomUUID()}`,
        type: "function",
        function: {
          name: asString(block.name),
          arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
        },
      }));
      converted.push({
        role: "assistant",
        content: text || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    let pendingUserBlocks = [];
    const flushUserBlocks = () => {
      if (pendingUserBlocks.length === 0) return;
      converted.push({ role: "user", content: convertUserParts(pendingUserBlocks) });
      pendingUserBlocks = [];
    };
    for (const block of blocks) {
      if (block.type !== "tool_result") {
        pendingUserBlocks.push(block);
        continue;
      }
      flushUserBlocks();
      converted.push({
        role: "tool",
        tool_call_id: asString(block.tool_use_id),
        content: contentBlockText(block.content),
      });
    }
    flushUserBlocks();
    if (blocks.length === 0) converted.push({ role: "user", content: "" });
  }
  return converted;
};

const convertSystem = (system) => {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((block) => asRecord(block)).filter((block) => block.type === "text")
    .map((block) => asString(block.text)).join("\n\n");
};

const convertToolChoice = (rawChoice) => {
  const choice = asRecord(rawChoice);
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: String(choice.name) } };
  }
  return "auto";
};

export const convertAnthropicRequest = (rawBody) => {
  const body = asRecord(rawBody);
  const messages = convertAnthropicMessages(body.messages);
  const system = convertSystem(body.system);
  if (system) messages.unshift({ role: "system", content: system });
  const tools = Array.isArray(body.tools) ? body.tools.map((rawTool) => {
    const tool = asRecord(rawTool);
    return {
      type: "function",
      function: {
        name: asString(tool.name),
        description: asString(tool.description),
        parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
      },
    };
  }).filter((tool) => tool.function.name) : [];
  return {
    model: asString(body.model),
    messages,
    max_tokens: Number.isFinite(body.max_tokens) ? body.max_tokens : 4096,
    stream: body.stream === true,
    ...(Number.isFinite(body.temperature) ? { temperature: body.temperature } : {}),
    ...(Number.isFinite(body.top_p) ? { top_p: body.top_p } : {}),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0 ? { stop: body.stop_sequences } : {}),
    ...(tools.length > 0 ? { tools, tool_choice: convertToolChoice(body.tool_choice) } : {}),
  };
};

const mapStopReason = (finishReason, hasTools = false) => {
  if (hasTools || finishReason === "tool_calls" || finishReason === "function_call") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "stop") return "end_turn";
  return finishReason ? "end_turn" : null;
};

const normalizeUsage = (rawUsage) => {
  const usage = asRecord(rawUsage);
  return {
    input_tokens: Number(usage.prompt_tokens) || 0,
    output_tokens: Number(usage.completion_tokens) || 0,
  };
};

export const convertOpenAIResponse = (rawBody, requestBody = {}) => {
  const body = asRecord(rawBody);
  const choice = asRecord(Array.isArray(body.choices) ? body.choices[0] : null);
  const message = asRecord(choice.message);
  const content = [];
  const reasoning = asString(message.reasoning_content) || asString(message.reasoning);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "hpp-openai-adapter" });
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map(asRecord) : [];
  for (const toolCall of toolCalls) {
    const fn = asRecord(toolCall.function);
    let input = {};
    try { input = JSON.parse(asString(fn.arguments) || "{}"); } catch { input = { raw: asString(fn.arguments) }; }
    content.push({
      type: "tool_use",
      id: asString(toolCall.id) || `call_${randomUUID()}`,
      name: asString(fn.name),
      input,
    });
  }
  return {
    id: asString(body.id) || `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    content,
    model: asString(body.model) || asString(requestBody.model),
    stop_reason: mapStopReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: normalizeUsage(body.usage),
  };
};

const writeSSE = (response, type, data) => {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
};

const createStreamState = (response, requestBody, responseId) => {
  const id = responseId || `msg_${randomUUID()}`;
  let blockIndex = -1;
  let openBlock = null;
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let stopped = false;
  const toolCalls = new Map();

  writeSSE(response, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      model: asString(requestBody.model),
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const closeBlock = () => {
    if (!openBlock) return;
    if (openBlock === "thinking") {
      writeSSE(response, "content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "signature_delta", signature: "hpp-openai-adapter" },
      });
    }
    writeSSE(response, "content_block_stop", { type: "content_block_stop", index: blockIndex });
    openBlock = null;
  };

  const emitText = (kind, text) => {
    if (!text) return;
    if (openBlock !== kind) {
      closeBlock();
      blockIndex += 1;
      openBlock = kind;
      writeSSE(response, "content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: kind === "thinking"
          ? { type: "thinking", thinking: "", signature: "" }
          : { type: "text", text: "" },
      });
    }
    writeSSE(response, "content_block_delta", {
      type: "content_block_delta",
      index: blockIndex,
      delta: kind === "thinking"
        ? { type: "thinking_delta", thinking: text }
        : { type: "text_delta", text },
    });
  };

  const collectToolCalls = (rawCalls) => {
    for (const rawCall of Array.isArray(rawCalls) ? rawCalls : []) {
      const call = asRecord(rawCall);
      const index = Number.isInteger(call.index) ? call.index : toolCalls.size;
      const existing = toolCalls.get(index) || { id: "", name: "", arguments: "" };
      const fn = asRecord(call.function);
      if (call.id) existing.id = String(call.id);
      if (fn.name) existing.name += String(fn.name);
      if (fn.arguments) existing.arguments += String(fn.arguments);
      toolCalls.set(index, existing);
    }
  };

  const pushChunk = (rawChunk) => {
    const chunk = asRecord(rawChunk);
    if (chunk.error) throw new Error(asString(asRecord(chunk.error).message) || "OpenAI-compatible provider returned an error");
    if (chunk.usage) usage = normalizeUsage(chunk.usage);
    for (const rawChoice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const choice = asRecord(rawChoice);
      const delta = asRecord(choice.delta);
      const reasoning = asString(delta.reasoning_content) || asString(delta.reasoning);
      if (reasoning) emitText("thinking", reasoning);
      if (typeof delta.content === "string") emitText("text", delta.content);
      collectToolCalls(delta.tool_calls);
      if (choice.finish_reason) finishReason = String(choice.finish_reason);
    }
  };

  const finish = () => {
    if (stopped) return;
    stopped = true;
    closeBlock();
    for (const [, call] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
      blockIndex += 1;
      writeSSE(response, "content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: call.id || `call_${randomUUID()}`,
          name: call.name,
          input: {},
        },
      });
      if (call.arguments) {
        writeSSE(response, "content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: call.arguments },
        });
      }
      writeSSE(response, "content_block_stop", { type: "content_block_stop", index: blockIndex });
    }
    writeSSE(response, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapStopReason(finishReason, toolCalls.size > 0), stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    writeSSE(response, "message_stop", { type: "message_stop" });
  };

  return { pushChunk, finish };
};

const translateEventStream = async (upstream, response, requestBody) => {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const state = createStreamState(response, requestBody, upstream.headers.get("x-request-id"));
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("OpenAI-compatible provider returned an empty stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let doneEvent = false;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        doneEvent = true;
        break;
      }
      state.pushChunk(JSON.parse(data));
    }
    if (done || doneEvent) break;
  }
  state.finish();
  response.end();
};

const streamJSONResponse = (body, response, requestBody) => {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const state = createStreamState(response, requestBody, asString(body.id));
  const choice = asRecord(Array.isArray(body.choices) ? body.choices[0] : null);
  const message = asRecord(choice.message);
  state.pushChunk({
    choices: [{
      delta: {
        content: message.content,
        reasoning_content: message.reasoning_content || message.reasoning,
        tool_calls: message.tool_calls,
      },
      finish_reason: choice.finish_reason,
    }],
    usage: body.usage,
  });
  state.finish();
  response.end();
};

const readJSONBody = (request) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
    catch { reject(Object.assign(new Error("Request body is not valid JSON"), { statusCode: 400 })); }
  });
  request.on("error", reject);
});

const writeJSON = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
};

const safeTokenEqual = (actual, expected) => {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && timingSafeEqual(left, right);
};

const getRequestToken = (request) => {
  const authorization = asString(request.headers.authorization);
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "");
  return asString(request.headers["x-api-key"]);
};

const getUpstreamError = async (response) => {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    return asString(asRecord(body.error).message) || asString(body.message) || `HTTP ${response.status}`;
  } catch {
    return text.trim().slice(0, 500) || `HTTP ${response.status}`;
  }
};

export const startOpenAIChatAdapter = async (provider, fetchImpl = fetch) => {
  const localToken = randomBytes(32).toString("hex");
  const upstreamUrl = buildChatCompletionsUrl(provider.baseUrl);
  const server = createServer(async (request, response) => {
    try {
      if (!safeTokenEqual(getRequestToken(request), localToken)) {
        writeJSON(response, 401, { type: "error", error: { type: "authentication_error", message: "Unauthorized" } });
        return;
      }
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        writeJSON(response, 200, { ok: true });
        return;
      }
      if (request.method !== "POST" || !/\/v1\/messages(?:\/count_tokens)?$/.test(requestUrl.pathname)) {
        writeJSON(response, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
        return;
      }
      const anthropicBody = await readJSONBody(request);
      if (requestUrl.pathname.endsWith("/count_tokens")) {
        const estimated = Math.max(1, Math.ceil(JSON.stringify(anthropicBody).length / 4));
        writeJSON(response, 200, { input_tokens: estimated });
        return;
      }
      const openAIBody = convertAnthropicRequest(anthropicBody);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      timeout.unref?.();
      response.on("close", () => { if (!response.writableEnded) controller.abort(); });
      let upstream;
      try {
        upstream = await fetchImpl(upstreamUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: openAIBody.stream ? "text/event-stream" : "application/json",
            ...(provider.authMode === "x-api-key"
              ? { "x-api-key": provider.apiKey }
              : { authorization: `Bearer ${provider.apiKey}` }),
          },
          body: JSON.stringify(openAIBody),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!upstream.ok) {
        const message = await getUpstreamError(upstream);
        writeJSON(response, upstream.status, {
          type: "error",
          error: { type: "api_error", message: `OpenAI 转发失败：${message}` },
        });
        return;
      }
      const contentType = upstream.headers.get("content-type") || "";
      if (openAIBody.stream) {
        if (contentType.includes("text/event-stream")) await translateEventStream(upstream, response, anthropicBody);
        else streamJSONResponse(await upstream.json(), response, anthropicBody);
        return;
      }
      writeJSON(response, 200, convertOpenAIResponse(await upstream.json(), anthropicBody));
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) {
          writeSSE(response, "error", {
            type: "error",
            error: { type: "api_error", message: error?.name === "AbortError" ? "OpenAI 转发已中止" : String(error?.message || error) },
          });
          response.end();
        }
        return;
      }
      const status = Number(error?.statusCode) || (error?.name === "AbortError" ? 504 : 500);
      writeJSON(response, status, {
        type: "error",
        error: { type: "api_error", message: error?.name === "AbortError" ? "OpenAI 转发超时" : String(error?.message || error) },
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!isRecord(address) || typeof address.port !== "number") {
    server.close();
    throw new Error("Failed to start the local OpenAI compatibility adapter");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: localToken,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
