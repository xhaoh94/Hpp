import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The adapter is shipped as an unbundled worker-side ESM module.
import {
  buildChatCompletionsUrl,
  convertAnthropicRequest,
  convertOpenAIResponse,
  startOpenAIChatAdapter,
} from "./openai-anthropic-adapter.mjs";

const servers: Server[] = [];
const adapters: Array<{ close: () => Promise<void> }> = [];

const listen = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    const address = server.address();
    if (!address || typeof address === "string") reject(new Error("Missing test server port"));
    else resolve(address.port);
  });
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Claude OpenAI compatibility adapter", () => {
  it("builds Chat Completions URLs without duplicating v1", () => {
    expect(buildChatCompletionsUrl("https://api.example.com/v1"))
      .toBe("https://api.example.com/v1/chat/completions");
    expect(buildChatCompletionsUrl("https://api.example.com/root"))
      .toBe("https://api.example.com/root/v1/chat/completions");
    expect(buildChatCompletionsUrl("https://api.example.com/v1/chat/completions"))
      .toBe("https://api.example.com/v1/chat/completions");
  });

  it("converts system, images, tools, and tool results to OpenAI messages", () => {
    const converted = convertAnthropicRequest({
      model: "free-model",
      max_tokens: 2048,
      system: [{ type: "text", text: "System prompt" }],
      tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      tool_choice: { type: "tool", name: "Read" },
      messages: [
        { role: "user", content: [{ type: "text", text: "Look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file text" }] },
      ],
    });

    expect(converted).toMatchObject({
      model: "free-model",
      max_tokens: 2048,
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url" }] },
        { role: "assistant", tool_calls: [{ id: "tool-1", function: { name: "Read", arguments: "{\"path\":\"a.ts\"}" } }] },
        { role: "tool", tool_call_id: "tool-1", content: "file text" },
      ],
      tools: [{ type: "function", function: { name: "Read" } }],
      tool_choice: { type: "function", function: { name: "Read" } },
    });
  });

  it("converts a non-streaming OpenAI response", () => {
    expect(convertOpenAIResponse({
      id: "chat-1",
      model: "free-model",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "Checking",
          reasoning_content: "Need a file",
          tool_calls: [{ id: "call-1", function: { name: "Read", arguments: "{\"path\":\"a.ts\"}" } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })).toMatchObject({
      id: "chat-1",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "Need a file" },
        { type: "text", text: "Checking" },
        { type: "tool_use", id: "call-1", name: "Read", input: { path: "a.ts" } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });

  it("forwards and converts OpenAI SSE reasoning, text, and tool calls", async () => {
    let upstreamBody: Record<string, unknown> = {};
    let upstreamAuthorization = "";
    const upstream = createServer((request, response) => {
      upstreamAuthorization = String(request.headers.authorization || "");
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"id":"chat-1","choices":[{"delta":{"reasoning_content":"think"},"finish_reason":null}]}\n\n');
        response.write('data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\n');
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"Read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n');
        response.end("data: [DONE]\n\n");
      });
    });
    servers.push(upstream);
    const port = await listen(upstream);
    const adapter = await startOpenAIChatAdapter({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "upstream-secret",
      authMode: "bearer",
    });
    adapters.push(adapter);

    const response = await fetch(`${adapter.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${adapter.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "free-model", max_tokens: 512, stream: true, messages: [{ role: "user", content: "Hello" }] }),
    });
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(upstreamAuthorization).toBe("Bearer upstream-secret");
    expect(upstreamBody).toMatchObject({
      model: "free-model",
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(stream).toContain('"type":"thinking_delta","thinking":"think"');
    expect(stream).toContain('"type":"text_delta","text":"done"');
    expect(stream).toContain('"type":"tool_use","id":"call-1","name":"Read"');
    expect(stream).toContain('"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"');
    expect(stream).toContain('"stop_reason":"tool_use"');
    expect(stream).toContain('"output_tokens":7');
  });

  it("rejects callers without the local adapter token", async () => {
    const upstream = createServer();
    servers.push(upstream);
    const port = await listen(upstream);
    const adapter = await startOpenAIChatAdapter({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "secret", authMode: "bearer" });
    adapters.push(adapter);

    const response = await fetch(`${adapter.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});
