import { createHash, randomBytes } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { Client } from "ssh2";
import { app } from "electron";
import {
  CHANNEL_SYNC_CONTAINER_NAME,
  type ChannelSyncCheckResult,
  type ChannelSyncDeployEvent,
  type ChannelSyncDeployPhase,
  type ChannelSyncProbeResult,
  type ChannelSyncTargetStatus,
} from "../../shared/channel-sync";

/**
 * 渠道配置服务器的 SSH 部署层：连接、环境探测、上传、起容器、状态检查。
 *
 * 这里只做「远端执行」这一件事，不碰本地配置。用户名/密码由上层传入，
 * 密码只在内存里用于 sudo 的 stdin，绝不拼进命令行参数。
 */

export interface SshCredential {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  stdin?: string;
  timeoutMs?: number;
}

export interface SshSession {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  writeFile(remotePath: string, content: string, mode?: number): Promise<void>;
  close(): void;
}

export interface ConnectedSession {
  session: SshSession;
  /** OpenSSH 风格的主机指纹，例如 SHA256:abc… */
  fingerprint: string;
}

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 20_000;

/** 单引号包裹，内部单引号转义成 '\''。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** OpenSSH 的 SHA256 指纹格式，用于和 `ssh-keygen -lf` 对得上。 */
export function formatSshFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function createChannelSyncToken(): string {
  return randomBytes(32).toString("hex");
}

/** 把 ssh2 的错误翻译成能指导用户下一步的中文。 */
export function describeSshError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  if (lower.includes("verification failed") || lower.includes("host denied") || lower.includes("fingerprint")) {
    return "SSH 主机指纹与上次记录不一致，已中止连接。若确实换过机器，请清除该目标的主机指纹后重试。";
  }
  if (lower.includes("all configured authentication methods failed") || lower.includes("permission denied")) {
    return "SSH 用户名或密码不正确。";
  }
  if (lower.includes("econnrefused")) {
    return "SSH 端口不可达：请确认服务器已开启 SSH、端口填写正确。";
  }
  if (lower.includes("econnreset")) {
    return "SSH 连接被对端重置：端口转发可能指向了错误的主机，或服务器中途拒绝了连接。";
  }
  if (lower.includes("connection lost") || lower.includes("before handshake")) {
    return "SSH 握手阶段连接被断开：端口转发目标可能不对，或服务器 SSH 服务异常。";
  }
  if (lower.includes("enotfound") || lower.includes("eai_again")) {
    return "服务器地址解析失败：请确认组网是否连通。";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "SSH 连接超时：请确认组网连通，且防火墙没有拦截 SSH 端口。";
  }
  return message || "SSH 连接失败。";
}

/** 把 `key=value` 形式的探测输出解析成对象。 */
export function parseProbeOutput(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (/^[a-z_]+$/.test(key)) result[key] = value;
  }
  return result;
}

export async function connectSsh(
  credential: SshCredential,
  options: { expectedFingerprint?: string; readyTimeoutMs?: number } = {},
): Promise<ConnectedSession> {
  const client = new Client();
  let fingerprint = "";

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      // 统一在这里翻译，调用方拿到的永远是能指导操作的中文错误。
      if (error) reject(new Error(describeSshError(error)));
      else resolve();
    };

    // 必须用 on 而不是 once：ssh2 在握手失败、连接被对端打断时可能连续
    // emit 多次 error。once 被消费掉之后再 emit 就没有监听器，Node 会抛
    // 未捕获异常，直接把 Electron 主进程弹成崩溃窗口。
    client.on("error", (error) => finish(error));
    client.on("close", () => {
      finish(new Error("连接在 SSH 握手阶段被中断"));
    });
    client.once("ready", () => finish());
    client.connect({
      host: credential.host,
      port: credential.port,
      username: credential.username,
      password: credential.password,
      readyTimeout: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      keepaliveInterval: 10_000,
      hostVerifier: (key: Buffer) => {
        fingerprint = formatSshFingerprint(key);
        if (!options.expectedFingerprint) return true;
        return options.expectedFingerprint === fingerprint;
      },
    });
  });

  const session: SshSession = {
    exec(command, execOptions = {}) {
      return execOnClient(client, command, execOptions);
    },
    async writeFile(remotePath, content, mode) {
      const sftp = await new Promise<import("ssh2").SFTPWrapper>((resolve, reject) => {
        client.sftp((error, wrapper) => (error ? reject(error) : resolve(wrapper)));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.writeFile(remotePath, content, { mode }, (error) => (error ? reject(error) : resolve()));
        });
      } finally {
        sftp.end();
      }
    },
    close() {
      try {
        client.end();
      } catch {
        // 连接已断开时 end 会抛，忽略即可。
      }
    },
  };

  return { session, fingerprint };
}

