import { randomUUID } from "crypto";
import { app, ipcMain } from "electron";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  isValidAgentConfigExport,
  type AgentConfigExportData,
} from "../../shared/agent-config-io";
import {
  buildChannelSyncServiceUrl,
  CHANNEL_SYNC_DEFAULT_DEPLOY_PATH,
  CHANNEL_SYNC_DEFAULT_IMAGE,
  CHANNEL_SYNC_DEFAULT_PORT,
  CHANNEL_SYNC_SNAPSHOT_PATH,
  CHANNEL_SYNC_SNAPSHOTS_PATH,
  countChannelSyncProviders,
  describeChannelSyncNetworkError,
  describeChannelSyncStatus,
  maskChannelSyncToken,
  validateChannelSyncTargetInput,
  type ChannelSyncActionResult,
  type ChannelSyncBackupResult,
  type ChannelSyncCheckResult,
  type ChannelSyncDeployEvent,
  type ChannelSyncDeployResult,
  type ChannelSyncProbeResult,
  type ChannelSyncPullResult,
  type ChannelSyncStatus,
  type ChannelSyncTarget,
  type ChannelSyncTargetActionResult,
  type ChannelSyncTargetStatus,
  type ChannelSyncTargetView,
  type ChannelSyncTestResult,
  type ChannelSyncUndeployOptions,
} from "../../shared/channel-sync";
import { isRecord } from "../utils/unknown-value";
import { queueNamedWrite } from "../utils/write-queue";
import {
  checkChannelSyncTarget,
  createChannelSyncToken,
  deployChannelSyncService,
  probeChannelSyncTarget,
  readNasServerSource,
  undeployChannelSyncService,
} from "./nas-deploy";
import { decryptSecret, encryptSecret } from "./secret-store";

/**
 * 渠道配置同步的主进程状态管理。
 *
 * 配置（`hpp-data/channel-sync.json`）里可以有多个渠道配置服务器：每个目标带自己的
 * SSH 地址、服务端口和 Token，同一时间只有一个被标为 active，备份/拉取都针对
 * 它。SSH 密码和 Token 用 safeStorage 加密落盘，渲染端只拿得到掩码。
 *
 * 所有远端操作都要求用户显式触发（部署 / 检查 / 备份 / 拉取），没有后台轮询。
 */

const FILE_NAME = "channel-sync.json";
const QUEUE_KEY = "channel-sync";
const REQUEST_TIMEOUT_MS = 20_000;
const STORE_VERSION = 2;

interface StoredState {
  lastBackupAt?: string;
  lastBackupRevision?: number;
  lastPullAt?: string;
  lastError?: string;
}

interface StoredFile {
  version: number;
  activeTargetId?: string;
  targets: ChannelSyncTarget[];
  state: StoredState;
}

interface ServiceEndpoint {
  serviceUrl: string;
  token: string;
}

class ChannelSyncHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(describeChannelSyncStatus(status));
    this.status = status;
  }
}

function emptyFile(): StoredFile {
  return { version: STORE_VERSION, targets: [], state: {} };
}

function getSyncFilePath() {
  return join(app.getPath("userData"), "hpp-data", FILE_NAME);
}

const TARGET_STATUSES: ChannelSyncTargetStatus[] = [
  "unknown",
  "running",
  "stopped",
  "not_deployed",
  "no_docker",
  "no_sudo",
  "unreachable",
];

function isTargetStatus(value: unknown): value is ChannelSyncTargetStatus {
  return typeof value === "string" && (TARGET_STATUSES as string[]).includes(value);
}

function sanitizeState(value: unknown): StoredState {
  if (!isRecord(value)) return {};
  const state: StoredState = {};
  if (typeof value.lastBackupAt === "string") state.lastBackupAt = value.lastBackupAt;
  if (Number.isInteger(value.lastBackupRevision)) {
    state.lastBackupRevision = Number(value.lastBackupRevision);
  }
  if (typeof value.lastPullAt === "string") state.lastPullAt = value.lastPullAt;
  if (typeof value.lastError === "string" && value.lastError) state.lastError = value.lastError;
  return state;
}

