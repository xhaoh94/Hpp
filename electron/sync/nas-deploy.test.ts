import { createServer } from "net";
import { AddressInfo } from "net";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectSsh,
  deployChannelSyncService,
  describeSshError,
  formatSshFingerprint,
  parseProbeOutput,
  shellQuote,
} from "./nas-deploy";
import {
  closeFakeServers,
  defaultExecHandler,
  probeOutput,
  startFakeHealthServer,
  startFakeNas,
} from "./test-support/fake-nas";

afterEach(async () => {
  await closeFakeServers();
});

const credential = (port: number, password = "secret") => ({
  host: "127.0.0.1",
  port,
  username: "tester",
  password,
});

describe("SSH 连接", () => {
  it("密码正确时建立连接并返回 OpenSSH 风格指纹", async () => {
    const server = await startFakeNas();
    const connected = await connectSsh(credential(server.port));
    expect(connected.fingerprint.startsWith("SHA256:")).toBe(true);
    expect(connected.fingerprint).not.toContain("=");
    connected.session.close();
  });

  it("密码错误时给出可操作的提示", async () => {
    const server = await startFakeNas();
    await expect(connectSsh(credential(server.port, "wrong"))).rejects.toThrow(/用户名或密码/);
  });

  it("指纹不一致时拒绝连接", async () => {
    const server = await startFakeNas();
    await expect(
      connectSsh(credential(server.port), { expectedFingerprint: "SHA256:not-the-same" }),
    ).rejects.toThrow(/指纹/);
  });

  it("指纹一致时正常连接", async () => {
    const server = await startFakeNas();
    const first = await connectSsh(credential(server.port));
    const fingerprint = first.fingerprint;
    first.session.close();

    const second = await connectSsh(credential(server.port), { expectedFingerprint: fingerprint });
    expect(second.fingerprint).toBe(fingerprint);
    second.session.close();
  });

  it("执行命令能拿到 stdout 和退出码", async () => {
    const server = await startFakeNas({
      exec: (command) =>
        command.includes("boom")
          ? { stdout: "failed\n", stderr: "boom\n", code: 2 }
          : { stdout: "hello\n", code: 0 },
    });
    const connected = await connectSsh(credential(server.port));
    const ok = await connected.session.exec("echo hi");
    expect(ok).toMatchObject({ code: 0, stdout: "hello\n" });

    const failed = await connected.session.exec("run boom");
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain("boom");
    connected.session.close();
  });

  it("上传文件到远端", async () => {
    const written: Array<[string, string]> = [];
    const server = await startFakeNas({ onFile: (path, content) => written.push([path, content]) });
    const connected = await connectSsh(credential(server.port));
    await connected.session.writeFile("/tmp/example.txt", "hello nas", 0o644);
    connected.session.close();

    expect(written).toContainEqual(["/tmp/example.txt", "hello nas"]);
  });
});

