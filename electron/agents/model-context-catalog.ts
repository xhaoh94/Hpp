/**
 * 主进程侧的模型上下文窗口目录：内置快照 + 每日刷新 + 统一解析。
 *
 * 目录数据来源 models.dev（与 pi 内置 catalogue 同源），构建时由
 * `scripts/build-model-catalog.mjs` 生成 `resources/model-context-catalog.json`，
 * 打包时复制到 `out/main/model-context-catalog.json`。运行时优先读
 * `<data>/model-context-catalog.json`（每日刷新写入的那份），失败则回退内置快照，
 * 所以离线、抓取失败都不会让窗口变空。
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import {
  MODEL_CONTEXT_CATALOG_VERSION,
  compactModelContextCatalog,
  resolveModelContextWindow as resolveFromCatalog,
  shouldRefreshModelContextCatalog,
  type ModelContextCatalogData,
  type ModelContextWindowResolution,
} from "../../shared/model-context-catalog";

const CATALOG_FILE = "model-context-catalog.json";
const SOURCE_URL = "https://models.dev/api.json";
/** 目录刷新间隔：一天一次足够，模型窗口不会在小时级别变化。 */
export const MODEL_CONTEXT_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
/** 抓取结果的基本体检：models.dev 目前是 300+ provider / 10000+ 模型，
 *  明显少于这个量级说明拿到了残缺响应，宁可继续用旧数据。 */
const MIN_PROVIDER_COUNT = 100;
const MIN_MODEL_COUNT = 1000;

interface LoadedCatalog {
  data: ModelContextCatalogData;
  path: string;
  mtimeMs: number;
  fromCache: boolean;
}

let loaded: LoadedCatalog | null = null;
let refreshPromise: Promise<CatalogRefreshResult> | null = null;

export interface CatalogRefreshResult {
  refreshed: boolean;
  /** 未刷新的原因，便于日志定位。 */
  reason?: "fresh" | "fetch-failed" | "invalid" | "write-failed";
  error?: string;
}

export function getModelContextDataDir(): string {
  const fromEnv = (process.env.HPP_DATA_DIR || "").trim();
  return fromEnv || process.cwd();
}

/**
 * 本模块所在目录。
 *
 * 主进程包是 CJS，`__dirname` 可用；插件后端包（`plugin-backend-*.mjs`）由
 * esbuild 打成 ESM，直接引用 `__dirname` 会抛 ReferenceError —— 所以这里必须
 * 用 `typeof` 探测（对未声明的标识符安全），拿不到就交给调用方回退。
 */
function getModuleDir(): string | null {
  return typeof __dirname === "string" && __dirname ? __dirname : null;
}

/** 内置快照路径：开发期在 resources/，打包后在 out/main/ 与主进程同目录。 */
export function getBundledModelContextCatalogPath(): string {
  const candidates = [
    getModuleDir() ? join(getModuleDir() as string, CATALOG_FILE) : "",
    // 插件宿主进程会注入 HPP_AGENT_BACKEND_DIR（就是 out/main），
    // ESM 后端包里没有 __dirname，靠它定位同一份快照。
    (process.env.HPP_AGENT_BACKEND_DIR || "").trim()
      ? join((process.env.HPP_AGENT_BACKEND_DIR as string).trim(), CATALOG_FILE)
      : "",
    join(process.cwd(), "out", "main", CATALOG_FILE),
    join(process.cwd(), "resources", CATALOG_FILE),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[candidates.length - 1];
}

/** 运行时缓存路径（每日刷新写入，也是各插件读取的同一份）。 */
export function getModelContextCatalogCachePath(): string {
  return join(getModelContextDataDir(), CATALOG_FILE);
}

const parseCatalogFile = (path: string): ModelContextCatalogData | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ModelContextCatalogData;
    if (parsed?.version !== MODEL_CONTEXT_CATALOG_VERSION) return null;
    if (!parsed.providers || Object.keys(parsed.providers).length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
};

const loadCatalogFile = (path: string, fromCache: boolean): LoadedCatalog | null => {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (loaded && loaded.path === path && loaded.mtimeMs === mtimeMs) return loaded;
    const data = parseCatalogFile(path);
    if (!data) return null;
    loaded = { data, path, mtimeMs, fromCache };
    return loaded;
  } catch {
    return null;
  }
};

/**
 * 当前生效的目录（同步）。
 * 缓存文件优先，缺失或损坏时回退内置快照；两处都没有就返回 null，
 * 调用方保持插件自己上报的窗口。
 */
export function getModelContextCatalog(): ModelContextCatalogData | null {
  const cachePath = getModelContextCatalogCachePath();
  const fromCache = loadCatalogFile(cachePath, true);
  if (fromCache) return fromCache.data;
  const bundledPath = getBundledModelContextCatalogPath();
  const fromBundled = bundledPath === cachePath ? null : loadCatalogFile(bundledPath, false);
  return fromBundled?.data ?? null;
}

/** 解析某个渠道模型的统一窗口；命中不到返回 undefined。 */
export function resolveModelContextWindowFor(input: {
  provider?: unknown;
  modelId?: unknown;
}): ModelContextWindowResolution | undefined {
  return resolveFromCatalog(getModelContextCatalog(), input);
}

