import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type {
  AgentCapabilities,
  AgentPlanModeSupport,
  AgentProviderConfiguration,
  OfficialAgentPluginCatalogResult,
  OfficialAgentPluginDescriptor,
} from "../../src/types/ipc";
import { isValidVersion, meetsMinimumVersion } from "../../src/lib/version";
import { asString, getErrorMessage, isRecord } from "../utils/unknown-value";

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
  actions: false,
  configuration: "none",
  providerActivation: "none",
};

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

function normalizeProviderConfiguration(value: unknown): AgentProviderConfiguration | "none" {
  if (!isRecord(value) || value.type !== "provider" || !Array.isArray(value.endpoints)) return "none";
  const seenEndpoints = new Set<string>();
  const endpoints = value.endpoints.flatMap((rawEndpoint) => {
    if (!isRecord(rawEndpoint)) return [];
    const id = asString(rawEndpoint.id);
    if (!id || seenEndpoints.has(id)) return [];
    seenEndpoints.add(id);
    return [{ id, label: asString(rawEndpoint.label) || id }];
  });
  if (endpoints.length === 0) return "none";

  const defaultEndpoint = asString(value.defaultEndpoint);
  const seenAuthModes = new Set<string>();
  const authModes = Array.isArray(value.authModes)
    ? value.authModes.flatMap((rawAuthMode) => {
        if (!isRecord(rawAuthMode)) return [];
        const id = asString(rawAuthMode.id);
        if ((id !== "bearer" && id !== "x-api-key") || seenAuthModes.has(id)) return [];
        seenAuthModes.add(id);
        return [{ id, label: asString(rawAuthMode.label) || id }];
      })
    : [];
  const defaultAuthMode = asString(value.defaultAuthMode);
  const modelDefaults = isRecord(value.modelDefaults) ? value.modelDefaults : {};
  const modelListMode = value.modelListMode === "configured" || value.modelListMode === "backend"
    ? value.modelListMode
    : "merge";
  const rawBackendModelVisibility = isRecord(value.backendModelVisibility)
    ? value.backendModelVisibility
    : undefined;
  return {
    type: "provider",
    storage: value.storage === "plugin" ? "plugin" : "hpp",
    endpoints,
    defaultEndpoint: endpoints.some((endpoint) => endpoint.id === defaultEndpoint)
      ? defaultEndpoint
      : endpoints[0].id,
    authModes: authModes.length > 0 ? authModes : undefined,
    defaultAuthMode: authModes.some((mode) => mode.id === defaultAuthMode)
      ? defaultAuthMode as "bearer" | "x-api-key"
      : authModes[0]?.id,
    pathLabel: asString(value.pathLabel) || undefined,
    hint: asString(value.hint) || undefined,
    modelDefaults: {
      reasoning: modelDefaults.reasoning === true,
      imageInput: modelDefaults.imageInput === true,
      supportedThinkingLevels: Array.isArray(modelDefaults.supportedThinkingLevels)
        ? modelDefaults.supportedThinkingLevels.filter((level): level is string =>
            typeof level === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(level))
        : undefined,
    },
    fixedModelCapabilities: value.fixedModelCapabilities === true,
    modelListMode,
    backendModelVisibility: modelListMode === "merge" && rawBackendModelVisibility
      ? {
          userConfigurable: rawBackendModelVisibility.userConfigurable === true,
          defaultVisible: rawBackendModelVisibility.defaultVisible !== false,
          label: asString(rawBackendModelVisibility.label) || "显示 Agent 内置模型",
          description: asString(rawBackendModelVisibility.description) || undefined,
        }
      : undefined,
  };
}