describe("握手异常不能崩主进程", () => {
  it("对端接收连接后立刻断开时，返回友好错误而不是未捕获异常", async () => {
    // 模拟「端口转发指向不存在的主机」：TCP 能建立但立刻被断开。
    const sockets: import("net").Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    // 具体文案取决于对端怎么断（RST 或 FIN），两者都要是中文可读提示。
    await expect(connectSsh(credential(port))).rejects.toThrow(/重置|握手|中断|断开/);

    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("错误文案覆盖握手中断与连接重置", () => {
    expect(describeSshError(new Error("Connection lost before handshake"))).toContain("握手阶段");
    expect(describeSshError(new Error("read ECONNRESET"))).toContain("重置");
  });
});

describe("协议工具", () => {
  it("解析探测输出里的 key=value", () => {
    const parsed = parseProbeOutput(
      ["docker_bin=/usr/bin/docker", "uid=1002", "gid=1001", "noise line", "=bad"].join("\n"),
    );
    expect(parsed).toEqual({ docker_bin: "/usr/bin/docker", uid: "1002", gid: "1001" });
  });

  it("shellQuote 转义单引号", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("指纹格式与 ssh-keygen 一致", () => {
    const fingerprint = formatSshFingerprint(Buffer.from("key"));
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });

  it("错误映射覆盖常见网络问题", () => {
    expect(describeSshError(new Error("connect ECONNREFUSED"))).toContain("不可达");
    expect(describeSshError(new Error("getaddrinfo ENOTFOUND nas"))).toContain("解析失败");
    expect(describeSshError(new Error("Timed out while waiting for handshake"))).toContain("超时");
  });
});

describe("部署流程", () => {
  it("成功部署：准备目录、上传文件、启动容器并验证健康", async () => {
    const events: string[] = [];
    const uploaded: string[] = [];
    const server = await startFakeNas({
      exec: defaultExecHandler(),
      onFile: (path) => uploaded.push(path),
    });
    const serviceUrl = await startFakeHealthServer(200);

    const outcome = await deployChannelSyncService({
      credential: credential(server.port),
      servicePort: 8787,
      deployPath: "/opt/hpp-channel-sync",
      image: "node:22-alpine",
      token: "a".repeat(64),
      serverSource: "console.log('server')",
      serviceUrl,
      onEvent: (event) => events.push(`${event.phase}:${event.message}`),
    });

    expect(outcome.success).toBe(true);
    expect(outcome.fingerprint?.startsWith("SHA256:")).toBe(true);
    expect(uploaded).toContain("/opt/hpp-channel-sync/server.mjs");
    expect(uploaded).toContain("/opt/hpp-channel-sync/.env");
    expect(server.files.get("/opt/hpp-channel-sync/.env")).toContain("HPP_SYNC_TOKEN=");
    expect(events.some((item) => item.startsWith("done:"))).toBe(true);
  });

  it("没有 docker 时在探测阶段就停下", async () => {
    const server = await startFakeNas({
      exec: defaultExecHandler({ docker_bin: "none" }),
    });
    const serviceUrl = await startFakeHealthServer(200);

    const outcome = await deployChannelSyncService({
      credential: credential(server.port),
      servicePort: 8787,
      deployPath: "/opt/hpp-channel-sync",
      image: "node:22-alpine",
      token: "b".repeat(64),
      serverSource: "x",
      serviceUrl,
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("docker");
  });

  it("sudo 不可用时提示账号权限问题", async () => {
    const server = await startFakeNas({
      exec: (command) => {
        if (command.includes('echo "docker_bin=')) return { stdout: probeOutput(), code: 0 };
        if (command.includes('echo "docker_info=')) {
          return { stdout: probeOutput({ docker_info: "none" }), code: 0 };
        }
        return { stdout: "", code: 0 };
      },
    });
    const serviceUrl = await startFakeHealthServer(200);

    const outcome = await deployChannelSyncService({
      credential: credential(server.port),
      servicePort: 8787,
      deployPath: "/opt/hpp-channel-sync",
      image: "node:22-alpine",
      token: "c".repeat(64),
      serverSource: "x",
      serviceUrl,
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("sudo");
  });

  it("镜像不存在时先拉取", async () => {
    const commands: string[] = [];
    const server = await startFakeNas({
      exec: (command) => {
        commands.push(command);
        return defaultExecHandler({ image_exists: "none" })(command);
      },
    });
    const serviceUrl = await startFakeHealthServer(200);

    const outcome = await deployChannelSyncService({
      credential: credential(server.port),
      servicePort: 8787,
      deployPath: "/opt/hpp-channel-sync",
      image: "node:22-alpine",
      token: "e".repeat(64),
      serverSource: "x",
      serviceUrl,
    });

    expect(outcome.success).toBe(true);
    expect(outcome.pulledImage).toBe(true);
    expect(commands.some((command) => command.includes("docker pull"))).toBe(true);
  });

  it("容器起来了但健康检查不通时给出端口提示", async () => {
    const server = await startFakeNas({ exec: defaultExecHandler() });
    const serviceUrl = await startFakeHealthServer(500);

    const outcome = await deployChannelSyncService({
      credential: credential(server.port),
      servicePort: 8787,
      deployPath: "/opt/hpp-channel-sync",
      image: "node:22-alpine",
      token: "d".repeat(64),
      serverSource: "x",
      serviceUrl,
      healthTimeoutMs: 1500,
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("health");
  });
});