/**
 * 用统一目录覆盖模型列表里的上下文窗口。
 *
 * 目录命中的模型一律以目录为准 —— 这正是「同一个模型在不同插件里显示同一个上限」
 * 的实现方式。目录没有的模型（私有中转、自造名字）保留插件自己给的值，
 * 所以仍然可以在渠道配置里手工声明。
 */
export function withCatalogContextWindows<
  T extends { provider: string; id: string; contextWindow?: number },
>(models: T[]): T[] {
  if (models.length === 0) return models;
  const catalog = getModelContextCatalog();
  if (!catalog) return models;
  return models.map((model) => {
    const resolved = resolveFromCatalog(catalog, {
      provider: model.provider,
      modelId: model.id,
    });
    if (!resolved || resolved.window === model.contextWindow) return model;
    return { ...model, contextWindow: resolved.window };
  });
}

const countCatalog = (data: ModelContextCatalogData) => {
  const providers = Object.keys(data.providers || {});
  const models = providers.reduce(
    (total, provider) => total + Object.keys(data.providers[provider] || {}).length,
    0,
  );
  return { providerCount: providers.length, modelCount: models };
};

const writeCatalogCache = (data: ModelContextCatalogData, path: string): boolean => {
  const tempPath = `${path}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(data)}\n`, "utf8");
    renameSync(tempPath, path);
    return true;
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // 清理临时文件失败不影响主流程。
    }
    console.warn("[model-catalog] 写入缓存失败:", error instanceof Error ? error.message : String(error));
    return false;
  }
};

async function fetchCatalog(
  fetchImpl: typeof fetch,
  etag?: string,
): Promise<{ data?: ModelContextCatalogData; notModified?: boolean }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (etag) headers["if-none-match"] = etag;
  const response = await fetchImpl(SOURCE_URL, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 304) return { notModified: true };
  if (!response.ok) throw new Error(`models.dev responded ${response.status}`);
  const payload = await response.json();
  const data = compactModelContextCatalog(payload, {
    fetchedAt: new Date().toISOString(),
    etag: response.headers?.get?.("etag") || etag,
    source: "models.dev",
  });
  const { providerCount, modelCount } = countCatalog(data);
  if (providerCount < MIN_PROVIDER_COUNT || modelCount < MIN_MODEL_COUNT) {
    throw new Error(`models.dev returned a partial catalog (${providerCount} providers / ${modelCount} models)`);
  }
  return { data };
}

/**
 * 必要时刷新目录（默认 24 小时一次）。永不抛错：失败只是继续用旧数据。
 * 同一时刻只跑一次，插件初始化并行调用也没关系。
 */
export function refreshModelContextCatalog(options: {
  force?: boolean;
  now?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<CatalogRefreshResult> {
  if (refreshPromise) return refreshPromise;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return Promise.resolve({ refreshed: false, reason: "fetch-failed", error: "fetch unavailable" });
  }
  const current = getModelContextCatalog();
  const now = options.now ?? Date.now();
  if (!options.force && !shouldRefreshModelContextCatalog(current, now, MODEL_CONTEXT_CATALOG_MAX_AGE_MS)) {
    return Promise.resolve({ refreshed: false, reason: "fresh" });
  }

  const cachePath = getModelContextCatalogCachePath();
  refreshPromise = (async (): Promise<CatalogRefreshResult> => {
    try {
      const { data, notModified } = await fetchCatalog(fetchImpl, current?.etag);
      if (notModified) {
        // 304：模型窗口没变，只把抓取时间往后推，避免每天重复下载同一份数据。
        if (current) {
          const touched: ModelContextCatalogData = { ...current, fetchedAt: new Date(now).toISOString() };
          if (writeCatalogCache(touched, cachePath)) {
            loaded = { data: touched, path: cachePath, mtimeMs: statSync(cachePath).mtimeMs, fromCache: true };
          }
          return { refreshed: true };
        }
        return { refreshed: false, reason: "invalid" };
      }
      if (!data) return { refreshed: false, reason: "invalid" };
      if (!writeCatalogCache(data, cachePath)) return { refreshed: false, reason: "write-failed" };
      loaded = { data, path: cachePath, mtimeMs: statSync(cachePath).mtimeMs, fromCache: true };
      const { providerCount, modelCount } = countCatalog(data);
      console.log(`[model-catalog] 已刷新：${providerCount} providers / ${modelCount} models`);
      return { refreshed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[model-catalog] 刷新失败，继续使用现有目录:", message);
      return { refreshed: false, reason: "fetch-failed", error: message };
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

/** 启动时调用：先把目录读起来，再后台尝试每日刷新。 */
export async function initializeModelContextCatalog(options: {
  force?: boolean;
  now?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<CatalogRefreshResult> {
  const active = getModelContextCatalog();
  if (active) {
    const { providerCount, modelCount } = countCatalog(active);
    const origin = loaded?.fromCache ? "缓存" : "内置快照";
    console.log(`[model-catalog] ${origin}生效：${providerCount} providers / ${modelCount} models`);
  } else {
    console.warn("[model-catalog] 没有可用的模型目录，上下文窗口将沿用各插件自己上报的值");
  }
  return refreshModelContextCatalog(options);
}

/** 单测用：清掉内存缓存（不会动磁盘）。 */
export function resetModelContextCatalogForTests(): void {
  loaded = null;
  refreshPromise = null;
}
