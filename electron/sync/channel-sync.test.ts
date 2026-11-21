import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  userDataDir: "",
  encryptionAvailable: true,
  backend: "gnome_libsecret",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => testState.userDataDir,
    getAppPath: () => process.cwd(),
  },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => testState.encryptionAvailable,
    getSelectedStorageBackend: () => testState.backend,
    // 测试用可逆编码代替 DPAPI，验证的是「落盘不是明文」而不是加密算法。
    encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buffer: Buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
  },
}));

import {
  adoptChannelSyncTargetById,
  backupChannelConfigs,
  checkChannelSyncTargetById,
  clearChannelSyncTargetFingerprint,
  deployChannelSyncTargetById,
  getChannelSyncSecretStorageStatus,
  getChannelSyncStatus,
  listChannelSyncTargets,
  probeChannelSyncTargetById,
  pullChannelConfigs,
  removeChannelSyncTarget,
  saveChannelSyncTarget,
  undeployChannelSyncTargetById,
  setActiveChannelSyncTarget,
} from "./channel-sync";
import { closeFakeServers, defaultExecHandler, startFakeHealthServer, startFakeNas } from "./test-support/fake-nas";

type FakeSyncServer = {
  listen: (port: number, host: string, callback: () => void) => void;
  address: () => { port: number } | null;
  close: (callback: () => void) => void;
};

let createChannelSyncServer: (options: Record<string, unknown>) => FakeSyncServer;

beforeAll(async () => {
  // 服务端是零依赖 .mjs，没有类型声明，测试里按行为约定断言。
  const mod = (await import("../../docker/channel-sync/server.mjs")) as {
    createChannelSyncServer: typeof createChannelSyncServer;
  };
  createChannelSyncServer = mod.createChannelSyncServer;
});

const enc = (value: string) => Buffer.from(`enc:${value}`, "utf8").toString("base64");
const TOKEN = "a".repeat(64);

const storePath = () => join(testState.userDataDir, "hpp-data", "channel-sync.json");

async function readStore(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(storePath(), "utf8"));
}

function samplePayload(providerId = "provider-1") {
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
            displayName: "测试渠道",
            baseUrl: "https://api.example.com/v1",
            apiKey: "sk-test",
            authMode: "bearer",
            endpoint: "chat-completions",
            models: [],
          },
        ],
      },
    },
  };
}

async function seedTarget(host: string, port: number, token = TOKEN) {
  await mkdir(join(testState.userDataDir, "hpp-data"), { recursive: true });
  await writeFile(
    storePath(),
    JSON.stringify({
      version: 2,
      activeTargetId: "t1",
      targets: [
        {
          id: "t1",
          name: "测试 NAS",
          host,
          sshPort: 22,
          sshUser: "root",
          servicePort: port,
          deployPath: "/opt/hpp-channel-sync",
          image: "node:22-alpine",
          encryptedToken: token ? enc(token) : undefined,
        },
      ],
      state: {},
    }),
    "utf8",
  );
}

beforeEach(async () => {
  testState.userDataDir = await mkdtemp(join(tmpdir(), "hpp-sync-"));
  testState.encryptionAvailable = true;
  testState.backend = "gnome_libsecret";
});