function execOnClient(client: Client, command: string, options: ExecOptions): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`远程命令执行超时（${Math.round(timeoutMs / 1000)}s）。`));
      try {
        client.end();
      } catch {
        // ignore
      }
    }, timeoutMs);

    client.exec(command, (error, channel) => {
      if (error) {
        clearTimeout(timer);
        settled = true;
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      channel.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      channel.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      channel.once("close", (code: number | null) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ code: typeof code === "number" ? code : -1, stdout, stderr });
      });
      channel.once("error", (streamError: Error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(streamError);
      });
      if (options.stdin) channel.end(options.stdin);
    });
  });
}

function runPrivileged(
  session: SshSession,
  script: string,
  options: { password: string; uid: number; timeoutMs?: number },
): Promise<ExecResult> {
  // root 直接执行；普通管理员走 sudo，密码从 stdin 给，不进入 argv。
  if (options.uid === 0) {
    return session.exec(script, { timeoutMs: options.timeoutMs });
  }
  return session.exec(`sudo -S -p '' sh -c ${shellQuote(script)}`, {
    stdin: `${options.password}\n`,
    timeoutMs: options.timeoutMs,
  });
}

const PROBE_PLAIN_SCRIPT = (servicePort: number, deployPath: string) => `
echo "docker_bin=$(command -v docker 2>/dev/null || echo none)"
echo "docker_version=$(docker --version 2>/dev/null | tr -d '\\n' || echo none)"
echo "uid=$(id -u)"
echo "gid=$(id -g)"
echo "port_in_use=$( (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -c ':${servicePort} ' || true)"
echo "deploy_path_exists=$(test -d ${shellQuote(deployPath)} && echo yes || echo no)"
echo "disk_free_kb=$(df -Pk ${shellQuote(deployPath)} 2>/dev/null | awk 'NR==2 {print $4}' || true)"
echo "sudo_nopass=$(sudo -n true 2>/dev/null && echo yes || echo no)"
`;

const PROBE_PRIVILEGED_SCRIPT = (image: string) => `
echo "docker_info=$(docker info --format '{{.ServerVersion}}' 2>/dev/null || echo none)"
echo "image_exists=$(docker image inspect ${shellQuote(image)} >/dev/null 2>&1 && echo yes || echo none)"
echo "container=$(docker inspect ${shellQuote(CHANNEL_SYNC_CONTAINER_NAME)} --format '{{.State.Status}}' 2>/dev/null || echo none)"
`;

export interface ProbeParams {
  credential: SshCredential;
  servicePort: number;
  deployPath: string;
  image: string;
  expectedFingerprint?: string;
}

/**
 * 只读探测：能不能 SSH、有没有 docker、sudo 是否可用、端口是否被占、
 * 容器是否已存在。不会修改远端任何东西。
 */