function normalizeTarget(value: unknown): ChannelSyncTarget | undefined {
  if (!isRecord(value)) return undefined;
  const validated = validateChannelSyncTargetInput({
    name: typeof value.name === "string" ? value.name : "",
    host: typeof value.host === "string" ? value.host : "",
    sshPort: Number.isInteger(value.sshPort) ? Number(value.sshPort) : 22,
    sshUser: typeof value.sshUser === "string" ? value.sshUser : "root",
    servicePort: Number.isInteger(value.servicePort)
      ? Number(value.servicePort)
      : CHANNEL_SYNC_DEFAULT_PORT,
    deployPath:
      typeof value.deployPath === "string" ? value.deployPath : CHANNEL_SYNC_DEFAULT_DEPLOY_PATH,
    image: typeof value.image === "string" ? value.image : CHANNEL_SYNC_DEFAULT_IMAGE,
  });
  if (!validated.ok) return undefined;
  return {
    id: typeof value.id === "string" && value.id ? value.id : randomUUID(),
    ...validated.value,
    encryptedPassword:
      typeof value.encryptedPassword === "string" ? value.encryptedPassword : undefined,
    encryptedToken: typeof value.encryptedToken === "string" ? value.encryptedToken : undefined,
    hostFingerprint:
      typeof value.hostFingerprint === "string" ? value.hostFingerprint : undefined,
    lastDeployAt: typeof value.lastDeployAt === "string" ? value.lastDeployAt : undefined,
    lastCheckAt: typeof value.lastCheckAt === "string" ? value.lastCheckAt : undefined,
    lastStatus: isTargetStatus(value.lastStatus) ? value.lastStatus : undefined,
    lastError: typeof value.lastError === "string" ? value.lastError : undefined,
    lastBackupAt: typeof value.lastBackupAt === "string" ? value.lastBackupAt : undefined,
    lastBackupRevision: Number.isInteger(value.lastBackupRevision)
      ? Number(value.lastBackupRevision)
      : undefined,
    lastPullAt: typeof value.lastPullAt === "string" ? value.lastPullAt : undefined,
  };
}

/** 旧版单目标配置（config + state）自动迁移成 targets[0]。 */
function migrateLegacy(parsed: Record<string, unknown>): StoredFile {
  const state = sanitizeState(parsed.state);
  const config = isRecord(parsed.config) ? parsed.config : undefined;
  const baseUrl = typeof config?.baseUrl === "string" ? config.baseUrl : "";
  const token = typeof config?.token === "string" ? config.token : "";
  if (!baseUrl) return { version: STORE_VERSION, targets: [], state };

  let host = "";
  let servicePort = CHANNEL_SYNC_DEFAULT_PORT;
  try {
    const url = new URL(baseUrl);
    host = url.hostname;
    servicePort = Number(url.port || CHANNEL_SYNC_DEFAULT_PORT);
  } catch {
    return { version: STORE_VERSION, targets: [], state };
  }

  const validated = validateChannelSyncTargetInput({
    name: host,
    host,
    sshUser: "root",
    servicePort,
  });
  if (!validated.ok) return { version: STORE_VERSION, targets: [], state };

  const target: ChannelSyncTarget = {
    id: randomUUID(),
    ...validated.value,
    encryptedToken: token ? encryptSecret(token) : undefined,
    // 旧版只有一个全局状态，迁移时归到这个目标上。
    lastBackupAt: state.lastBackupAt,
    lastBackupRevision: state.lastBackupRevision,
    lastPullAt: state.lastPullAt,
  };
  return {
    version: STORE_VERSION,
    activeTargetId: target.id,
    targets: [target],
    state,
  };
}

async function readStored(): Promise<StoredFile> {
  let raw: string;
  try {
    raw = await readFile(getSyncFilePath(), "utf8");
  } catch {
    return emptyFile();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return emptyFile();
  }
  if (!isRecord(parsed)) return emptyFile();

  if (parsed.version === STORE_VERSION && Array.isArray(parsed.targets)) {
    const targets = parsed.targets
      .map(normalizeTarget)
      .filter((target): target is ChannelSyncTarget => !!target);
    const activeTargetId =
      typeof parsed.activeTargetId === "string" && targets.some((t) => t.id === parsed.activeTargetId)
        ? parsed.activeTargetId
        : targets[0]?.id;
    // 不能把遗留的全局状态猜给某个目标：真实版本一律以服务器为准
    // （见 fetchServerSnapshotMeta），否则切换目标后会显示别人的备份号。
    return { version: STORE_VERSION, targets, activeTargetId, state: sanitizeState(parsed.state) };
  }

  return migrateLegacy(parsed);
}

