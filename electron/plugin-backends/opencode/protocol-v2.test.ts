import { createServer, type Server, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { OpenCodeAgent } from "./backend";
import { getOpenCodeProtocol } from "./protocol";

type Internals = {
  protocol: { id: string };
  sessionId: string | null;
  host: string;
  port: number;
  sseBuffer: string;
  processSSEBuffer: () => void;
  pendingUIRequests: Map<string, { kind: "question" | "permission"; sessionId?: string }>;
  respondToUIRequest: (response: Record<string, unknown>) => Promise<void>;
  activeOpenCodeUserMessageIds: Set<string>;
  guidancePendingResponse: boolean;
  guidanceUserMessageId: string | null;
  turnActive: boolean;
  currentProviderId: string | null;
  currentModelId: string | null;
  currentThinkingLevel: string;
  modelVariants: Map<string, string[]>;
};

const asInternals = (agent: OpenCodeAgent) => agent as unknown as Internals;

// 这里用真实换行拼 SSE 帧：直接写 "\n" 容易在工具链里被转义成字面反斜杠 n。
const NL = String.fromCharCode(10);
const SSE_END = NL + NL;

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const v2Envelope = (type: string, payload: Record<string, unknown>, id = "evt_1") => JSON.stringify({
  id,
  type,
  time: Date.now(),
  context: { directory: "/repo" },
  payload,
});

describe("OpenCode V2 protocol wiring", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      // SSE 会一直保持连接，close() 之前先断开活动连接。
      (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close(() => resolve());
    })));
  });

  const startServer = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  };

  it("sends prompts to /api and normalizes the V2 event envelope", async () => {
    let promptPath = "";
    let promptBody: Record<string, unknown> | null = null;
    const port = await startServer((request, response) => {
      if (request.url === "/api/event") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${v2Envelope("message.part.delta", {
          sessionID: "ses_v2",
          partID: "prt_1",
          delta: "hello from v2",
        })}${SSE_END}`);
        return;
      }
      if (request.url === "/api/session/ses_v2/prompt") {
        promptPath = request.url;
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          promptBody = JSON.parse(body);
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ data: { id: "msg_user_v2", sessionID: "ses_v2", type: "user", time: { created: Date.now() }, payload: { text: "hello" }, delivery: "steer" } }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = asInternals(agent);
    internals.protocol = getOpenCodeProtocol("v2");
    internals.sessionId = "ses_v2";
    internals.host = "127.0.0.1";
    internals.port = port;

    await agent.sendMessage("hello", undefined, { clientMessageId: "message-v2" });
    await waitFor(() => events.some((event) => event.type === "stream_delta"));

    expect(promptPath).toBe("/api/session/ses_v2/prompt");
    expect(promptBody).toMatchObject({ text: "hello", delivery: "steer" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "stream_delta",
      delta: "hello from v2",
    }));
  });

  it("unwraps V2 envelopes that arrive through the SSE buffer", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = asInternals(agent);
    internals.protocol = getOpenCodeProtocol("v2");
    internals.sessionId = "ses_buffer";

    // 2.0 的真实增量事件是 session.text.delta（带 assistantMessageID/ordinal），
    // 适配层需要把它翻译成 backend 认识的 message.part.delta。
    internals.sseBuffer = `data: ${JSON.stringify({
      id: "evt_2",
      created: Date.now(),
      type: "session.text.delta",
      data: {
        sessionID: "ses_buffer",
        assistantMessageID: "msg_buffer",
        ordinal: 1,
        delta: "buffered delta",
      },
    })}${SSE_END}`;
    internals.processSSEBuffer();
    // stream_delta 走 AgentEventBuffer 的 50ms 合并窗口。
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(events).toContainEqual(expect.objectContaining({
      type: "stream_delta",
      delta: "buffered delta",
    }));
  });

  it("emits token usage when a V2 step ends", () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = asInternals(agent);
    internals.protocol = getOpenCodeProtocol("v2");
    internals.sessionId = "ses_usage";

    // 2.0.32 的用量在 session.step.ended.tokens 里（TokenUsage.Info），
    // 1.x 的 part.tokens 路径在 2.x 完全不存在，必须在这里补上。
    internals.sseBuffer = `data: ${JSON.stringify({
      id: "evt_usage",
      created: Date.now(),
      type: "session.step.ended",
      data: {
        sessionID: "ses_usage",
        assistantMessageID: "msg_usage",
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
      },
    })}${SSE_END}`;
    internals.processSSEBuffer();

    expect(events).toContainEqual(expect.objectContaining({
      type: "token_usage",
      inputTokens: 140,
      outputTokens: 20,
      cacheInputTokens: 30,
      contextTokens: 140,
      contextPrecision: "official",
    }));
  });

  it("replies to permissions through the session-scoped V2 route", async () => {
    const paths: string[] = [];
    const bodies: string[] = [];
    const port = await startServer((request, response) => {
      if (request.url?.startsWith("/api/session/ses_v2/permission/")) {
        paths.push(request.url);
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          bodies.push(body);
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end("{}");
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = asInternals(agent);
    internals.protocol = getOpenCodeProtocol("v2");
    internals.sessionId = "ses_v2";
    internals.host = "127.0.0.1";
    internals.port = port;
    // 2.x 的权限回复挂在 session 下，必须用请求所属会话拼路径。
    internals.pendingUIRequests = new Map([["per_1", { kind: "permission", sessionId: "ses_v2" }]]);

    // 渲染端会带 selected（label）和 values（选项值）；协议侧必须取后者，
    // 否则「拒绝」会被当成默认的 once。
    await internals.respondToUIRequest({
      id: "per_1",
      answers: [{ selected: ["拒绝"], values: ["reject"] }],
    });

    expect(paths).toEqual(["/api/session/ses_v2/permission/per_1/reply"]);
    // 2.x 的权限回复体字段是 decision。
    expect(JSON.parse(bodies[0])).toEqual({ decision: "reject" });
  });

  it("handles question rejection with DELETE for V2 forms", async () => {
    const paths: string[] = [];
    const methods: string[] = [];
    const port = await startServer((request, response) => {
      methods.push(request.method || "");
      if (request.url === "/api/session/ses_v2/form/frm_1") {
        paths.push(request.url);
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = asInternals(agent);
    internals.protocol = getOpenCodeProtocol("v2");
    internals.sessionId = "ses_v2";
    internals.host = "127.0.0.1";
    internals.port = port;
    internals.pendingUIRequests = new Map([["frm_1", { kind: "question", sessionId: "ses_v2" }]]);

    await internals.respondToUIRequest({ id: "frm_1", cancelled: true });
    expect(methods).toContainEqual("DELETE");
    expect(paths).toContainEqual("/api/session/ses_v2/form/frm_1");
  });

  it("syncs the session-level agent, model and instructions before prompting", async () => {
    const calls: Array<{ method: string; path: string; body: string }> = [];
    const port = await startServer((request, response) => {
      const readBody = (onDone: (body: string) => void) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => onDone(body));
      };
      if (request.url === "/api/event") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.flushHeaders();
        return;
      }
      if (
        request.url === "/api/session/ses_v2/agent"
        || request.url === "/api/session/ses_v2/model"
        || request.url === "/api/experimental/session/ses_v2/instructions/entries/hpp-host-system"
      ) {
        readBody((body) => {
          calls.push({ method: request.method || "", path: request.url || "", body });
          response.writeHead(204);
          response.end();
        });
        return;
      }
      if (request.url === "/api/session/ses_v2/prompt") {
        readBody((body) => {
          calls.push({ method: request.method || "", path: request.url || "", body });
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ data: { id: "msg_user_sync" } }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = asInternals(agent);
    internals.protocol = getOpenCodeProtocol("v2");
    internals.sessionId = "ses_v2";
    internals.host = "127.0.0.1";
    internals.port = port;
    internals.currentProviderId = "p";
    internals.currentModelId = "m";
    internals.currentThinkingLevel = "high";
    internals.modelVariants = new Map([["p:m", ["high"]]]);

    await agent.sendMessage("hello", undefined, {
      clientMessageId: "message-sync",
      hostSystemPrompt: "宿主规则",
    });
    await waitFor(() => calls.length >= 4);

    // 2.x 的 prompt 载荷没有 system/agent/model/variant，必须先落到会话级状态。
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/session/ses_v2/agent",
      "POST /api/session/ses_v2/model",
      "PUT /api/experimental/session/ses_v2/instructions/entries/hpp-host-system",
      "POST /api/session/ses_v2/prompt",
    ]);
    expect(JSON.parse(calls[0].body)).toEqual({ agent: "build" });
    // Model.Ref 的字段是 id（不是 modelID），variant 绑在 ref 上。
    expect(JSON.parse(calls[1].body)).toEqual({ model: { providerID: "p", id: "m", variant: "high" } });
    expect(JSON.parse(calls[2].body)).toEqual({ value: "宿主规则" });
    expect(JSON.parse(calls[3].body)).toEqual({ text: "hello", delivery: "steer" });
    // prompt 响应里的 inbox user id 就是本轮的 user 消息 id。
    expect(internals.activeOpenCodeUserMessageIds.has("msg_user_sync")).toBe(true);
  });

  it("confirms guidance on session.inbox.delivered for V2", async () => {
    let sse: ServerResponse | null = null;
    const port = await startServer((request, response) => {
      if (request.url === "/api/event") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.flushHeaders();
        sse = response;
        return;
      }
      if (request.url === "/api/session/ses_v2/prompt") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ data: { id: "msg_guide" } }));
          setTimeout(() => {
            sse?.write(`data: ${v2Envelope("session.inbox.enqueued", { sessionID: "ses_v2", inboxID: "msg_guide" })}${SSE_END}`);
            sse?.write(`data: ${v2Envelope("session.inbox.delivered", { sessionID: "ses_v2", inboxID: "msg_guide" }, "evt_2")}${SSE_END}`);
          }, 20);
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = asInternals(agent);
    internals.protocol = getOpenCodeProtocol("v2");
    internals.sessionId = "ses_v2";
    internals.host = "127.0.0.1";
    internals.port = port;
    internals.turnActive = true;

    await agent.sendGuidance("steer this");
    await waitFor(() => events.some((event) => event.type === "guidance_response_started"));

    expect(events).toContainEqual(expect.objectContaining({ type: "guidance_response_started" }));
    expect(internals.guidancePendingResponse).toBe(false);
    expect(internals.guidanceUserMessageId).toBeNull();
    expect(internals.activeOpenCodeUserMessageIds.has("msg_guide")).toBe(true);
  });

  it("keeps a V2 turn open during idle steps and ends it on execution completion", async () => {
    let sseResponse: import("http").ServerResponse | null = null;
    const port = await startServer((request, response) => {
      if (request.url === "/api/event") {
        sseResponse = response;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${v2Envelope("server.connected", {})}${SSE_END}`);
        return;
      }
      if (request.url === "/api/session/ses_step/prompt") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
        // 一个 step 产出文本后长时间没有增量（工具执行中）。
        sseResponse?.write(`data: ${v2Envelope("session.text.delta", {
          sessionID: "ses_step",
          assistantMessageID: "msg_step",
          ordinal: 1,
          delta: "working",
        })}${SSE_END}`);
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = asInternals(agent);
    internals.protocol = getOpenCodeProtocol("v2");
    internals.sessionId = "ses_step";
    internals.host = "127.0.0.1";
    internals.port = port;

    await agent.sendMessage("hello", undefined, { clientMessageId: "message-step" });
    await waitFor(() => events.some((event) => event.type === "stream_delta"));
    // 1.x 会在空闲 800ms 后收尾；2.x 必须继续等待 execution 结束。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(events.some((event) => event.type === "stream_end")).toBe(false);

    sseResponse?.write(`data: ${v2Envelope("session.execution.succeeded", { sessionID: "ses_step" })}${SSE_END}`);
    await waitFor(() => events.some((event) => event.type === "stream_end"));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_end" }));
  }, 20_000);

  it("maps V2 execution.interrupted to an aborted turn", async () => {
    let sseResponse: import("http").ServerResponse | null = null;
    const port = await startServer((request, response) => {
      if (request.url === "/api/event") {
        sseResponse = response;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${v2Envelope("server.connected", {})}${SSE_END}`);
        return;
      }
      if (request.url === "/api/session/ses_abort/prompt") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
        sseResponse?.write(`data: ${v2Envelope("session.text.delta", {
          sessionID: "ses_abort",
          assistantMessageID: "msg_abort",
          ordinal: 1,
          delta: "partial",
        })}${SSE_END}`);
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = asInternals(agent);
    internals.protocol = getOpenCodeProtocol("v2");
    internals.sessionId = "ses_abort";
    internals.host = "127.0.0.1";
    internals.port = port;

    await agent.sendMessage("hello", undefined, { clientMessageId: "message-abort" });
    await waitFor(() => events.some((event) => event.type === "stream_delta"));

    sseResponse?.write(`data: ${v2Envelope("session.execution.interrupted", {
      sessionID: "ses_abort",
      reason: "inactivity",
    })}${SSE_END}`);
    await waitFor(() => events.some((event) => event.type === "aborted"));
    expect(events).toContainEqual(expect.objectContaining({
      type: "aborted",
      detail: "inactivity",
    }));
    // 中断后不应再被标记成正常完成。
    expect(events.some((event) => event.type === "stream_end")).toBe(false);
  }, 20_000);

  it("falls back to V1 endpoints when /api routes are missing", async () => {
    let usedPath = "";
    const port = await startServer((request, response) => {
      if (request.url === "/event") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: {"type":"server.connected","properties":{}}${SSE_END}`);
        return;
      }
      if (request.url === "/session/ses_v1/prompt_async") {
        usedPath = request.url;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
        return;
      }
      // 所有 /api/* 都当作 V2 尚未落地。
      response.writeHead(404);
      response.end();
    });

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event as AgentEvent));
    const internals = asInternals(agent);
    internals.protocol = getOpenCodeProtocol("v2");
    internals.sessionId = "ses_v1";
    internals.host = "127.0.0.1";
    internals.port = port;

    await agent.sendMessage("hello", undefined, { clientMessageId: "message-fallback" });
    await waitFor(() => usedPath !== "");

    expect(usedPath).toBe("/session/ses_v1/prompt_async");
  });
});