export async function probeChannelSyncTarget(
  params: ProbeParams,
): Promise<ChannelSyncProbeResult & { fingerprint?: string; uid?: number; gid?: number }> {
  let connected: ConnectedSession;
  try {
    connected = await connectSsh(params.credential, {
      expectedFingerprint: params.expectedFingerprint,
    });
  } catch (error) {
    const fingerprintChanged = /fingerprint|verification|host denied/i.test(
      error instanceof Error ? error.message : String(error),
    );
    return { success: false, error: describeSshError(error), fingerprintChanged };
  }

  const { session, fingerprint } = connected;
  try {
    const plain = await session.exec(PROBE_PLAIN_SCRIPT(params.servicePort, params.deployPath));
    const values = parseProbeOutput(plain.stdout);
    const uid = Number(values.uid);
    if (!Number.isInteger(uid)) {
      return { success: false, error: "无法读取远端用户信息。", hostFingerprint: fingerprint };
    }
    const gid = Number(values.gid);

    const hasDocker = values.docker_bin && values.docker_bin !== "none";
    const sudoNoPass = values.sudo_nopass === "yes";
    const needsPassword = uid !== 0 && !sudoNoPass;

    // 普通用户且 sudo 需要密码时，用一次带密码的 sudo 验证能否提权。
    const privileged = await runPrivileged(session, PROBE_PRIVILEGED_SCRIPT(params.image), {
      password: params.credential.password,
      uid,
      timeoutMs: 20_000,
    });
    const privilegedValues = parseProbeOutput(privileged.stdout);
    const dockerInfo = privilegedValues.docker_info;
    const hasPrivilege = privileged.code === 0 && dockerInfo !== undefined && dockerInfo !== "none";

    const containerState = privilegedValues.container;
    const status: ChannelSyncTargetStatus = !hasDocker
      ? "no_docker"
      : !hasPrivilege
        ? "no_sudo"
        : containerState === "running"
          ? "running"
          : containerState && containerState !== "none"
            ? "stopped"
            : "not_deployed";

    return {
      success: true,
      hostFingerprint: fingerprint,
      dockerVersion: values.docker_version !== "none" ? values.docker_version : undefined,
      sudoAvailable: hasPrivilege,
      sudoNeedsPassword: needsPassword,
      diskFreeBytes: values.disk_free_kb ? Number(values.disk_free_kb) * 1024 : undefined,
      portInUse: values.port_in_use === "1" || Number(values.port_in_use) > 0,
      containerStatus: status,
      deployPathExists: values.deploy_path_exists === "yes",
      uid,
      gid: Number.isInteger(gid) ? gid : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: describeSshError(error),
      hostFingerprint: fingerprint,
    };
  } finally {
    session.close();
  }
}

export interface DeployParams {
  credential: SshCredential;
  servicePort: number;
  deployPath: string;
  image: string;
  token: string;
  serverSource: string;
  serviceUrl: string;
  expectedFingerprint?: string;
  onEvent?: (event: ChannelSyncDeployEvent) => void;
  /** 部署后等待 /health 的时长；测试里会调小。 */
  healthTimeoutMs?: number;
}

export interface DeployOutcome {
  success: boolean;
  error?: string;
  fingerprint?: string;
  uid?: number;
  gid?: number;
  /** 镜像是否本次新拉取（首次部署会慢）。 */
  pulledImage?: boolean;
}

const PULL_TIMEOUT_MS = 10 * 60_000;
const START_TIMEOUT_MS = 3 * 60_000;

function emitProgress(
  onEvent: DeployParams["onEvent"],
  phase: ChannelSyncDeployPhase,
  message: string,
): void {
  onEvent?.({ kind: "progress", phase, message });
}

function emitLog(onEvent: DeployParams["onEvent"], phase: ChannelSyncDeployPhase, message: string): void {
  const text = message.trim();
  if (text) onEvent?.({ kind: "log", phase, message: text });
}

