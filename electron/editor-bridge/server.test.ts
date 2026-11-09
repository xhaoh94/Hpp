import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  const home = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return {
    listeners,
    userData: `${home}/hpp-editor-bridge-test`,
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        listeners.set(channel, listener);
      }),
    },
  };
});

vi.mock("electron", () => ({
  app: { getPath: () => mockState.userData, getAppPath: () => mockState.userData, isPackaged: false },
  ipcMain: mockState.ipcMain,
}));

import { readFile } from "fs/promises";
import { request as httpRequest } from "http";

import {
  EDITOR_BRIDGE_RESULT_CHANNEL,
  EDITOR_BRIDGE_SEND_PATH,
  EDITOR_BRIDGE_TOKEN_HEADER,
} from "../../shared/editor-bridge-protocol";
import { EditorBridgeServer } from "./server";

type SentPayload = { requestId: string; request: { kind: string; path: string; startLine?: number } };

function createWindow() {
  const sent: SentPayload[] = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    focus: vi.fn(),
    webContents: {
      isLoading: () => false,
      send: (channel: string, payload: SentPayload) => {
        if (channel === "editor-bridge:insert") sent.push(payload);
      },
    },
  };
  return { window, sent };
}

function post(port: number, token: string | undefined, body: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": payload.length,
    };
    if (token !== undefined) headers[EDITOR_BRIDGE_TOKEN_HEADER] = token;
    const req = httpRequest({ host: "127.0.0.1", port, path: EDITOR_BRIDGE_SEND_PATH, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function waitFor(check: () => boolean, timeout = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const selection = {
  version: 1,
  client: "vscode",
  kind: "selection",
  path: "/repo/src/a.ts",
  startLine: 3,
  endLine: 9,
};

describe("editor bridge server", () => {
  let server: EditorBridgeServer;
  let fake: ReturnType<typeof createWindow>;
  let token: string;

  beforeEach(async () => {
    fake = createWindow();
    server = new EditorBridgeServer(0);
    await server.initialize(() => fake.window as never);
    const raw = await readFile(server.getStatus().discoveryPath, "utf8");
    token = JSON.parse(raw).token as string;
  });

  afterEach(async () => {
    await server.stop();
    mockState.listeners.clear();
  });

  it("writes a discovery record on start and reports it", () => {
    const status = server.getStatus();
    expect(status.running).toBe(true);
    expect(status.port).toBeGreaterThan(0);
    expect(status.discoveryPath).toContain("editor-bridge.json");
  });

  it("rejects a request without the token", async () => {
    const response = await post(server.getStatus().port, undefined, selection);
    expect(response.status).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(fake.sent).toHaveLength(0);
  });

  it("rejects a wrong token", async () => {
    const response = await post(server.getStatus().port, "not-the-token", selection);
    expect(response.status).toBe(401);
  });

  it("only responds ok after the renderer confirms the insert", async () => {
    const status = server.getStatus();
    const pending = post(status.port, token, selection);
    await waitFor(() => fake.sent.length === 1);
    expect(fake.sent[0].request.startLine).toBe(3);

    mockState.listeners.get(EDITOR_BRIDGE_RESULT_CHANNEL)?.({}, {
      requestId: fake.sent[0].requestId,
      success: true,
    });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, inserted: true });
  });

  it("surfaces a renderer-side failure to the client", async () => {
    const status = server.getStatus();
    const pending = post(status.port, token, selection);
    await waitFor(() => fake.sent.length === 1);
    mockState.listeners.get(EDITOR_BRIDGE_RESULT_CHANNEL)?.({}, {
      requestId: fake.sent[0].requestId,
      success: false,
      error: "Hpp 当前没有打开的会话，无法插入。",
    });
    const response = await pending;
    expect(response.status).toBe(500);
    expect(response.body.error).toContain("没有打开的会话");
  });

  it("rejects a selection without a line range before touching the renderer", async () => {
    const status = server.getStatus();
    const response = await post(status.port, token, { ...selection, endLine: undefined });
    expect(response.status).toBe(400);
    expect(fake.sent).toHaveLength(0);
  });
});
