import type { AgentConfigExportData } from "./agent-config-io";

/**
 * 渠道配置同步（渠道配置服务器）的共享协议层。
 *
 * 设计前提：一台服务器上跑一个极小的 HTTP 服务（`docker/channel-sync`），Hpp 只在
 * 用户主动点击时上传或下载整个渠道配置包，不做后台自动推送。因此这里的
 * 函数全部是纯函数：地址规范化、载荷统计、错误文案，渲染端与主进程共用。
 */

/** 服务端默认端口，与 docker-compose.yml 保持一致。 */
export const CHANNEL_SYNC_DEFAULT_PORT = 8787;

/** 快照接口路径；服务地址允许带子路径（反向代理场景）。 */
export const CHANNEL_SYNC_SNAPSHOT_PATH = "/snapshot";
/** 历史快照列表，用来读取服务器上的真实版本号（不含 payload，很轻）。 */
export const CHANNEL_SYNC_SNAPSHOTS_PATH = "/snapshots";

export const CHANNEL_SYNC_TOKEN_HEADER = "authorization";

export interface ChannelSyncConfig {
  /** 服务根地址，例如 http://100.64.0.7:8787 或 http://fnos:8787/hpp */
  baseUrl: string;
  /** Bearer Token，与服务端 HPP_SYNC_TOKEN 一致。 */
  token: string;
}

/** 同步状态快照，供设置界面展示；不含 token 本体。 */
export interface ChannelSyncStatus {
  configured: boolean;
  /** 当前激活目标；没有目标时为空。 */
  activeTargetId?: string;
  baseUrl: string;
  tokenSet: boolean;
  /** 已保存 Token 的掩码，仅用于界面展示。 */
  tokenPreview?: string;
  lastBackupAt?: string;
  lastBackupRevision?: number;
  lastPullAt?: string;
  /** 上次失败的最近一次错误，成功后清空。 */
  lastError?: string;
}

/** 服务端返回的快照元信息。 */
export interface ChannelSyncSnapshotMeta {
  revision: number;
  savedAt: string;
}

/** 上传结果。失败时 revision / savedAt 缺省。 */
export interface ChannelSyncBackupResult {
  success: boolean;
  error?: string;
  revision?: number;
  savedAt?: string;
  agentCount: number;
  providerCount: number;
}

/** 下载结果。 */
export interface ChannelSyncPullResult {
  success: boolean;
  error?: string;
  snapshot?: ChannelSyncSnapshotMeta;
  data?: AgentConfigExportData;
}

export interface ChannelSyncActionResult {
  success: boolean;
  error?: string;
  status?: ChannelSyncStatus;
}

/** 连通性探测结果。 */
export interface ChannelSyncTestResult {
  success: boolean;
  error?: string;
  /** 服务端当前最新 revision，0 表示还没备份过。 */
  revision?: number;
}

type NormalizeResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * 规范化用户填写的服务地址。
 *
 * 只接受 http/https：服务器在组网内是明文 HTTP，加密由组网层负责。
 * 允许带子路径以支持反向代理，但去掉末尾斜杠，避免拼出 `//snapshot`。
 */
export function normalizeChannelSyncBaseUrl(raw: string): NormalizeResult {
  const input = (raw || "").trim();
  if (!input) return { ok: false, error: "请填写服务器地址。" };
  if (!/^https?:\/\//i.test(input)) {
    return { ok: false, error: "地址需要以 http:// 或 https:// 开头，例如 http://100.64.0.7:8787。" };
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: "地址格式无效，请检查主机名和端口。" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "只支持 http 或 https 地址。" };
  }
  if (!parsed.hostname) return { ok: false, error: "地址缺少主机名。" };
  if (parsed.search || parsed.hash) {
    return { ok: false, error: "地址不要带查询参数或锚点。" };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return { ok: true, value: `${parsed.protocol}//${parsed.host}${path}` };
}