function normalizeCapabilities(value: unknown): AgentCapabilities {
  const input = isRecord(value) ? value : {};
  return {
    planMode: normalizePlanMode(input.planMode),
    guidance: input.guidance === true,
    fork: input.fork === true,
    actions: input.actions === true,
    configuration: normalizeProviderConfiguration(input.configuration),
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
  currentHppVersion: string,
  sourceUrl = OFFICIAL_PLUGIN_CATALOG_URL
): OfficialAgentPluginDescriptor[] {
  ensureOfficialCatalogUrl(sourceUrl);
  if (!isRecord(value)) throw new Error("官方插件目录必须是 JSON 对象。");
  if (value.schemaVersion === 1) {
    throw new Error("GitHub 上还是旧版官方插件列表，请先发布当前版本生成的插件包，然后点击刷新。");
  }
  if (value.schemaVersion !== 2) {
    throw new Error("官方插件列表与当前 Hpp 版本不兼容，请更新 Hpp 后重试。");
  }
  if (!Array.isArray(value.plugins)) throw new Error("官方插件目录必须包含 plugins 数组。");
  if (!isValidVersion(currentHppVersion)) throw new Error(`当前 Hpp 版本号无效：${currentHppVersion}`);

  const seenIds = new Set<string>();
  return value.plugins.map((rawPlugin, index) => {
    if (!isRecord(rawPlugin)) throw new Error(`官方插件目录第 ${index} 项必须是对象。`);

    const id = asString(rawPlugin.id);
    const name = asString(rawPlugin.name);
    const version = asString(rawPlugin.version);
    const minHppVersion = asString(rawPlugin.minHppVersion);
    const zipFile = asString(rawPlugin.zipFile);
    const downloadUrl = asString(rawPlugin.downloadUrl);
    if (!id) throw new Error(`官方插件目录第 ${index} 项缺少 id。`);
    ensureAgentId(id);
    if (seenIds.has(id)) throw new Error(`官方插件 ID 重复：${id}`);
    seenIds.add(id);
    if (!name) throw new Error(`官方插件 ${id} 缺少 name。`);
    if (!version) throw new Error(`官方插件 ${id} 缺少 version。`);
    if (!isValidVersion(version)) throw new Error(`官方插件 ${id} 的 version 无效：${version || "空"}`);
    if (!minHppVersion) throw new Error(`官方插件 ${id} 缺少 minHppVersion。`);
    if (!isValidVersion(minHppVersion)) {
      throw new Error(`官方插件 ${id} 的 minHppVersion 无效：${minHppVersion}`);
    }
    ensureSafeZipFile(zipFile);
    ensureAllowedOfficialPluginUrl(downloadUrl, zipFile);

    const compatible = meetsMinimumVersion(currentHppVersion, minHppVersion);

    const runtime = rawPlugin.runtime === "cli" || rawPlugin.runtime === "sdk"
      ? rawPlugin.runtime
      : "plugin";

    return {
      id,
      name,
      version,
      minHppVersion,
      compatible,
      compatibilityError: compatible
        ? undefined
        : `需要 Hpp v${minHppVersion} 或更高版本，当前为 v${currentHppVersion}。`,
      description: asString(rawPlugin.description) || undefined,
      runtime,
      command: asString(rawPlugin.command) || undefined,
      packageName: asString(rawPlugin.packageName) || undefined,
      order: typeof rawPlugin.order === "number" && Number.isFinite(rawPlugin.order) ? rawPlugin.order : 1000,
      installHint: asString(rawPlugin.installHint) || undefined,
      updateCommand: asString(rawPlugin.updateCommand) || undefined,
      shortName: asString(rawPlugin.shortName) || undefined,
      capabilities: normalizeCapabilities(rawPlugin.capabilities),
      zipFile,
      downloadUrl,
    };
  });
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export async function listOfficialAgentPlugins(
  currentHppVersion: string,
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
      plugins: validateOfficialPluginCatalog(json, currentHppVersion, sourceUrl),
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
  if (!plugin.compatible) {
    throw new Error(plugin.compatibilityError || `${plugin.name} 与当前 Hpp 版本不兼容。`);
  }
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
