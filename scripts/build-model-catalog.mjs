#!/usr/bin/env node
/**
 * 生成内置的模型上下文窗口目录（models.dev 快照）。
 *
 *   node scripts/build-model-catalog.mjs                     # 从 models.dev 抓最新
 *   node scripts/build-model-catalog.mjs .tmp/models-dev.json # 从本地文件转换
 *
 * 产物 `resources/model-context-catalog.json` 会随应用发布（构建时复制到 out/main），
 * 运行时每天还会尝试刷新一次并写进 `<data>/model-context-catalog.json`。
 *
 * 压缩规则必须与 `shared/model-context-catalog.ts` 的 compactModelContextCatalog
 * 保持一致（那边是运行时刷新用的 TS 版本，两处都是二十行，测试钉住格式）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(ROOT, "resources/model-context-catalog.json");
const SOURCE_URL = "https://models.dev/api.json";
const VERSION = 1;

const normalizeText = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

const compact = (payload, fetchedAt) => {
  const providers = {};
  for (const [rawProviderId, rawProvider] of Object.entries(payload || {})) {
    const providerId = normalizeText(rawProviderId);
    const models = rawProvider && typeof rawProvider === "object" ? rawProvider.models : null;
    if (!providerId || !models || typeof models !== "object") continue;
    const entries = {};
    for (const [rawModelId, rawModel] of Object.entries(models)) {
      const modelId = normalizeText(rawModelId);
      const limit = rawModel && typeof rawModel === "object" ? rawModel.limit : null;
      if (!modelId || !limit || typeof limit !== "object") continue;
      const context = Number(limit.context);
      const input = Number(limit.input);
      const hasContext = Number.isFinite(context) && context > 0;
      const hasInput = Number.isFinite(input) && input > 0;
      if (!hasContext && !hasInput) continue;
      const contextTokens = Math.round(hasContext ? context : input);
      entries[modelId] = hasInput ? [contextTokens, Math.round(input)] : [contextTokens];
    }
    if (Object.keys(entries).length > 0) providers[providerId] = entries;
  }
  return { version: VERSION, source: "models.dev", fetchedAt, providers };
};

const main = async () => {
  const input = process.argv[2];
  const output = resolve(process.argv[3] || DEFAULT_OUTPUT);
  const fetchedAt = new Date().toISOString();
  const payload = input
    ? JSON.parse(await readFile(resolve(input), "utf8"))
    : await (async () => {
        const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`models.dev responded ${response.status}`);
        return response.json();
      })();

  const catalog = compact(payload, fetchedAt);
  const providerCount = Object.keys(catalog.providers).length;
  const modelCount = Object.values(catalog.providers)
    .reduce((total, models) => total + Object.keys(models).length, 0);
  if (providerCount === 0 || modelCount === 0) throw new Error("目录为空，拒绝写入");

  await mkdir(dirname(output), { recursive: true });
  const json = `${JSON.stringify(catalog)}\n`;
  await writeFile(output, json, "utf8");
  console.log(
    `[model-catalog] ${providerCount} providers / ${modelCount} models → ${output} (${(Buffer.byteLength(json) / 1024).toFixed(0)} KB)`,
  );
};

main().catch((error) => {
  console.error("[model-catalog] failed:", error?.message || error);
  process.exitCode = 1;
});