/** 展示用 token 掩码，避免在界面上明文暴露。 */
export function maskChannelSyncToken(token: string): string {
  const value = (token || "").trim();
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(Math.min(12, value.length - 6))}${value.slice(-2)}`;
}

/** 统计一个配置包里包含多少 Agent / 渠道，用于备份前后的提示。 */
export function countChannelSyncProviders(data: AgentConfigExportData): {
  agentCount: number;
  providerCount: number;
} {
  const entries = Object.values(data.agents || {});
  return {
    agentCount: entries.length,
    providerCount: entries.reduce((total, entry) => total + (entry.providers?.length || 0), 0),
  };
}

/** 快照时间展示成本地时间；iOS 风格 ISO 串解析失败时原样返回。 */
export function formatChannelSyncTimestamp(iso?: string): string {
  if (!iso) return "";
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

/**
 * 把底层网络错误翻译成用户能看懂的提示。
 *
 * 组网（比扬云）断开时 fetch 抛出的错误五花八门（ECONNREFUSED、ENOTFOUND、
 * UND_ERR_CONNECT_TIMEOUT），直接抛原文对用户没有指导意义。
 */
export function describeChannelSyncNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  const lower = message.toLowerCase();
  if (lower.includes("aborted") || lower.includes("timeout") || lower.includes("timed out")) {
    return "请求超时：请确认服务器是否在线、组网是否连通。";
  }
  if (lower.includes("econnrefused")) {
    return "连接被拒绝：服务没有启动，或地址/端口填错了。";
  }
  if (lower.includes("enotfound") || lower.includes("eai_again")) {
    return "主机名解析失败：请确认组网内的 IP 或主机名可达。";
  }
  if (lower.includes("network") || lower.includes("socket") || lower.includes("fetch failed")) {
    return "网络不可达：请确认比扬云组网是否已连接。";
  }
  if (lower.includes("certificate") || lower.includes("tls") || lower.includes("ssl")) {
    return "HTTPS 证书校验失败：组网内一般用 http 地址即可。";
  }
  return message || "同步失败，原因未知。";
}

/** HTTP 状态码对应的提示，尽量指出下一步该做什么。 */
export function describeChannelSyncStatus(status: number): string {
  if (status === 401) return "Token 不匹配：请确认与服务端 HPP_SYNC_TOKEN 一致。";
  if (status === 404) return "服务器上还没有备份，请先点一次「备份到服务器」。";
  if (status === 413) return "配置包太大，超出服务端限制。";
  if (status === 429) return "请求过于频繁，请稍后再试。";
  if (status >= 500) return "服务器内部错误，请查看容器日志。";
  return `服务返回 HTTP ${status}。`;
}

/* ------------------------------------------------------------------ *
 * 多目标部署（渠道配置服务器）
 *
 * 一个 target 代表一台可以部署同步服务的服务器。SSH 密码不进入渲染端，
 * 主进程用 safeStorage 加密后落盘，类型里只暴露 hasPassword。
 * ------------------------------------------------------------------ */

/** 远程主机的现状，决定界面上显示哪个徽章。 */
export type ChannelSyncTargetStatus =
  | "unknown"
  | "running"
  | "stopped"
  | "not_deployed"
  | "no_docker"
  | "no_sudo"
  | "unreachable";

export interface ChannelSyncTarget {
  id: string;
  name: string;
  /** 组网地址或主机名，例如 192.168.10.85 */
  host: string;
  sshPort: number;
  sshUser: string;
  /** safeStorage 加密后的密码；空表示不保存，部署时临时输入。 */
  encryptedPassword?: string;
  /** safeStorage 加密后的服务 Token，用于备份 / 拉取。 */
  encryptedToken?: string;
  servicePort: number;
  /** 部署目录，必须已存在或由部署流程创建。 */
  deployPath: string;
  /** 运行服务的镜像，默认 node:22-alpine。 */
  image: string;
  /** 首次连接记录的 SSH 主机指纹，用于防中间人。 */
  hostFingerprint?: string;
  lastDeployAt?: string;
  lastCheckAt?: string;
  lastStatus?: ChannelSyncTargetStatus;
  lastError?: string;
  /** 该目标上的备份状态，必须按目标隔离，不能共用一份全局记录。 */
  lastBackupAt?: string;
  lastBackupRevision?: number;
  lastPullAt?: string;
}

/** 渲染端可见的目标，绝不含密码明文。 */
export interface ChannelSyncTargetView {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  hasPassword: boolean;
  servicePort: number;
  deployPath: string;
  image: string;
  /** 由 host + servicePort 派生。 */
  serviceUrl: string;
  hostFingerprint?: string;
  lastDeployAt?: string;
  lastCheckAt?: string;
  lastStatus: ChannelSyncTargetStatus;
  lastError?: string;
  lastBackupAt?: string;
  lastBackupRevision?: number;
  lastPullAt?: string;
  isActive: boolean;
  /** 当前目标已保存的服务 Token 掩码。 */
  tokenPreview?: string;
}

/** 新建 / 编辑目标时提交的字段。password 为 undefined 表示沿用原值。 */
export interface ChannelSyncTargetInput {
  id?: string;
  name?: string;
  host: string;
  sshPort?: number;
  sshUser: string;
  password?: string;
  /**
   * 密码落盘方式：
   * - 不传（默认）：系统安全存储优先，不可用时用 Hpp 本地密钥兜底；
   * - `"local"`：同默认，显式表明允许本地密钥；
   * - `"system"`：只用系统安全存储，不可用时拒绝保存。
   */
  passwordStorage?: "system" | "local";
  /** 服务 Token：undefined 表示沿用原值，空字符串表示清除。 */
  token?: string;
  servicePort?: number;
  deployPath?: string;
  image?: string;
}

/** 远端容器的固定名字，重复部署时据此更新而不是叠加。 */
export const CHANNEL_SYNC_CONTAINER_NAME = "hpp-channel-sync";
export const CHANNEL_SYNC_DEFAULT_IMAGE = "node:22-alpine";
/**
 * 默认部署目录。
 *
 * 用 Linux 通用路径而不是某台 NAS 的私有路径（如 `/vol1/...`）：服务文件比
 * 较小，适合放 /opt；部署流程会自动创建并 chown 给 SSH 用户。
 */
export const CHANNEL_SYNC_DEFAULT_DEPLOY_PATH = "/opt/hpp-channel-sync";

export function buildChannelSyncServiceUrl(host: string, servicePort: number): string {
  return `http://${host}:${servicePort}`;
}

