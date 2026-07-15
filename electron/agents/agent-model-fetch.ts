export interface RemoteProviderModel {
  id: string;
  name: string;
}

const MODEL_FETCH_TIMEOUT_MS = 15_000;
const MAX_MODEL_RESPONSE_BYTES = 5 * 1024 * 1024;

type FetchLike = typeof fetch;
type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function buildProviderModelsUrl(baseUrl: string): string {
  const trimmedBaseUrl = baseUrl.trim();
  if (!trimmedBaseUrl) throw new Error("请先填写渠道 URL。");

  let url: URL;
  try {
    url = new URL(trimmedBaseUrl);
  } catch {
    throw new Error("渠道 URL 格式无效。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("渠道 URL 仅支持 HTTP 或 HTTPS。");
  }

  if (!url.pathname.replace(/\/+$/, "").endsWith("/models")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function normalizeRemoteProviderModels(value: unknown): RemoteProviderModel[] {
  const record = isRecord(value) ? value : null;
  const rawModels = Array.isArray(value)
    ? value
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];
  const seen = new Set<string>();
  const models: RemoteProviderModel[] = [];

  for (const rawModel of rawModels) {
    const model = isRecord(rawModel) ? rawModel : null;
    const id = typeof rawModel === "string"
      ? getString(rawModel)
      : getString(model?.id) || getString(model?.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: getString(model?.display_name) || getString(model?.name) || id,
    });
  }

  return models;
}

function getProviderErrorMessage(responseText: string): string | undefined {
  try {
    const value = JSON.parse(responseText);
    if (!isRecord(value)) return undefined;
    if (typeof value.message === "string") return value.message;
    if (isRecord(value.error) && typeof value.error.message === "string") return value.error.message;
  } catch {
    return responseText.trim().slice(0, 300) || undefined;
  }
  return undefined;
}

export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch
): Promise<RemoteProviderModel[]> {
  const modelsUrl = buildProviderModelsUrl(baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(modelsUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
      },
      signal: controller.signal,
    });
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_MODEL_RESPONSE_BYTES) {
      throw new Error("模型列表响应过大。");
    }

    const responseText = await response.text();
    if (Buffer.byteLength(responseText, "utf8") > MAX_MODEL_RESPONSE_BYTES) {
      throw new Error("模型列表响应过大。");
    }
    if (!response.ok) {
      const detail = getProviderErrorMessage(responseText);
      throw new Error(`获取模型失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error("模型接口返回的不是有效 JSON。");
    }
    const models = normalizeRemoteProviderModels(payload);
    if (models.length === 0) throw new Error("模型接口没有返回可用模型。");
    return models;
  } catch (error: unknown) {
    if (controller.signal.aborted) throw new Error("获取模型超时，请检查渠道 URL 或网络连接。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