async function waitForServiceHealth(serviceUrl: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serviceUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) return true;
    } catch {
      // 容器还在启动，继续轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/**
 * 幂等部署：已有容器会被重建，`data/` 目录保留（备份不丢）。
 * 镜像已存在时跳过 docker pull，避免每次更新都等网络。
 */
export async function deployChannelSyncService(params: DeployParams): Promise<DeployOutcome> {
  const { onEvent } = params;
  const logPhase: ChannelSyncDeployPhase = "probing";

  emitProgress(onEvent, "connecting", "正在建立 SSH 连接…");
  let connected: ConnectedSession;
  try {
    connected = await connectSsh(params.credential, {
      expectedFingerprint: params.expectedFingerprint,
    });
  } catch (error) {
    return { success: false, error: describeSshError(error) };
  }

  const { session, fingerprint } = connected;
  try {
    emitProgress(onEvent, "probing", "正在检查远端环境…");
    const plain = await session.exec(PROBE_PLAIN_SCRIPT(params.servicePort, params.deployPath));
    const values = parseProbeOutput(plain.stdout);
    const uid = Number(values.uid);
    const gid = Number(values.gid);

    if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
      return { success: false, error: "无法读取远端用户信息。", fingerprint };
    }
    if (!values.docker_bin || values.docker_bin === "none") {
      return {
        success: false,
        error: "服务器上找不到 docker，请先安装 Docker。",
        fingerprint,
      };
    }
    emitLog(onEvent, logPhase, `Docker: ${values.docker_version || "unknown"}`);

    const privileged = await runPrivileged(session, PROBE_PRIVILEGED_SCRIPT(params.image), {
      password: params.credential.password,
      uid,
      timeoutMs: 20_000,
    });
    const privilegedValues = parseProbeOutput(privileged.stdout);
    if (privileged.code !== 0 || !privilegedValues.docker_info || privilegedValues.docker_info === "none") {
      return {
        success: false,
        error:
          uid === 0
            ? "docker 无法访问守护进程，请确认 Docker 服务正在运行。"
            : "当前账号无法通过 sudo 执行 docker：请把账号加入 Administrators 组，或改用 root 账号。",
        fingerprint,
      };
    }

    const imageExists = privilegedValues.image_exists === "yes";
    const containerExists = !!privilegedValues.container && privilegedValues.container !== "none";

    emitProgress(onEvent, "preparing", "正在准备部署目录…");
    const prepare = await runPrivileged(
      session,
      `mkdir -p ${shellQuote(`${params.deployPath}/data`)} && chown -R ${uid}:${gid} ${shellQuote(params.deployPath)} && chmod 755 ${shellQuote(params.deployPath)}`,
      { password: params.credential.password, uid, timeoutMs: 30_000 },
    );
    if (prepare.code !== 0) {
      return {
        success: false,
        error: `创建部署目录失败：${prepare.stderr.trim() || "未知错误"}`,
        fingerprint,
      };
    }

    emitProgress(onEvent, "uploading", "正在上传服务文件…");
    await session.writeFile(`${params.deployPath}/server.mjs`, params.serverSource, 0o644);
    await session.writeFile(
      `${params.deployPath}/.env`,
      `HPP_SYNC_TOKEN=${params.token}\nHPP_SYNC_HISTORY_LIMIT=20\n`,
      0o600,
    );

    let pulledImage = false;
    if (!imageExists) {
      emitProgress(onEvent, "pulling", `正在拉取镜像 ${params.image}（首次部署可能需要几分钟）…`);
      const pull = await runPrivileged(session, `docker pull ${shellQuote(params.image)}`, {
        password: params.credential.password,
        uid,
        timeoutMs: PULL_TIMEOUT_MS,
      });
      if (pull.code !== 0) {
        emitLog(onEvent, "pulling", pull.stderr || pull.stdout);
        return {
          success: false,
          error: `拉取镜像失败：${pull.stderr.trim() || "请检查服务器的网络或 Docker 镜像加速配置。"}`,
          fingerprint,
        };
      }
      pulledImage = true;
    } else {
      emitLog(onEvent, logPhase, `镜像 ${params.image} 已存在，跳过拉取。`);
    }

    emitProgress(onEvent, "starting", containerExists ? "正在更新容器…" : "正在创建容器…");
    const runScript = [
      `docker rm -f ${shellQuote(CHANNEL_SYNC_CONTAINER_NAME)} >/dev/null 2>&1 || true`,
      [
        "docker run -d",
        `--name ${shellQuote(CHANNEL_SYNC_CONTAINER_NAME)}`,
        "--restart unless-stopped",
        `--user ${uid}:${gid}`,
        `-p ${params.servicePort}:8787`,
        `-v ${shellQuote(`${params.deployPath}/data`)}:/data`,
        `-v ${shellQuote(`${params.deployPath}/server.mjs`)}:/app/server.mjs:ro`,
        `--env-file ${shellQuote(`${params.deployPath}/.env`)}`,
        shellQuote(params.image),
        "node /app/server.mjs",
      ].join(" "),
    ].join("\n");
    const run = await runPrivileged(session, runScript, {
      password: params.credential.password,
      uid,
      timeoutMs: START_TIMEOUT_MS,
    });
    if (run.code !== 0) {
      emitLog(onEvent, "starting", run.stderr || run.stdout);
      return {
        success: false,
        error: `启动容器失败：${run.stderr.trim() || "请查看服务器上的 Docker 日志。"}`,
        fingerprint,
      };
    }

    emitProgress(onEvent, "verifying", "正在验证服务…");
    const healthy = await waitForServiceHealth(
      params.serviceUrl,
      params.healthTimeoutMs ?? 30_000,
    );
    if (!healthy) {
      const logs = await runPrivileged(
        session,
        `docker logs --tail 20 ${shellQuote(CHANNEL_SYNC_CONTAINER_NAME)} 2>&1 || true`,
        { password: params.credential.password, uid, timeoutMs: 20_000 },
      );
      emitLog(onEvent, "verifying", logs.stdout || logs.stderr);
      return {
        success: false,
        error: `容器已创建，但 ${params.serviceUrl}/health 无响应。请检查端口是否被防火墙拦截。`,
        fingerprint,
        uid,
        gid,
        pulledImage,
      };
    }

    emitProgress(onEvent, "done", "部署完成，服务已就绪。");
    return { success: true, fingerprint, uid, gid, pulledImage };
  } catch (error) {
    return { success: false, error: describeSshError(error), fingerprint };
  } finally {
    session.close();
  }
}