/** SSH 环境的只读探测结果，用来决定能不能部署。 */
export interface ChannelSyncProbeResult {
  success: boolean;
  error?: string;
  hostFingerprint?: string;
  /** 服务器指纹与上次记录不一致：拒绝继续，避免把密码交给冒充的主机。 */
  fingerprintChanged?: boolean;
  dockerVersion?: string;
  sudoAvailable?: boolean;
  sudoNeedsPassword?: boolean;
  diskFreeBytes?: number;
  portInUse?: boolean;
  containerStatus?: ChannelSyncTargetStatus;
  deployPathExists?: boolean;
}

export type ChannelSyncDeployPhase =
  | "connecting"
  | "probing"
  | "preparing"
  | "uploading"
  | "pulling"
  | "starting"
  | "verifying"
  | "done";

export interface ChannelSyncDeployEvent {
  kind: "progress" | "log";
  phase: ChannelSyncDeployPhase;
  message: string;
}

export interface ChannelSyncDeployResult {
  success: boolean;
  error?: string;
  target?: ChannelSyncTargetView;
  /** 本次没有重新部署，而是接管了服务器上已有的容器。 */
  adopted?: boolean;
}

export interface ChannelSyncCheckResult {
  success: boolean;
  status: ChannelSyncTargetStatus;
  error?: string;
  /** HTTP /health 是否可达。 */
  serviceOk?: boolean;
  revision?: number;
  checkedAt?: string;
}