async function writeStored(file: StoredFile) {
  const filePath = getSyncFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function mutateStored(update: (current: StoredFile) => StoredFile): Promise<StoredFile> {
  return queueNamedWrite(QUEUE_KEY, async () => {
    const current = await readStored();
    const next = update(current);
    await writeStored(next);
    return next;
  });
}

function activeTarget(file: StoredFile): ChannelSyncTarget | undefined {
  return file.targets.find((target) => target.id === file.activeTargetId) || file.targets[0];
}

function toView(
  target: ChannelSyncTarget,
  activeId: string | undefined,
  activeToken: string | undefined,
): ChannelSyncTargetView {
  const isActive = target.id === activeId;
  return {
    id: target.id,
    name: target.name,
    host: target.host,
    sshPort: target.sshPort,
    sshUser: target.sshUser,
    hasPassword: !!target.encryptedPassword,
    servicePort: target.servicePort,
    deployPath: target.deployPath,
    image: target.image,
    serviceUrl: buildChannelSyncServiceUrl(target.host, target.servicePort),
    hostFingerprint: target.hostFingerprint,
    lastDeployAt: target.lastDeployAt,
    lastCheckAt: target.lastCheckAt,
    lastStatus: target.lastStatus || "unknown",
    lastError: target.lastError,
    lastBackupAt: target.lastBackupAt,
    lastBackupRevision: target.lastBackupRevision,
    lastPullAt: target.lastPullAt,
    isActive,
    tokenPreview: isActive && activeToken ? maskChannelSyncToken(activeToken) : undefined,
  };
}

async function buildViews(file: StoredFile): Promise<ChannelSyncTargetView[]> {
  const active = activeTarget(file);
  const activeToken = active ? decryptSecret(active.encryptedToken) : undefined;
  return file.targets.map((target) => toView(target, file.activeTargetId, activeToken));
}

function resolvePassword(target: ChannelSyncTarget, override?: unknown): string | undefined {
  if (typeof override === "string" && override) return override;
  return decryptSecret(target.encryptedPassword);
}

function credentialOf(target: ChannelSyncTarget, password: string) {
  return {
    host: target.host,
    port: target.sshPort,
    username: target.sshUser,
    password,
  };
}

function serviceEndpoint(target: ChannelSyncTarget): ServiceEndpoint | null {
  const token = decryptSecret(target.encryptedToken);
  if (!token) return null;
  return {
    serviceUrl: buildChannelSyncServiceUrl(target.host, target.servicePort),
    token,
  };
}

async function requestJson(
  endpoint: ServiceEndpoint,
  path: string,
  init: { method: string; body?: string } = { method: "GET" },
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${endpoint.serviceUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(describeChannelSyncNetworkError(error));
  }
  const text = await response.text();
  let body: unknown = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function requireOk(result: { status: number; body: unknown }) {
  if (result.status < 200 || result.status >= 300) {
    throw new ChannelSyncHttpError(result.status);
  }
}

/**
 * 读服务器上的真实版本号。
 *
 * 界面上的「服务器备份」必须是服务器的事实，而不是本机记忆：本机记录在
 * 多目标/重装/换机场景下都可能过期。
 */
async function fetchServerSnapshotMeta(
  endpoint: ServiceEndpoint,
): Promise<{ revision: number; savedAt?: string } | null> {
  try {
    const response = await fetch(`${endpoint.serviceUrl}${CHANNEL_SYNC_SNAPSHOTS_PATH}`, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body)) return null;
    const revision = Number.isInteger(body.currentRevision) ? Number(body.currentRevision) : 0;
    let savedAt: string | undefined;
    if (Array.isArray(body.snapshots)) {
      const latest = body.snapshots
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .sort((left, right) => Number(right.revision) - Number(left.revision))[0];
      if (latest && typeof latest.savedAt === "string" && Number(latest.revision) === revision) {
        savedAt = latest.savedAt;
      }
    }
    return { revision, savedAt };
  } catch {
    return null;
  }
}

function extractSnapshotMeta(body: unknown): { revision: number; savedAt: string } | null {
  if (!isRecord(body)) return null;
  if (!Number.isInteger(body.revision) || typeof body.savedAt !== "string") return null;
  return { revision: Number(body.revision), savedAt: body.savedAt };
}

/* ------------------------------------------------------------------ *
 * 目标管理
 * ------------------------------------------------------------------ */

export async function listChannelSyncTargets(): Promise<ChannelSyncTargetView[]> {
  return buildViews(await readStored());
}

export async function saveChannelSyncTarget(input: unknown): Promise<ChannelSyncTargetActionResult> {
  if (!isRecord(input)) return { success: false, error: "参数无效。" };

  const validated = validateChannelSyncTargetInput({
    name: typeof input.name === "string" ? input.name : "",
    host: typeof input.host === "string" ? input.host : "",
    sshPort: Number.isInteger(input.sshPort) ? Number(input.sshPort) : 22,
    sshUser: typeof input.sshUser === "string" ? input.sshUser : "",
    servicePort: Number.isInteger(input.servicePort)
      ? Number(input.servicePort)
      : CHANNEL_SYNC_DEFAULT_PORT,
    deployPath: typeof input.deployPath === "string" ? input.deployPath : undefined,
    image: typeof input.image === "string" ? input.image : undefined,
  });
  if (!validated.ok) return { success: false, error: validated.error };

  const passwordInput = typeof input.password === "string" ? input.password : undefined;
  let encryptedPassword: string | undefined;
  if (passwordInput) {
    encryptedPassword = encryptSecret(passwordInput);
    if (!encryptedPassword) {
      return { success: false, error: "系统安全存储不可用，无法保存 SSH 密码。" };
    }
  }

  // 界面上不提供手动填 Token：它会由部署流程写入。数据层保留这个入参，
  // 供将来「导入目标 / 从备份恢复」之类的场景复用。
  const tokenInput = typeof input.token === "string" ? input.token.trim() : undefined;
  let encryptedTokenInput: string | undefined;
  if (tokenInput) {
    encryptedTokenInput = encryptSecret(tokenInput);
    if (!encryptedTokenInput) {
      return { success: false, error: "系统安全存储不可用，无法保存服务 Token。" };
    }
  }

  const id = typeof input.id === "string" && input.id ? input.id : randomUUID();
  let savedId = id;

  try {
    const next = await mutateStored((current) => {
      const existing = current.targets.find((target) => target.id === id);
      savedId = existing?.id || id;
      const target: ChannelSyncTarget = {
        id: savedId,
        ...validated.value,
        // undefined 表示沿用已有密码；空字符串表示显式清除。
        encryptedPassword:
          passwordInput === undefined ? existing?.encryptedPassword : encryptedPassword,
        encryptedToken:
          tokenInput === undefined ? existing?.encryptedToken : encryptedTokenInput,
        hostFingerprint: existing?.hostFingerprint,
        lastDeployAt: existing?.lastDeployAt,
        lastCheckAt: existing?.lastCheckAt,
        lastStatus: existing?.lastStatus,
        lastError: existing?.lastError,
      };
      // SSH 地址变了，旧指纹不再可信；服务地址（host/servicePort）变了，
      // 旧 Token 也不再属于这台服务。单独改 SSH 端口不影响已部署的服务。
      if (
        existing &&
        (existing.host !== target.host ||
          existing.sshPort !== target.sshPort ||
          existing.servicePort !== target.servicePort)
      ) {
        target.hostFingerprint = undefined;
        target.lastStatus = "unknown";
      }
      if (
        existing &&
        tokenInput === undefined &&
        (existing.host !== target.host || existing.servicePort !== target.servicePort)
      ) {
        target.encryptedToken = undefined;
      }
      const targets = existing
        ? current.targets.map((item) => (item.id === savedId ? target : item))
        : [...current.targets, target];
      return {
        ...current,
        targets,
        activeTargetId: current.activeTargetId || savedId,
      };
    });
    const views = await buildViews(next);
    return { success: true, target: views.find((view) => view.id === savedId), targets: views };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function removeChannelSyncTarget(targetId: unknown): Promise<ChannelSyncTargetActionResult> {
  if (typeof targetId !== "string" || !targetId) {
    return { success: false, error: "目标不存在。" };
  }
  try {
    const next = await mutateStored((current) => {
      const targets = current.targets.filter((target) => target.id !== targetId);
      const activeTargetId =
        current.activeTargetId === targetId ? targets[0]?.id : current.activeTargetId;
      return { ...current, targets, activeTargetId };
    });
    return { success: true, targets: await buildViews(next) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function setActiveChannelSyncTarget(
  targetId: unknown,
): Promise<ChannelSyncTargetActionResult> {
  if (typeof targetId !== "string" || !targetId) {
    return { success: false, error: "目标不存在。" };
  }
  try {
    const next = await mutateStored((current) => {
      if (!current.targets.some((target) => target.id === targetId)) return current;
      return { ...current, activeTargetId: targetId };
    });
    return { success: true, targets: await buildViews(next) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ *
 * 状态与连接
 * ------------------------------------------------------------------ */

/** 当前激活目标的同步状态，兼容旧版单目标界面。 */
export async function getChannelSyncStatus(): Promise<ChannelSyncStatus> {
  const file = await readStored();
  const target = activeTarget(file);
  if (!target) {
    return {
      configured: false,
      baseUrl: "",
      tokenSet: false,
      lastBackupAt: file.state.lastBackupAt,
      lastBackupRevision: file.state.lastBackupRevision,
      lastPullAt: file.state.lastPullAt,
      lastError: file.state.lastError,
    };
  }
  const token = decryptSecret(target.encryptedToken);
  const endpoint = token
    ? { serviceUrl: buildChannelSyncServiceUrl(target.host, target.servicePort), token }
    : null;
  // 有 Token 就问一次服务器；问不到（离线/未部署）才退回本地记录。
  const remote = endpoint ? await fetchServerSnapshotMeta(endpoint) : null;
  return {
    configured: !!token,
    activeTargetId: target.id,
    baseUrl: buildChannelSyncServiceUrl(target.host, target.servicePort),
    tokenSet: !!token,
    tokenPreview: token ? maskChannelSyncToken(token) : undefined,
    // 服务器读得到就以服务器为准；0 表示服务器上确实没有备份。
    lastBackupRevision: remote
      ? remote.revision > 0
        ? remote.revision
        : undefined
      : target.lastBackupRevision,
    lastBackupAt: remote
      ? remote.revision > 0
        ? remote.savedAt || target.lastBackupAt
        : undefined
      : target.lastBackupAt,
    lastPullAt: target.lastPullAt,
    lastError: target.lastError || file.state.lastError,
  };
}

/** 只测 HTTP 服务，不涉及 SSH。 */
export async function testChannelSyncConnection(): Promise<ChannelSyncTestResult> {
  const file = await readStored();
  const target = activeTarget(file);
  if (!target) return { success: false, error: "还没有添加渠道配置服务器。" };
  const endpoint = serviceEndpoint(target);
  if (!endpoint) return { success: false, error: "当前目标还没有服务 Token，请先部署或填写。" };
  try {
    const result = await requestJson(endpoint, "/health");
    requireOk(result);
    if (!isRecord(result.body) || result.body.ok !== true) {
      return { success: false, error: "服务响应格式不符合预期，确认地址指向 hpp-channel-sync。" };
    }
    const revision = Number.isInteger(result.body.revision) ? Number(result.body.revision) : 0;
    return { success: true, revision };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * SSH 环境探测：不改远端任何东西，只回报能不能部署。
 * 首次成功探测会记录主机指纹，之后指纹变化会被拒绝。
 */
export async function probeChannelSyncTargetById(
  targetId: unknown,
  overridePassword?: unknown,
): Promise<ChannelSyncProbeResult> {
  if (typeof targetId !== "string" || !targetId) {
    return { success: false, error: "目标不存在。" };
  }
  const file = await readStored();
  const target = file.targets.find((item) => item.id === targetId);
  if (!target) return { success: false, error: "目标不存在。" };

  const password = resolvePassword(target, overridePassword);
  if (!password) return { success: false, error: "请填写 SSH 密码。" };

  const result = await probeChannelSyncTarget({
    credential: credentialOf(target, password),
    servicePort: target.servicePort,
    deployPath: target.deployPath,
    image: target.image,
    expectedFingerprint: target.hostFingerprint,
  });

  if (result.hostFingerprint && !target.hostFingerprint) {
    await mutateStored((current) => ({
      ...current,
      targets: current.targets.map((item) =>
        item.id === target.id ? { ...item, hostFingerprint: result.hostFingerprint } : item,
      ),
    }));
  }

  return result;
}

/** 检查「是否已部署 / 是否在跑」，HTTP 优先、失败再 SSH。 */
export async function checkChannelSyncTargetById(
  targetId: unknown,
  overridePassword?: unknown,
): Promise<ChannelSyncCheckResult> {
  if (typeof targetId !== "string" || !targetId) {
    return { success: false, status: "unknown", error: "目标不存在。" };
  }
  const file = await readStored();
  const target = file.targets.find((item) => item.id === targetId);
  if (!target) return { success: false, status: "unknown", error: "目标不存在。" };

  const password = resolvePassword(target, overridePassword);
  const result = await checkChannelSyncTarget({
    credential: password ? credentialOf(target, password) : undefined,
    serviceUrl: buildChannelSyncServiceUrl(target.host, target.servicePort),
    expectedFingerprint: target.hostFingerprint,
    image: target.image,
    servicePort: target.servicePort,
    deployPath: target.deployPath,
  });

  await mutateStored((current) => ({
    ...current,
    targets: current.targets.map((item) =>
      item.id === target.id
        ? {
            ...item,
            lastCheckAt: result.checkedAt || new Date().toISOString(),
            lastStatus: result.status,
            lastError: result.error,
          }
        : item,
    ),
  }));

  return result;
}

/* ------------------------------------------------------------------ *
 * 部署
 * ------------------------------------------------------------------ */

export type ChannelSyncDeployListener = (event: ChannelSyncDeployEvent) => void;

/**
 * 部署或更新服务。幂等：已有容器会重建，`data/` 卷保留。
 * 首次部署生成 Token 并加密保存；后续更新沿用原 Token。
 */
export async function deployChannelSyncTargetById(
  targetId: unknown,
  overridePassword?: unknown,
  onEvent?: ChannelSyncDeployListener,
): Promise<ChannelSyncDeployResult> {
  if (typeof targetId !== "string" || !targetId) {
    return { success: false, error: "目标不存在。" };
  }
  const file = await readStored();
  const target = file.targets.find((item) => item.id === targetId);
  if (!target) return { success: false, error: "目标不存在。" };

  const password = resolvePassword(target, overridePassword);
  if (!password) return { success: false, error: "请填写 SSH 密码。" };

  let serverSource: string;
  try {
    serverSource = await readNasServerSource();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  const existingToken = decryptSecret(target.encryptedToken);
  const token = existingToken || createChannelSyncToken();
  const serviceUrl = buildChannelSyncServiceUrl(target.host, target.servicePort);

  const outcome = await deployChannelSyncService({
    credential: credentialOf(target, password),
    servicePort: target.servicePort,
    deployPath: target.deployPath,
    image: target.image,
    token,
    serverSource,
    serviceUrl,
    expectedFingerprint: target.hostFingerprint,
    onEvent,
  });

  const encryptedToken = outcome.success
    ? encryptSecret(token) || target.encryptedToken
    : target.encryptedToken;

  try {
    const next = await mutateStored((current) => ({
      ...current,
      // 部署成功就把当前目标切到它：否则界面状态卡片还在读另一个目标，
      // 表现为「部署成功了但 Token 显示未保存」。
      activeTargetId: outcome.success ? target.id : current.activeTargetId || target.id,
      targets: current.targets.map((item) =>
        item.id === target.id
          ? {
              ...item,
              // 首次连接成功后记录指纹；后续不匹配时连接不会成功，也不会覆盖。
              hostFingerprint: outcome.fingerprint
                ? item.hostFingerprint || outcome.fingerprint
                : item.hostFingerprint,
              encryptedToken,
              lastDeployAt: outcome.success ? new Date().toISOString() : item.lastDeployAt,
              lastStatus: outcome.success ? "running" : item.lastStatus,
              lastError: outcome.error,
            }
          : item,
      ),
    }));
    const views = await buildViews(next);
    return {
      success: outcome.success,
      error: outcome.error,
      target: views.find((view) => view.id === target.id),
    };
  } catch (error) {
    return {
      success: outcome.success,
      error: outcome.error || (error instanceof Error ? error.message : String(error)),
    };
  }
}

/* ------------------------------------------------------------------ *
 * 卸载远端部署
 * ------------------------------------------------------------------ */

/**
 * 删除远端容器。默认保留 `data/` 里的备份，只有 removeData 为真时才删目录。
 * 成功后清掉本地 Token（服务已经没了，旧 Token 不再可用）。
 */
export async function undeployChannelSyncTargetById(
  targetId: unknown,
  options: ChannelSyncUndeployOptions = {},
): Promise<ChannelSyncTargetActionResult> {
  if (typeof targetId !== "string" || !targetId) {
    return { success: false, error: "目标不存在。" };
  }
  const file = await readStored();
  const target = file.targets.find((item) => item.id === targetId);
  if (!target) return { success: false, error: "目标不存在。" };

  const password = resolvePassword(target, options.password);
  if (!password) return { success: false, error: "请填写 SSH 密码。" };

  const outcome = await undeployChannelSyncService({
    credential: credentialOf(target, password),
    deployPath: target.deployPath,
    removeData: options.removeData === true,
    expectedFingerprint: target.hostFingerprint,
  });

  const checkedAt = new Date().toISOString();
  const next = await mutateStored((current) => ({
    ...current,
    targets: current.targets.map((item) =>
      item.id === target.id
        ? {
            ...item,
            lastCheckAt: checkedAt,
            lastStatus: outcome.success ? "not_deployed" : item.lastStatus,
            lastError: outcome.success ? undefined : outcome.error,
            // 容器被删除后旧 Token 一定失效，避免下次误用它去备份。
            encryptedToken: outcome.success ? undefined : item.encryptedToken,
          }
        : item,
    ),
  }));

  return {
    success: outcome.success,
    error: outcome.error,
    targets: await buildViews(next),
  };
}

/* ------------------------------------------------------------------ *
 * 备份 / 拉取
 * ------------------------------------------------------------------ */

/** 上传当前所有渠道。payload 必须是合法的 Hpp 导出结构。 */
export async function backupChannelConfigs(payload: unknown): Promise<ChannelSyncBackupResult> {
  if (!isValidAgentConfigExport(payload)) {
    return { success: false, error: "配置包格式无效，未上传。", agentCount: 0, providerCount: 0 };
  }
  const { agentCount, providerCount } = countChannelSyncProviders(payload);
  if (providerCount === 0) {
    return { success: false, error: "当前没有可备份的渠道。", agentCount, providerCount };
  }

  const file = await readStored();
  const target = activeTarget(file);
  if (!target) {
    return { success: false, error: "还没有添加渠道配置服务器。", agentCount, providerCount };
  }
  const endpoint = serviceEndpoint(target);
  if (!endpoint) {
    return {
      success: false,
      error: "当前目标还没有服务 Token，请先部署或填写。",
      agentCount,
      providerCount,
    };
  }

  try {
    const result = await requestJson(endpoint, CHANNEL_SYNC_SNAPSHOT_PATH, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    requireOk(result);
    const meta = extractSnapshotMeta(result.body);
    if (!meta) throw new Error("服务器返回的时间戳格式无效。");

    await mutateStored((current) => ({
      ...current,
      state: { ...current.state, lastError: undefined },
      targets: current.targets.map((item) =>
        item.id === target.id
          ? {
              ...item,
              lastBackupAt: meta.savedAt,
              lastBackupRevision: meta.revision,
              lastError: undefined,
            }
          : item,
      ),
    }));
    return { success: true, ...meta, agentCount, providerCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateStored((current) => ({
      ...current,
      state: { ...current.state, lastError: message },
      targets: current.targets.map((item) =>
        item.id === target.id ? { ...item, lastError: message } : item,
      ),
    })).catch(() => undefined);
    return { success: false, error: message, agentCount, providerCount };
  }
}

/** 下载最新快照；写本地配置仍走渲染端的冲突确认流程。 */
export async function pullChannelConfigs(): Promise<ChannelSyncPullResult> {
  const file = await readStored();
  const target = activeTarget(file);
  if (!target) return { success: false, error: "还没有添加渠道配置服务器。" };
  const endpoint = serviceEndpoint(target);
  if (!endpoint) {
    return { success: false, error: "当前目标还没有服务 Token，请先部署或填写。" };
  }

  try {
    const result = await requestJson(endpoint, CHANNEL_SYNC_SNAPSHOT_PATH);
    requireOk(result);
    if (!isRecord(result.body) || !isValidAgentConfigExport(result.body.payload)) {
      return { success: false, error: "服务器上的数据不是有效的 Hpp 渠道配置包。" };
    }
    const meta = extractSnapshotMeta(result.body);
    if (!meta) return { success: false, error: "服务器返回的快照元信息无效。" };

    const pulledAt = new Date().toISOString();
    await mutateStored((current) => ({
      ...current,
      state: { ...current.state, lastError: undefined },
      targets: current.targets.map((item) =>
        item.id === target.id
          ? { ...item, lastPullAt: pulledAt, lastError: undefined }
          : item,
      ),
    }));
    return {
      success: true,
      snapshot: meta,
      data: result.body.payload as AgentConfigExportData,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateStored((current) => ({
      ...current,
      state: { ...current.state, lastError: message },
      targets: current.targets.map((item) =>
        item.id === target.id ? { ...item, lastError: message } : item,
      ),
    })).catch(() => undefined);
    return { success: false, error: message };
  }
}

/** 让渲染端能手动清除指纹（换机器 / 重装系统后）。 */
export async function clearChannelSyncTargetFingerprint(
  targetId: unknown,
): Promise<ChannelSyncTargetActionResult> {
  if (typeof targetId !== "string" || !targetId) {
    return { success: false, error: "目标不存在。" };
  }
  const next = await mutateStored((current) => ({
    ...current,
    targets: current.targets.map((item) =>
      item.id === targetId ? { ...item, hostFingerprint: undefined } : item,
    ),
  }));
  return { success: true, targets: await buildViews(next) };
}

/**
 * IPC 边界兜底：任何未预期异常都必须变成结果对象。
 *
 * 没有这一层时，SSH 相关的底层错误（例如连接在握手阶段被对端打断）会以
 * 未捕获异常的形式冒到 Electron 主进程，弹出「A JavaScript error occurred
 * in the main process」并中断当前操作。
 */
function guard<T extends { success: boolean; error?: string }>(
  label: string,
  fallback: T,
  run: () => Promise<T>,
): Promise<T> {
  return run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Hpp] channelSync:${label} 失败`, error);
    return { ...fallback, success: false, error: message || "操作失败。" } as T;
  });
}

export function registerChannelSyncHandlers(): void {
  ipcMain.handle("channelSync:getStatus", () =>
    guard("getStatus", { success: true, status: undefined } as never, async () =>
      getChannelSyncStatus() as never,
    ),
  );
  ipcMain.handle("channelSync:listTargets", () =>
    guard("listTargets", { success: true, targets: [] as ChannelSyncTargetView[] } as never, async () =>
      listChannelSyncTargets() as never,
    ),
  );
  ipcMain.handle("channelSync:saveTarget", (_event, input: unknown) =>
    guard(
      "saveTarget",
      { success: false, error: "保存失败。" } as ChannelSyncTargetActionResult,
      () => saveChannelSyncTarget(input),
    ),
  );
  ipcMain.handle("channelSync:removeTarget", (_event, targetId: unknown) =>
    guard(
      "removeTarget",
      { success: false, error: "删除失败。" } as ChannelSyncTargetActionResult,
      () => removeChannelSyncTarget(targetId),
    ),
  );
  ipcMain.handle("channelSync:setActiveTarget", (_event, targetId: unknown) =>
    guard(
      "setActiveTarget",
      { success: false, error: "切换失败。" } as ChannelSyncTargetActionResult,
      () => setActiveChannelSyncTarget(targetId),
    ),
  );
  ipcMain.handle("channelSync:clearFingerprint", (_event, targetId: unknown) =>
    guard(
      "clearFingerprint",
      { success: false, error: "清除失败。" } as ChannelSyncTargetActionResult,
      () => clearChannelSyncTargetFingerprint(targetId),
    ),
  );
  ipcMain.handle("channelSync:test", () =>
    guard("test", { success: false, error: "连接测试失败。" } as ChannelSyncTestResult, () =>
      testChannelSyncConnection(),
    ),
  );
  ipcMain.handle("channelSync:probeTarget", (_event, targetId: unknown, password: unknown) =>
    guard(
      "probeTarget",
      { success: false, error: "探测失败。" } as ChannelSyncProbeResult,
      () => probeChannelSyncTargetById(targetId, password),
    ),
  );
  ipcMain.handle("channelSync:checkTarget", (_event, targetId: unknown, password: unknown) =>
    guard(
      "checkTarget",
      { success: false, status: "unknown", error: "检查失败。" } as ChannelSyncCheckResult,
      () => checkChannelSyncTargetById(targetId, password),
    ),
  );
  ipcMain.handle("channelSync:deployTarget", (event, targetId: unknown, password: unknown) =>
    guard(
      "deployTarget",
      { success: false, error: "部署失败。" } as ChannelSyncDeployResult,
      () =>
        deployChannelSyncTargetById(targetId, password, (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("channelSync:deployProgress", { targetId, ...progress });
          }
        }),
    ),
  );
  ipcMain.handle(
    "channelSync:undeployTarget",
    (_event, targetId: unknown, options: ChannelSyncUndeployOptions) =>
      guard(
        "undeployTarget",
        { success: false, error: "卸载失败。" } as ChannelSyncTargetActionResult,
        () => undeployChannelSyncTargetById(targetId, options),
      ),
  );
  ipcMain.handle("channelSync:backup", (_event, payload: unknown) =>
    guard(
      "backup",
      { success: false, error: "备份失败。", agentCount: 0, providerCount: 0 } as ChannelSyncBackupResult,
      () => backupChannelConfigs(payload),
    ),
  );
  ipcMain.handle("channelSync:pull", () =>
    guard("pull", { success: false, error: "拉取失败。" } as ChannelSyncPullResult, () =>
      pullChannelConfigs(),
    ),
  );
}
