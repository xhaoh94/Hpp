import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type NasServer = {
  listen: (port: number, host: string, callback: () => void) => void;
  address: () => { port: number } | null;
  close: (callback: () => void) => void;
};

type ServerFactory = (options: Record<string, unknown>) => NasServer;

const TOKEN = "nas-test-token-abcdef0123456789";

let createChannelSyncServer: ServerFactory;
let server: NasServer;
let baseUrl = "";
let dataDir = "";

function payload(providerId = "p1") {
  return {
    type: "hpp-agent-config-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    includeApiKeys: true,
    agents: {
      pi: {
        activeProviderId: providerId,
        providers: [
          {
            providerId,
            displayName: "渠道",
            baseUrl: "https://api.example.com/v1",
            apiKey: "sk-1",
            authMode: "bearer",
            endpoint: "chat-completions",
            models: [],
          },
        ],
      },
    },
  };
}

const authHeaders = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function boot(options: Record<string, unknown> = {}) {
  dataDir = await mkdtemp(join(tmpdir(), "hpp-nas-protocol-"));
  server = createChannelSyncServer({ dataDir, token: TOKEN, historyLimit: 3, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address) throw new Error("测试服务没有拿到端口");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  const mod = (await import("../../docker/channel-sync/server.mjs")) as {
    createChannelSyncServer: ServerFactory;
  };
  createChannelSyncServer = mod.createChannelSyncServer;
  await boot();
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("Hpp 同步服务（NAS 端）", () => {
  it("没有 Token 时拒绝启动", async () => {
    expect(() => createChannelSyncServer({ dataDir })).toThrow(/HPP_SYNC_TOKEN/);
  });

  it("/health 不需要鉴权，只暴露 revision", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, service: "hpp-channel-sync", revision: 0 });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("配置接口缺少 Token 时返回 401", async () => {
    const response = await fetch(`${baseUrl}/snapshot`);
    expect(response.status).toBe(401);
  });

  it("Token 错误时返回 401", async () => {
    const response = await fetch(`${baseUrl}/snapshot`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(response.status).toBe(401);
  });

  it("还没有备份时返回 404", async () => {
    const response = await fetch(`${baseUrl}/snapshot`, { headers: authHeaders });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("empty");
  });

  it("拒绝非 Hpp 配置包", async () => {
    const response = await fetch(`${baseUrl}/snapshot`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ type: "other", version: 1, agents: {} }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_payload");
  });

  it("拒绝非法 JSON", async () => {
    const response = await fetch(`${baseUrl}/snapshot`, {
      method: "PUT",
      headers: authHeaders,
      body: "{oops",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_json");
  });

  it("上传后 revision 递增并能取回", async () => {
    const first = await fetch(`${baseUrl}/snapshot`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify(payload("p1")),
    });
    expect(first.status).toBe(200);
    expect((await first.json()).revision).toBe(1);

    const second = await fetch(`${baseUrl}/snapshot`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify(payload("p2")),
    });
    expect((await second.json()).revision).toBe(2);

    const latest = await fetch(`${baseUrl}/snapshot`, { headers: authHeaders });
    const body = await latest.json();
    expect(body.revision).toBe(2);
    expect(body.payload.agents.pi.activeProviderId).toBe("p2");
  });

  it("并发上传不会得到重复 revision", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_item, index) =>
        fetch(`${baseUrl}/snapshot`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify(payload(`p${index}`)),
        }).then((response) => response.json()),
      ),
    );
    const revisions = results.map((item) => item.revision).sort((left, right) => left - right);
    expect(revisions).toEqual([1, 2, 3, 4, 5]);
  });

  it("历史快照可列出并单独读取", async () => {
    for (const id of ["p1", "p2"]) {
      await fetch(`${baseUrl}/snapshot`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify(payload(id)),
      });
    }

    const list = await (await fetch(`${baseUrl}/snapshots`, { headers: authHeaders })).json();
    expect(list.currentRevision).toBe(2);
    expect(list.snapshots.map((item: { revision: number }) => item.revision)).toEqual([2, 1]);

    const old = await (await fetch(`${baseUrl}/snapshot/1`, { headers: authHeaders })).json();
    expect(old.revision).toBe(1);
    expect(old.payload.agents.pi.activeProviderId).toBe("p1");
  });

  it("历史份数超过上限时裁掉最旧的", async () => {
    for (let index = 0; index < 5; index += 1) {
      await fetch(`${baseUrl}/snapshot`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify(payload(`p${index}`)),
      });
    }
    const files = (await readdir(join(dataDir, "history"))).filter((name) => name.endsWith(".json")).sort();
    expect(files).toEqual(["000003.json", "000004.json", "000005.json"]);
  });

  it("超过大小上限时返回 413", async () => {
    const extraDir = await mkdtemp(join(tmpdir(), "hpp-nas-small-"));
    const sized = createChannelSyncServer({ dataDir: extraDir, token: TOKEN, maxBytes: 64 });
    await new Promise<void>((resolve) => sized.listen(0, "127.0.0.1", resolve));
    const port = sized.address()?.port;
    expect(port).toBeTruthy();
    const response = await fetch(`http://127.0.0.1:${port}/snapshot`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify(payload()),
    });
    expect(response.status).toBe(413);
    await new Promise<void>((resolve) => sized.close(() => resolve()));
    await rm(extraDir, { recursive: true, force: true }).catch(() => undefined);
  });
});