/**
 * 规范化并校验目标输入。所有字段最终都会拼进远端 shell 命令，
 * 因此这里做白名单校验，避免命令注入。
 */
export function validateChannelSyncTargetInput(input: ChannelSyncTargetInput):
  | {
      ok: true;
      value: {
        name: string;
        host: string;
        sshPort: number;
        sshUser: string;
        servicePort: number;
        deployPath: string;
        image: string;
      };
    }
  | { ok: false; error: string } {
  const host = (input.host || "").trim();
  if (!host) return { ok: false, error: "请填写服务器地址。" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) {
    return { ok: false, error: "服务器地址只支持 IPv4 或主机名，不要带 http:// 或端口。" };
  }

  const sshUser = (input.sshUser || "").trim();
  if (!sshUser) return { ok: false, error: "请填写 SSH 用户名。" };
  if (!/^[A-Za-z0-9._-]+$/.test(sshUser)) {
    return { ok: false, error: "SSH 用户名包含不支持的字符。" };
  }

  // 注意用显式 undefined 判断：0 是 falsy，用 `||` 会被悄悄替换成默认端口。
  const sshPort = input.sshPort === undefined ? 22 : Number(input.sshPort);
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    return { ok: false, error: "SSH 端口需要在 1-65535 之间。" };
  }

  const servicePort =
    input.servicePort === undefined ? CHANNEL_SYNC_DEFAULT_PORT : Number(input.servicePort);
  if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65535) {
    return { ok: false, error: "服务端口需要在 1-65535 之间。" };
  }

  const deployPath = (input.deployPath || CHANNEL_SYNC_DEFAULT_DEPLOY_PATH).trim().replace(/\/+$/, "");
  if (!deployPath.startsWith("/")) {
    return { ok: false, error: "部署目录必须是绝对路径，例如 /opt/hpp-channel-sync。" };
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(deployPath) || deployPath.includes("..")) {
    return { ok: false, error: "部署目录包含不支持的字符。" };
  }

  const image = (input.image || CHANNEL_SYNC_DEFAULT_IMAGE).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image)) {
    return { ok: false, error: "镜像名包含不支持的字符。" };
  }

  const name = (input.name || "").trim() || host;
  return { ok: true, value: { name, host, sshPort, sshUser, servicePort, deployPath, image } };
}

/** 默认部署目录应当与发行版无关，不能绑定某一台设备的私有路径。 */
export const CHANNEL_SYNC_DEFAULT_DEPLOY_PATH_IS_GENERIC =
  CHANNEL_SYNC_DEFAULT_DEPLOY_PATH === "/opt/hpp-channel-sync";

/** 状态徽章的中文文案。 */
export function describeChannelSyncTargetStatus(status: ChannelSyncTargetStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "stopped":
      return "已部署未运行";
    case "not_deployed":
      return "未部署";
    case "no_docker":
      return "无 Docker";
    case "no_sudo":
      return "无 sudo 权限";
    case "unreachable":
      return "不可达";
    default:
      return "未检查";
  }
}

/** 卸载远端部署的选项。 */
export interface ChannelSyncUndeployOptions {
  /** 未保存密码时临时提供。 */
  password?: string;
  /** 是否连同部署目录一起删除（会丢掉 data/ 里的历史备份）。 */
  removeData?: boolean;
}

/** 目标增删改的返回。 */
export interface ChannelSyncTargetActionResult {
  success: boolean;
  error?: string;
  target?: ChannelSyncTargetView;
  targets?: ChannelSyncTargetView[];
}

/**
 * 系统安全存储（Electron safeStorage）的当前状态。
 *
 * 界面据此决定能不能把 SSH 密码落盘：Linux 上没有 Secret Service
 * （niri / sway 等未启动 gnome-keyring 的会话）时不可用。
 */
export interface ChannelSyncSecretStorageStatus {
  available: boolean;
  /** Linux 上 Chromium 实际选择的密码后端；其他平台通常为 unknown。 */
  backend: string;
}