afterEach(async () => {
  await closeFakeServers();
  await rm(testState.userDataDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("目标管理", () => {
  it("空配置时没有目标，也没有服务地址", async () => {
    expect(await listChannelSyncTargets()).toEqual([]);
    const status = await getChannelSyncStatus();
    expect(status.configured).toBe(false);
    expect(status.baseUrl).toBe("");
  });

  it("保存目标后自动成为当前目标", async () => {
    const result = await saveChannelSyncTarget({
      host: "192.168.10.85",
      sshUser: "admin",
      password: "secret",
      servicePort: 8787,
    });

    expect(result.success).toBe(true);
    expect(result.target?.isActive).toBe(true);
    expect(result.target?.name).toBe("192.168.10.85");
    expect(result.target?.serviceUrl).toBe("http://192.168.10.85:8787");
    expect(result.target?.hasPassword).toBe(true);

    const list = await listChannelSyncTargets();
    expect(list).toHaveLength(1);
  });

  it("显式要求只用系统安全存储时，不可用就拒绝保存密码", async () => {
    testState.encryptionAvailable = false;
    expect(await getChannelSyncSecretStorageStatus()).toEqual({
      available: false,
      backend: "gnome_libsecret",
    });

    const result = await saveChannelSyncTarget({
      host: "192.168.10.85",
      sshUser: "admin",
      password: "secret",
      passwordStorage: "system",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("系统安全存储不可用");
    expect(result.error).toContain("gnome-keyring");
    // 失败时不能留下半截目标：界面仍能正常读取空列表。
    expect(await listChannelSyncTargets()).toEqual([]);
  });

  it("安全存储不可用时仍可保存不含密码的目标（部署时临时填密码）", async () => {
    testState.encryptionAvailable = false;
    const result = await saveChannelSyncTarget({ host: "nas.local", sshUser: "root" });
    expect(result.success).toBe(true);
    expect(result.target?.hasPassword).toBe(false);
  });

  it("安全存储不可用时密码与 Token 默认用本地密钥保存", async () => {
    testState.encryptionAvailable = false;
    const created = await saveChannelSyncTarget({
      host: "10.0.0.1",
      sshUser: "root",
      password: "local-secret-password",
      token: TOKEN,
    });
    expect(created.success).toBe(true);
    expect(created.target?.hasPassword).toBe(true);
    expect(created.target?.tokenPreview).toBeDefined();

    const raw = await readStore();
    const target = (raw.targets as Array<Record<string, unknown>>)[0];
    expect(String(target.encryptedPassword)).toContain("hpp-local:v1:");
    expect(String(target.encryptedToken)).toContain("hpp-local:v1:");
    expect(JSON.stringify(raw)).not.toContain("local-secret-password");
    expect(JSON.stringify(raw)).not.toContain(TOKEN);

    // 密钥文件在 hpp-data 下，后续读取（包括重启后）能正常解密。
    const status = await getChannelSyncStatus();
    expect(status.configured).toBe(true);
    expect(status.tokenSet).toBe(true);
  });

  it("非法输入被拒绝", async () => {
    expect((await saveChannelSyncTarget({ host: "http://nas", sshUser: "root" })).success).toBe(false);
    expect((await saveChannelSyncTarget({ host: "nas", sshUser: "root", servicePort: 0 })).success).toBe(false);
    expect(
      (await saveChannelSyncTarget({ host: "nas", sshUser: "root", deployPath: "relative/path" })).success,
    ).toBe(false);
  });

  it("密码不落明文", async () => {
    await saveChannelSyncTarget({
      host: "192.168.10.85",
      sshUser: "admin",
      password: "super-secret",
    });
    const raw = await readFile(storePath(), "utf8");
    expect(raw).not.toContain("super-secret");
    expect(raw).toContain("encryptedPassword");
  });

  it("可以手动填写服务 Token（手动部署过的场景）", async () => {
    const created = await saveChannelSyncTarget({
      host: "10.0.0.1",
      sshUser: "root",
      token: TOKEN,
    });
    expect(created.success).toBe(true);

    const status = await getChannelSyncStatus();
    expect(status.configured).toBe(true);
    expect(status.tokenSet).toBe(true);
    expect(status.tokenPreview).not.toContain(TOKEN);

    const raw = await readFile(storePath(), "utf8");
    expect(raw).not.toContain(TOKEN);
  });

  it("留空 Token 沿用旧值，空字符串清除", async () => {
    const created = await saveChannelSyncTarget({
      host: "10.0.0.1",
      sshUser: "root",
      token: TOKEN,
    });
    const id = created.target!.id;

    await saveChannelSyncTarget({ id, host: "10.0.0.1", sshUser: "root" });
    expect((await getChannelSyncStatus()).tokenSet).toBe(true);

    await saveChannelSyncTarget({ id, host: "10.0.0.1", sshUser: "root", token: "" });
    expect((await getChannelSyncStatus()).tokenSet).toBe(false);
  });

  it("改地址但显式提供新 Token 时保留新值", async () => {
    const created = await saveChannelSyncTarget({
      host: "10.0.0.1",
      sshUser: "root",
      token: TOKEN,
    });
    await saveChannelSyncTarget({
      id: created.target!.id,
      host: "10.0.0.2",
      sshUser: "root",
      token: "b".repeat(64),
    });
    const status = await getChannelSyncStatus();
    expect(status.configured).toBe(true);
    expect(status.baseUrl).toContain("10.0.0.2");
  });

  it("更新时留空密码会沿用原值", async () => {
    const created = await saveChannelSyncTarget({
      host: "192.168.10.85",
      sshUser: "admin",
      password: "secret",
    });
    const id = created.target!.id;

    await saveChannelSyncTarget({ id, host: "192.168.10.85", sshUser: "admin" });
    const list = await listChannelSyncTargets();
    expect(list[0].hasPassword).toBe(true);
  });

  it("换地址会清掉旧指纹和旧 Token", async () => {
    await mkdir(join(testState.userDataDir, "hpp-data"), { recursive: true });
    await writeFile(
      storePath(),
      JSON.stringify({
        version: 2,
        activeTargetId: "t1",
        targets: [
          {
            id: "t1",
            name: "旧 NAS",
            host: "10.0.0.1",
            sshPort: 22,
            sshUser: "root",
            servicePort: 8787,
            deployPath: "/data/hpp",
            image: "node:22-alpine",
            hostFingerprint: "SHA256:old",
            encryptedToken: enc(TOKEN),
          },
        ],
        state: {},
      }),
    );

    await saveChannelSyncTarget({ id: "t1", host: "10.0.0.2", sshUser: "root" });
    const store = await readStore();
    const target = (store.targets as Array<Record<string, unknown>>)[0];
    expect(target.hostFingerprint).toBeUndefined();
    expect(target.encryptedToken).toBeUndefined();
  });

  it("切换和删除当前目标", async () => {
    const first = await saveChannelSyncTarget({ host: "10.0.0.1", sshUser: "root" });
    const second = await saveChannelSyncTarget({ host: "10.0.0.2", sshUser: "root" });

    await setActiveChannelSyncTarget(second.target!.id);
    let list = await listChannelSyncTargets();
    expect(list.find((item) => item.id === second.target!.id)?.isActive).toBe(true);

    await removeChannelSyncTarget(second.target!.id);
    list = await listChannelSyncTargets();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(first.target!.id);
    expect(list[0].isActive).toBe(true);
  });

  it("清除指纹", async () => {
    const created = await saveChannelSyncTarget({ host: "10.0.0.1", sshUser: "root" });
    await mkdir(join(testState.userDataDir, "hpp-data"), { recursive: true });
    const store = await readStore();
    (store.targets as Array<Record<string, unknown>>)[0].hostFingerprint = "SHA256:x";
    await writeFile(storePath(), JSON.stringify(store));

    await clearChannelSyncTargetFingerprint(created.target!.id);
    const list = await listChannelSyncTargets();
    expect(list[0].hostFingerprint).toBeUndefined();
  });
});

describe("旧版配置迁移", () => {
  it("单目标配置自动变成 targets[0]", async () => {
    await mkdir(join(testState.userDataDir, "hpp-data"), { recursive: true });
    await writeFile(
      storePath(),
      JSON.stringify({
        config: { baseUrl: "http://192.168.10.85:8787", token: TOKEN },
        state: { lastBackupAt: "2026-01-01T00:00:00.000Z", lastBackupRevision: 4 },
      }),
    );

    const list = await listChannelSyncTargets();
    expect(list).toHaveLength(1);
    expect(list[0].host).toBe("192.168.10.85");
    expect(list[0].servicePort).toBe(8787);
    expect(list[0].isActive).toBe(true);

    const status = await getChannelSyncStatus();
    expect(status.configured).toBe(true);
    expect(status.lastBackupRevision).toBe(4);
  });
});

describe("备份与拉取", () => {
  it("没有目标时提示先添加", async () => {
    const result = await backupChannelConfigs(samplePayload());
    expect(result.success).toBe(false);
    expect(result.error).toContain("渠道配置服务器");
  });

  it("没有 Token 时提示先部署", async () => {
    await seedTarget("127.0.0.1", 8787, "");
    const result = await backupChannelConfigs(samplePayload());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Token");
  });

  it("备份递增 revision，拉取能取回数据", async () => {
    const server = createChannelSyncServer({
      dataDir: await mkdtemp(join(tmpdir(), "hpp-nas-")),
      token: TOKEN,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address()!.port;
    try {
      await seedTarget("127.0.0.1", port);

      const first = await backupChannelConfigs(samplePayload());
      expect(first.success).toBe(true);
      expect(first.revision).toBe(1);

      const status = await getChannelSyncStatus();
      expect(status.lastBackupRevision).toBe(1);

      const pulled = await pullChannelConfigs();
      expect(pulled.success).toBe(true);
      expect(pulled.data?.agents.pi.providers[0].apiKey).toBe("sk-test");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("NAS 上没有备份时拉取给出提示", async () => {
    const server = createChannelSyncServer({
      dataDir: await mkdtemp(join(tmpdir(), "hpp-nas-")),
      token: TOKEN,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address()!.port;
    try {
      await seedTarget("127.0.0.1", port);
      const result = await pullChannelConfigs();
      expect(result.success).toBe(false);
      expect(result.error).toContain("还没有备份");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function undeployExecHandler(commands: string[]) {
  return (command: string) => {
    commands.push(command);
    if (command.trim() === "id -u") return { stdout: "1002", code: 0 };
    if (command.includes("docker inspect")) return { stdout: "yes", code: 0 };
    if (command.includes("docker rm")) return { stdout: "hpp-channel-sync", code: 0 };
    return { stdout: "", code: 0 };
  };
}

describe("卸载远端部署", () => {
  it("默认只删容器，保留 data 目录并清掉 Token", async () => {
    const commands: string[] = [];
    const nas = await startFakeNas({ exec: undeployExecHandler(commands) });
    const created = await saveChannelSyncTarget({
      host: "127.0.0.1",
      sshPort: nas.port,
      sshUser: "tester",
      password: "secret",
      servicePort: 18787,
      token: TOKEN,
    });

    const result = await undeployChannelSyncTargetById(created.target!.id);
    expect(result.success).toBe(true);
    expect(commands.some((command) => command.includes("docker rm -f"))).toBe(true);
    expect(commands.some((command) => command.includes("rm -rf"))).toBe(false);

    const status = await getChannelSyncStatus();
    expect(status.tokenSet).toBe(false);
    const list = await listChannelSyncTargets();
    expect(list[0].lastStatus).toBe("not_deployed");
  });

  it("选择删除数据时才移除部署目录", async () => {
    const commands: string[] = [];
    const nas = await startFakeNas({ exec: undeployExecHandler(commands) });
    const created = await saveChannelSyncTarget({
      host: "127.0.0.1",
      sshPort: nas.port,
      sshUser: "tester",
      password: "secret",
      servicePort: 18787,
      token: TOKEN,
    });

    const result = await undeployChannelSyncTargetById(created.target!.id, { removeData: true });
    expect(result.success).toBe(true);
    expect(commands.some((command) => command.includes("rm -rf"))).toBe(true);
  });

  it("没有密码时拒绝卸载", async () => {
    const created = await saveChannelSyncTarget({
      host: "127.0.0.1",
      sshPort: 2222,
      sshUser: "tester",
      servicePort: 18787,
    });
    const result = await undeployChannelSyncTargetById(created.target!.id);
    expect(result.success).toBe(false);
    expect(result.error).toContain("SSH 密码");
  });
});

describe("备份状态按目标隔离", () => {
  it("切换目标后不会显示另一个目标的备份版本", async () => {
    const nasA = createChannelSyncServer({
      dataDir: await mkdtemp(join(tmpdir(), "hpp-nas-a-")),
      token: TOKEN,
    });
    await new Promise<void>((resolve) => nasA.listen(0, "127.0.0.1", resolve));
    const portA = nasA.address()!.port;

    const nasB = createChannelSyncServer({
      dataDir: await mkdtemp(join(tmpdir(), "hpp-nas-b-")),
      token: TOKEN,
    });
    await new Promise<void>((resolve) => nasB.listen(0, "127.0.0.1", resolve));
    const portB = nasB.address()!.port;

    try {
      await mkdir(join(testState.userDataDir, "hpp-data"), { recursive: true });
      await writeFile(
        storePath(),
        JSON.stringify({
          version: 2,
          activeTargetId: "a",
          targets: [
            {
              id: "a",
              name: "服务器 A",
              host: "127.0.0.1",
              sshPort: 22,
              sshUser: "root",
              servicePort: portA,
              deployPath: "/data/hpp",
              image: "node:22-alpine",
              encryptedToken: enc(TOKEN),
            },
            {
              id: "b",
              name: "服务器 B",
              host: "127.0.0.1",
              sshPort: 22,
              sshUser: "root",
              servicePort: portB,
              deployPath: "/data/hpp",
              image: "node:22-alpine",
              encryptedToken: enc(TOKEN),
            },
          ],
          state: {},
        }),
      );

      // 在 A 上备份，A 应该有第 1 版
      const backedUp = await backupChannelConfigs(samplePayload());
      expect(backedUp.success).toBe(true);
      const statusA = await getChannelSyncStatus();
      expect(statusA.lastBackupRevision).toBe(1);
      expect(statusA.baseUrl).toContain(String(portA));

      // 切到 B：B 是空服务器，不能显示 A 的备份记录
      await setActiveChannelSyncTarget("b");
      const statusB = await getChannelSyncStatus();
      expect(statusB.baseUrl).toContain(String(portB));
      expect(statusB.lastBackupRevision).toBeUndefined();
      expect(statusB.lastBackupAt).toBeUndefined();

      // 回到 A，记录还在
      await setActiveChannelSyncTarget("a");
      expect((await getChannelSyncStatus()).lastBackupRevision).toBe(1);
    } finally {
      await new Promise<void>((resolve) => nasA.close(() => resolve()));
      await new Promise<void>((resolve) => nasB.close(() => resolve()));
    }
  });

  it("服务器上没有备份时，即使本地留过记录也不显示版本", async () => {
    const nas = createChannelSyncServer({
      dataDir: await mkdtemp(join(tmpdir(), "hpp-nas-empty-")),
      token: TOKEN,
    });
    await new Promise<void>((resolve) => nas.listen(0, "127.0.0.1", resolve));
    const port = nas.address()!.port;
    try {
      await mkdir(join(testState.userDataDir, "hpp-data"), { recursive: true });
      await writeFile(
        storePath(),
        JSON.stringify({
          version: 2,
          activeTargetId: "t1",
          targets: [
            {
              id: "t1",
              name: "新服务器",
              host: "127.0.0.1",
              sshPort: 22,
              sshUser: "root",
              servicePort: port,
              deployPath: "/data/hpp",
              image: "node:22-alpine",
              encryptedToken: enc(TOKEN),
              // 本地残留的记录（例如从别的目标迁移过来）不能被当成事实
              lastBackupAt: "2026-01-01T00:00:00.000Z",
              lastBackupRevision: 7,
            },
          ],
          state: {},
        }),
      );

      const status = await getChannelSyncStatus();
      expect(status.configured).toBe(true);
      expect(status.lastBackupRevision).toBeUndefined();
      expect(status.lastBackupAt).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => nas.close(() => resolve()));
    }
  });

  it("视图里每个目标带自己的备份版本", async () => {
    const created = await saveChannelSyncTarget({
      host: "10.0.0.1",
      sshUser: "root",
      token: TOKEN,
    });
    const targets = await listChannelSyncTargets();
    expect(targets[0].id).toBe(created.target!.id);
    expect(targets[0].lastBackupRevision).toBeUndefined();
  });
});

describe("探测与部署", () => {
  it("探测记录首次指纹和容器状态", async () => {
    const nas = await startFakeNas({ exec: defaultExecHandler() });
    const created = await saveChannelSyncTarget({
      host: "127.0.0.1",
      sshPort: nas.port,
      sshUser: "tester",
      password: "secret",
      servicePort: 18787,
    });

    const probe = await probeChannelSyncTargetById(created.target!.id);
    expect(probe.success).toBe(true);
    expect(probe.dockerVersion).toContain("Docker");
    expect(probe.containerStatus).toBe("not_deployed");

    const list = await listChannelSyncTargets();
    expect(list[0].hostFingerprint).toBe(probe.hostFingerprint);
  });

  it("没有保存密码时探测要求输入", async () => {
    const created = await saveChannelSyncTarget({
      host: "127.0.0.1",
      sshPort: 2222,
      sshUser: "tester",
      servicePort: 18787,
    });
    const probe = await probeChannelSyncTargetById(created.target!.id);
    expect(probe.success).toBe(false);
    expect(probe.error).toContain("SSH 密码");
  });

  it("部署成功后保存 Token、指纹和运行状态", async () => {
    const nas = await startFakeNas({ exec: defaultExecHandler() });
    const serviceUrl = await startFakeHealthServer(200);
    const servicePort = Number(new URL(serviceUrl).port);

    const created = await saveChannelSyncTarget({
      host: "127.0.0.1",
      sshPort: nas.port,
      sshUser: "tester",
      password: "secret",
      servicePort,
      deployPath: "/opt/hpp-channel-sync",
    });

    const events: string[] = [];
    const result = await deployChannelSyncTargetById(created.target!.id, undefined, (event) =>
      events.push(event.phase),
    );

    expect(result.success).toBe(true);
    expect(result.target?.lastStatus).toBe("running");
    expect(result.target?.hostFingerprint?.startsWith("SHA256:")).toBe(true);
    expect(nas.files.get("/opt/hpp-channel-sync/.env")).toContain("HPP_SYNC_TOKEN=");
    expect(events).toContain("done");

    const status = await getChannelSyncStatus();
    expect(status.configured).toBe(true);
    expect(status.tokenSet).toBe(true);
    expect(status.tokenPreview).not.toContain(TOKEN);
  });

  it("换机后可以直接接管已有部署，不重新部署", async () => {
    const base = defaultExecHandler({ container: "running", deploy_path_exists: "yes" });
    const nas = await startFakeNas({
      exec: (command) =>
        command.includes(".env")
          ? { stdout: `HPP_SYNC_TOKEN=${TOKEN}\nHPP_SYNC_HISTORY_LIMIT=20\n`, code: 0 }
          : base(command),
    });
    const serviceUrl = await startFakeHealthServer(200);
    const servicePort = Number(new URL(serviceUrl).port);

    // 模拟换机：本地只有连接信息，没有 Token。
    const created = await saveChannelSyncTarget({
      host: "127.0.0.1",
      sshPort: nas.port,
      sshUser: "tester",
      password: "secret",
      servicePort,
      deployPath: "/opt/hpp-channel-sync",
    });
    expect(created.target?.tokenPreview).toBeUndefined();
    expect((await getChannelSyncStatus()).tokenSet).toBe(false);

    const adopted = await adoptChannelSyncTargetById(created.target!.id);
    expect(adopted.success).toBe(true);
    expect(adopted.target?.tokenPreview).toBeDefined();
    expect(adopted.target?.lastStatus).toBe("running");

    const status = await getChannelSyncStatus();
    expect(status.configured).toBe(true);
    expect(status.tokenSet).toBe(true);
    expect(status.tokenPreview).not.toContain(TOKEN);
    // 没有触发部署：远端只有读 .env 的命令。
    expect(nas.files.size).toBe(0);
  });

  it("点部署时发现已有部署会自动接管，不重新部署", async () => {
    const base = defaultExecHandler({ container: "running", deploy_path_exists: "yes" });
    const nas = await startFakeNas({
      exec: (command) =>
        command.includes(".env")
          ? { stdout: `HPP_SYNC_TOKEN=${TOKEN}\nHPP_SYNC_HISTORY_LIMIT=20\n`, code: 0 }
          : base(command),
    });
    const serviceUrl = await startFakeHealthServer(200);
    const servicePort = Number(new URL(serviceUrl).port);

    const created = await saveChannelSyncTarget({
      host: "127.0.0.1",
      sshPort: nas.port,
      sshUser: "tester",
      password: "secret",
      servicePort,
      deployPath: "/opt/hpp-channel-sync",
    });

    const result = await deployChannelSyncTargetById(created.target!.id);
    expect(result.success).toBe(true);
    expect(result.adopted).toBe(true);
    expect(nas.files.size).toBe(0);
    expect((await getChannelSyncStatus()).tokenSet).toBe(true);
  });

  it("服务器已有容器但读不到 Token 时停下来，不覆盖部署", async () => {
    const base = defaultExecHandler({ container: "running", deploy_path_exists: "yes" });
    const nas = await startFakeNas({
      exec: (command) =>
        command.includes(".env")
          ? { stdout: "", stderr: "missing", code: 1 }
          : base(command),
    });

    const created = await saveChannelSyncTarget({
      host: "127.0.0.1",
      sshPort: nas.port,
      sshUser: "tester",
      password: "secret",
      servicePort: 18787,
      deployPath: "/opt/hpp-channel-sync",
    });

    const result = await deployChannelSyncTargetById(created.target!.id);
    expect(result.success).toBe(false);
    expect(result.error).toContain(".env");
    expect(nas.files.size).toBe(0);
  });

  it("部署失败时保留原来的 Token", async () => {
    await seedTarget("127.0.0.1", 18787);
    const nas = await startFakeNas({ exec: defaultExecHandler({ docker_bin: "none" }) });

    await saveChannelSyncTarget({
      id: "t1",
      host: "127.0.0.1",
      sshPort: nas.port,
      sshUser: "tester",
      password: "secret",
      servicePort: 18787,
    });

    const result = await deployChannelSyncTargetById("t1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("docker");

    const status = await getChannelSyncStatus();
    expect(status.tokenSet).toBe(true);
  });

  it("能读到随应用分发的服务源码", async () => {
    const { readNasServerSource } = await import("./nas-deploy");
    const source = await readNasServerSource();
    expect(source).toContain("hpp-channel-sync");
    expect(source).toContain("createChannelSyncServer");
  });

  it("部署成功后把当前目标切到该目标", async () => {
    const nas = await startFakeNas({ exec: defaultExecHandler() });
    const serviceUrl = await startFakeHealthServer(200);
    const servicePort = Number(new URL(serviceUrl).port);

    const first = await saveChannelSyncTarget({ host: "10.0.0.9", sshUser: "root" });
    const second = await saveChannelSyncTarget({
      host: "127.0.0.1",
      sshPort: nas.port,
      sshUser: "tester",
      password: "secret",
      servicePort,
      deployPath: "/opt/hpp-channel-sync",
    });

    const result = await deployChannelSyncTargetById(second.target!.id);
    expect(result.success).toBe(true);

    const list = await listChannelSyncTargets();
    expect(list.find((item) => item.id === second.target!.id)?.isActive).toBe(true);
    expect(list.find((item) => item.id === first.target!.id)?.isActive).toBe(false);
  });

  it("检查状态优先走 HTTP", async () => {
    const serviceUrl = await startFakeHealthServer(200);
    const servicePort = Number(new URL(serviceUrl).port);
    await seedTarget("127.0.0.1", servicePort);

    const result = await checkChannelSyncTargetById("t1");
    expect(result.success).toBe(true);
    expect(result.status).toBe("running");
    expect(result.serviceOk).toBe(true);
  });
});
