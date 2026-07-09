import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type {
  AgentCapabilities,
  AgentPlanModeSupport,
  OfficialAgentPluginCatalogResult,
  OfficialAgentPluginDescriptor,
} from "../../src/types/ipc";

export const OFFICIAL_RELEASE_DOWNLOAD_BASE_URL =
  "https://github.com/xhaoh94/Hpp/releases/latest/download";
export const OFFICIAL_PLUGIN_CATALOG_URL =
  `${OFFICIAL_RELEASE_DOWNLOAD_BASE_URL}/agent-plugins.json`;

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<FetchLikeResponse>;

const DEFAULT_CAPABILITIES: AgentCapabilities = {
  planMode: "prompt",
  guidance: false,
  fork: false,
  configuration: "none",
  providerActivation: "none",
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatHttpStatus(status: number, statusText?: string): string {
  const knownStatusText: Record<number, string> = {
    400: "请求错误",
    401: "未授权",
    403: "无权限",
    404: "未找到",
    500: "服务器错误",
    502: "网关错误",
    503: "服务不可用",
    504: "网关超时",
  };
  return `${status} ${knownStatusText[status] || statusText?.trim() || "请求失败"}`;
}

function normalizePlanMode(value: unknown): AgentPlanModeSupport {
  if (value === "native" || value === "prompt" || value === "none") return value;
  if (value === false) return "none";
  return DEFAULT_CAPABILITIES.planMode;
}

function normalizeCapabilities(value: unknown): AgentCapabilities {
  const input = isRecord(value) ? value : {};
  return {
    planMode: normalizePlanMode(input.planMode),
    guidance: input.guidance === true,
    fork: input.fork === true,
    configuration: input.configuration === "openai-compatible" ? "openai-compatible" : "none",
    providerActivation: input.providerActivation === "single-active" ? "single-active" : "none",
  };
}

function ensureAgentId(id: string) {
  if (!/^[a-zA-Z0-9._:-]+$/.test(id)) {
    throw new Error(`官方插件 ID 非法：${id}`);
  }
}

function ensureSafeZipFile(zipFile: string) {
  if (!zipFile || zipFile.includes("/") || zipFile.includes("\\") || !zipFile.endsWith(".zip")) {
    throw new Error(`官方插件 ZIP 文件名非法：${zipFile || "空"}`);
  }
}

function parseOfficialUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`官方插件 URL 非法：${rawUrl || "空"}`);
  }

  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error(`官方插件 URL 必须使用 https://github.com/xhaoh94/Hpp：${rawUrl}`);
  }

  const prefix = "/xhaoh94/Hpp/releases/latest/download/";
  if (!url.pathname.startsWith(prefix)) {
    throw new Error(`官方插件 URL 必须来自 xhaoh94/Hpp 最新 Release：${rawUrl}`);
  }
  return url;
}

export function isAllowedOfficialPluginUrl(rawUrl: string, expectedZipFile?: string): boolean {
  try {
    const url = parseOfficialUrl(rawUrl);
    if (expectedZipFile && url.pathname !== `/xhaoh94/Hpp/releases/latest/download/${expectedZipFile}`) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function ensureAllowedOfficialPluginUrl(rawUrl: string, expectedZipFile?: string) {
  const url = parseOfficialUrl(rawUrl);
  if (expectedZipFile && url.pathname !== `/xhaoh94/Hpp/releases/latest/download/${expectedZipFile}`) {
    throw new Error(`官方插件 URL 与 ZIP 文件名不匹配：${rawUrl}`);
  }
}

function ensureOfficialCatalogUrl(rawUrl: string) {
  const url = parseOfficialUrl(rawUrl);
  if (url.pathname !== "/xhaoh94/Hpp/releases/latest/download/agent-plugins.json") {
    throw new Error(`官方插件目录 URL 不允许：${rawUrl}`);
  }
}

export function validateOfficialPluginCatalog(
  value: unknown,
  sourceUrl = OFFICIAL_PLUGIN_CATALOG_URL
): OfficialAgentPluginDescriptor[] {
  ensureOfficialCatalogUrl(sourceUrl);
  if (!isRecord(value)) throw new Error("官方插件目录必须是 JSON 对象。");
  if (value.schemaVersion !== 1) throw new Error("官方插件目录 schemaVersion 必须为 1。");
  if (!Array.isArray(value.plugins)) throw new Error("官方插件目录必须包含 plugins 数组。");

  const seenIds = new Set<string>();
  return value.plugins.map((rawPlugin, index) => {
    if (!isRecord(rawPlugin)) throw new Error(`官方插件目录第 ${index} 项必须是对象。`);

    const id = asString(rawPlugin.id);
    const name = asString(rawPlugin.name);
    const version = asString(rawPlugin.version);
    const zipFile = asString(rawPlugin.zipFile);
    const downloadUrl = asString(rawPlugin.downloadUrl);
    if (!id) throw new Error(`官方插件目录第 ${index} 项缺少 id。`);
    ensureAgentId(id);
    if (seenIds.has(id)) throw new Error(`官方插件 ID 重复：${id}`);
    seenIds.add(id);
    if (!name) throw new Error(`官方插件 ${id} 缺少 name。`);
    if (!version) throw new Error(`官方插件 ${id} 缺少 version。`);
    ensureSafeZipFile(zipFile);
    ensureAllowedOfficialPluginUrl(downloadUrl, zipFile);

    const runtime = rawPlugin.runtime === "cli" || rawPlugin.runtime === "sdk"
      ? rawPlugin.runtime
      : "plugin";

    return {
      id,
      name,
      version,
      description: asString(rawPlugin.description) || undefined,
      runtime,
      command: asString(rawPlugin.command) || undefined,
      packageName: asString(rawPlugin.packageName) || undefined,
      capabilities: normalizeCapabilities(rawPlugin.capabilities),
      zipFile,
      downloadUrl,
    };
  });
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export async function listOfficialAgentPlugins(
  fetchImpl: FetchLike = defaultFetch,
  sourceUrl = OFFICIAL_PLUGIN_CATALOG_URL
): Promise<OfficialAgentPluginCatalogResult> {
  try {
    ensureOfficialCatalogUrl(sourceUrl);
    const response = await fetchImpl(sourceUrl, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`下载官方插件目录失败（${formatHttpStatus(response.status, response.statusText)}）。`);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error("官方插件目录不是有效 JSON。");
    }
    return {
      success: true,
      plugins: validateOfficialPluginCatalog(json, sourceUrl),
      sourceUrl,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
      plugins: [],
      sourceUrl,
    };
  }
}

export async function downloadOfficialPluginZip(
  plugin: OfficialAgentPluginDescriptor,
  tempDir: string,
  fetchImpl: FetchLike = defaultFetch
): Promise<string> {
  ensureAgentId(plugin.id);
  ensureSafeZipFile(plugin.zipFile);
  ensureAllowedOfficialPluginUrl(plugin.downloadUrl, plugin.zipFile);

  const response = await fetchImpl(plugin.downloadUrl, {
    headers: { Accept: "application/zip, application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error(`下载 ${plugin.name} 失败（${formatHttpStatus(response.status, response.statusText)}）。`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error(`${plugin.name} 下载的 ZIP 文件为空。`);

  await mkdir(tempDir, { recursive: true });
  const zipPath = join(tempDir, `${plugin.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  await writeFile(zipPath, buffer);
  return zipPath;
}