export interface CheckParams {
  /** 没保存 SSH 密码时只能做 HTTP 检查。 */
  credential?: SshCredential;
  serviceUrl: string;
  expectedFingerprint?: string;
  image: string;
  servicePort: number;
  deployPath: string;
}

/** 单独的 HTTP 健康检查，供上层在拿不到 SSH 凭据时降级使用。 */
export async function checkChannelSyncServiceHealth(serviceUrl: string): Promise<boolean> {
  return waitForServiceHealth(serviceUrl, 4000);
}

/**
 * 状态检查：HTTP /health 优先（最快），失败时回到 SSH 看容器和 docker。
 * 这样能区分「没部署」「部署了没起来」「起来了但端口不通」。
 */
export async function checkChannelSyncTarget(params: CheckParams): Promise<ChannelSyncCheckResult> {
  const checkedAt = new Date().toISOString();
  const serviceOk = await waitForServiceHealth(params.serviceUrl, 4000).catch(() => false);
  if (serviceOk) {
    return { success: true, status: "running", serviceOk: true, checkedAt };
  }

  if (!params.credential) {
    return {
      success: false,
      status: "unreachable",
      error: "服务不可达，且没有保存 SSH 密码，无法进一步检查容器状态。",
      serviceOk: false,
      checkedAt,
    };
  }

  const probe = await probeChannelSyncTarget({
    credential: params.credential,
    servicePort: params.servicePort,
    deployPath: params.deployPath,
    image: params.image,
    expectedFingerprint: params.expectedFingerprint,
  });

  if (!probe.success) {
    return {
      success: false,
      status: "unreachable",
      error: probe.error,
      serviceOk: false,
      checkedAt,
    };
  }

  const status = probe.containerStatus ?? "unknown";
  return {
    success: status === "running",
    status,
    serviceOk: false,
    error:
      status === "running"
        ? `容器在运行，但 ${params.serviceUrl}/health 不通：检查端口映射和飞牛防火墙。`
        : undefined,
    checkedAt,
  };
}

