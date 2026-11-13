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

const foregroundState = vi.hoisted(() => ({ requestWindowsForeground: vi.fn() }));

// 真跑 PowerShell 太慢且有副作用，只验证「调了原生抢前台」这条边界。
vi.mock("./force-foreground", () => ({
  requestWindowsForeground: foregroundState.requestWindowsForeground,
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
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    moveTop: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    getNativeWindowHandle: () => Buffer.alloc(8),
    webContents: {
      isLoading: () => false,
      focus: vi.fn(),
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

  async function completeInsert(body = selection) {
    const pending = post(server.getStatus().port, token, body);
    await waitFor(() => fake.sent.length === 1);
    mockState.listeners.get(EDITOR_BRIDGE_RESULT_CHANNEL)?.({}, {
      requestId: fake.sent[0].requestId,
      success: true,
    });
    await pending;
  }

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

  it("默认把 Hpp 提到前台（含最小化到托盘的情形）", async () => {
    fake.window.isMinimized.mockReturnValue(true);
    fake.window.isVisible.mockReturnValue(false);
    await completeInsert();
    expect(fake.window.restore).toHaveBeenCalled();
    expect(fake.window.show).toHaveBeenCalled();
    expect(fake.window.moveTop).toHaveBeenCalled();
    expect(fake.window.focus).toHaveBeenCalled();
    // 窗口前置后还要让 web 内容拿键盘焦点，否则输入仍留在编辑器里。
    expect(fake.window.webContents.focus).toHaveBeenCalled();
  });

  it("显式 focus:false 时保留编辑器焦点", async () => {
    await completeInsert({ ...selection, focus: false });
    expect(fake.window.focus).not.toHaveBeenCalled();
    expect(fake.window.show).not.toHaveBeenCalled();
  });

  it("rejects a selection without a line range before touching the renderer", async () => {
    const status = server.getStatus();
    const response = await post(status.port, token, { ...selection, endLine: undefined });
    expect(response.status).toBe(400);
    expect(fake.sent).toHaveLength(0);
  });
});
