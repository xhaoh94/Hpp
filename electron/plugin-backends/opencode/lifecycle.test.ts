import { createServer, type Server } from "http";
import type { ChildProcess } from "child_process";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { OpenCodeAgent } from "./backend";

interface OpenCodeInternals {
  sessionId: string | null;
  host: string;
  port: number;
  process: ChildProcess | null;
  killProcess: () => Promise<void>;
  killProcessTree: (childProcess: ChildProcess) => Promise<void>;
}

describe("OpenCode lifecycle", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("waits for the event stream before sending a prompt and acknowledges abort", async () => {
    let eventStreamConnected = false;
    let promptSentAfterConnection = false;
    const server = createServer((request, response) => {
      if (request.url === "/event") {
        setTimeout(() => {
          eventStreamConnected = true;
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write("data: {\"type\":\"server.connected\",\"properties\":{}}\n\n");
        }, 50);
        return;
      }
      if (request.url === "/session/ses_source/prompt_async") {
        promptSentAfterConnection = eventStreamConnected;
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url === "/session/ses_source/abort") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("true");
        return;
      }
      response.writeHead(404);
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.host = "127.0.0.1";
    internals.port = (server.address() as AddressInfo).port;

    await agent.sendMessage("hello", undefined, { clientMessageId: "message-1" });
    expect(promptSentAfterConnection).toBe(true);

    await agent.abort();
    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "aborted" }));
  });

  it("finishes the Hpp turn when the event stream cannot connect", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503);
      response.end("unavailable");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.host = "127.0.0.1";
    internals.port = (server.address() as AddressInfo).port;

    await agent.sendMessage("hello", undefined, { clientMessageId: "message-1" });

    expect(agent.isIdle()).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "stream_end" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_end" }));
  });

  it("terminates the full OpenCode process tree", async () => {
    const agent = new OpenCodeAgent();
    const internals = agent as unknown as OpenCodeInternals;
    const childProcess = {
      pid: 1234,
      stdin: { end: vi.fn() },
      kill: vi.fn(),
    } as unknown as ChildProcess;
    internals.process = childProcess;
    internals.killProcessTree = vi.fn(async () => undefined);

    await internals.killProcess();

    expect(childProcess.stdin?.end).toHaveBeenCalled();
    expect(internals.killProcessTree).toHaveBeenCalledWith(childProcess);
    expect(childProcess.kill).not.toHaveBeenCalled();
  });
});