/** 读取打包进应用 / 随仓库分发的服务端源码。 */
export async function readNasServerSource(): Promise<string> {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "channel-sync", "server.mjs") : "",
    join(app.getAppPath(), "docker", "channel-sync", "server.mjs"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // 试下一个位置。
    }
  }
  throw new Error("找不到渠道配置服务端文件（server.mjs），请重新安装 Hpp。");
}

export interface UndeployParams {
  credential: SshCredential;
  deployPath: string;
  /** 是否连同部署目录一起删除（包含 data/ 里的历史备份）。 */
  removeData: boolean;
  expectedFingerprint?: string;
}

export interface UndeployOutcome {
  success: boolean;
  error?: string;
  removedContainer?: boolean;
  removedData?: boolean;
}

/**
 * 卸载远端部署：停止并删除容器。默认只删容器，保留 `data/` 里的备份；
 * 明确要求时才连同部署目录一起删除。
 */
export async function undeployChannelSyncService(params: UndeployParams): Promise<UndeployOutcome> {
  let connected: ConnectedSession;
  try {
    connected = await connectSsh(params.credential, {
      expectedFingerprint: params.expectedFingerprint,
    });
  } catch (error) {
    return { success: false, error: describeSshError(error) };
  }

  const { session } = connected;
  try {
    const uidResult = await session.exec("id -u");
    const uid = Number(uidResult.stdout.trim());
    if (!Number.isInteger(uid)) {
      return { success: false, error: "无法读取远端用户信息。" };
    }
    const privileged = { password: params.credential.password, uid };

    const exists = await runPrivileged(
      session,
      `docker inspect ${shellQuote(CHANNEL_SYNC_CONTAINER_NAME)} >/dev/null 2>&1 && echo yes || echo no`,
      privileged,
    );
    const hadContainer = exists.stdout.trim().endsWith("yes");

    if (hadContainer) {
      const removed = await runPrivileged(
        session,
        `docker rm -f ${shellQuote(CHANNEL_SYNC_CONTAINER_NAME)}`,
        { ...privileged, timeoutMs: 60_000 },
      );
      if (removed.code !== 0) {
        return {
          success: false,
          error: `删除容器失败：${removed.stderr.trim() || "未知错误"}`,
          removedContainer: false,
        };
      }
    }

    if (params.removeData) {
      const removedDir = await runPrivileged(session, `rm -rf ${shellQuote(params.deployPath)}`, {
        ...privileged,
        timeoutMs: 60_000,
      });
      if (removedDir.code !== 0) {
        return {
          success: false,
          error: `删除部署目录失败：${removedDir.stderr.trim() || "未知错误"}`,
          removedContainer: hadContainer,
          removedData: false,
        };
      }
      return { success: true, removedContainer: hadContainer, removedData: true };
    }

    // 只删容器时清掉服务文件，避免下次部署读到旧 .env；data/ 保持不动。
    await runPrivileged(
      session,
      `rm -f ${shellQuote(`${params.deployPath}/server.mjs`)} ${shellQuote(`${params.deployPath}/.env`)}`,
      privileged,
    );
    return { success: true, removedContainer: hadContainer, removedData: false };
  } catch (error) {
    return { success: false, error: describeSshError(error) };
  } finally {
    session.close();
  }
}
