import { createServer, type Server as HttpServer } from "http";
import { AddressInfo } from "net";
import { Server, utils } from "ssh2";
import type { ExecResult } from "../nas-deploy";

/**
 * 测试用的假 NAS：用 ssh2 自带服务端模拟 SSH（密码认证 + exec + sftp），
 * 再用一个本地 HTTP 服务模拟同步服务的 /health。真实 NAS 上只有命令输出不同。
 */

export type ExecHandler = (command: string) => Partial<ExecResult> | undefined;

export interface FakeNasOptions {
  exec?: ExecHandler;
  onFile?: (path: string, content: string) => void;
  username?: string;
  password?: string;
}

export interface FakeNas {
  port: number;
  files: Map<string, string>;
  close: () => Promise<void>;
}

const openNas: FakeNas[] = [];
const openHttp: HttpServer[] = [];

export async function startFakeNas(options: FakeNasOptions = {}): Promise<FakeNas> {
  const username = options.username || "tester";
  const password = options.password || "secret";
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const files = new Map<string, string>();

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    // 指纹校验失败时客户端会在握手中途断开，服务端按协议 emit error；
    // 这是被测行为本身，不是测试失败。
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === username && context.password === password) {
        context.accept();
        return;
      }
      context.reject(["password"]);
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();

        session.on("exec", (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          const result = options.exec?.(info.command) || { stdout: "", code: 0 };
          if (result.stdout) stream.write(result.stdout);
          if (result.stderr) stream.stderr.write(result.stderr);
          stream.exit(result.code ?? 0);
          stream.end();
        });

        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const buffers = new Map<string, Buffer[]>();

          sftp.on("OPEN", (reqid, filename) => {
            buffers.set(filename, []);
            sftp.handle(reqid, Buffer.from(filename));
          });
          sftp.on("WRITE", (reqid, handle, _offset, data) => {
            const name = handle.toString();
            buffers.set(name, [...(buffers.get(name) || []), Buffer.from(data)]);
            sftp.status(reqid, 0);
          });
          sftp.on("CLOSE", (reqid, handle) => {
            const name = handle.toString();
            const content = Buffer.concat(buffers.get(name) || []).toString("utf8");
            files.set(name, content);
            options.onFile?.(name, content);
            sftp.status(reqid, 0);
          });
        });
      });
    });
  });

  server.on("error", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const item: FakeNas = {
    port,
    files,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  openNas.push(item);
  return item;
}

export async function startFakeHealthServer(status = 200): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(status === 200 ? '{"ok":true,"revision":3}' : "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openHttp.push(server);
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

export async function closeFakeServers(): Promise<void> {
  while (openNas.length > 0) {
    const item = openNas.pop();
    if (item) await item.close();
  }
  while (openHttp.length > 0) {
    const item = openHttp.pop();
    if (item) await new Promise<void>((resolve) => item.close(() => resolve()));
  }
}

/** 一份典型的远端探测输出，测试按需覆盖字段。 */
export function probeOutput(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    docker_bin: "/usr/bin/docker",
    docker_version: "Docker version 28.5.2",
    uid: "1002",
    gid: "1001",
    port_in_use: "0",
    deploy_path_exists: "no",
    disk_free_kb: "500000000",
    sudo_nopass: "no",
    docker_info: "28.5.2",
    image_exists: "yes",
    container: "none",
    ...overrides,
  };
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** 部署时按命令关键字返回对应的假输出。 */
export function defaultExecHandler(overrides: Record<string, string> = {}): ExecHandler {
  return (command) => {
    if (command.includes('echo "docker_bin=')) return { stdout: probeOutput(overrides), code: 0 };
    if (command.includes('echo "docker_info=')) return { stdout: probeOutput(overrides), code: 0 };
    if (command.includes("docker run")) return { stdout: "container-id\n", code: 0 };
    if (command.includes("docker pull")) return { stdout: "pulled\n", code: 0 };
    if (command.includes("docker logs")) return { stdout: "listening\n", code: 0 };
    return { stdout: "", code: 0 };
  };
}
