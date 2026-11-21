#!/usr/bin/env node
"use strict";

/**
 * 诊断 Pi 渠道里「模型是否内置」的判定来源。
 *
 * 判定逻辑与 electron/agent-plugins/pi/config.mjs 保持一致：
 *   1. 读 SDK 包内静态目录 <dataDir>/pi-sdk-runtime/node_modules/@earendil-works/pi-ai/dist/providers/data/*.json
 *      先按 provider:modelId 命中，再按 modelId 跨 provider 兜底；
 *   2. SDK 目录没有时回退 <models.json 同目录>/models-store.json；
 *   3. 命中的条目必须 reasoning 是 boolean、input 是数组，才算内置。
 *
 * 用法（内网机同样适用，只依赖 Node）：
 *   node scripts/check-pi-builtin.cjs              # 列出本机所有渠道模型的判定
 *   node scripts/check-pi-builtin.cjs astra        # 额外打印 catalog 里含该关键字的 id
 *
 * 可选环境变量：HPP_DATA_DIR、PI_CONFIG_PATH（与 Hpp 运行时一致）。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const keyword = (process.argv[2] || "").trim().toLowerCase();

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
};

const dataDir =
  (process.env.HPP_DATA_DIR || "").trim() ||
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "hpp", "hpp-data");

const runtimeNodeModules = path.join(dataDir, "pi-sdk-runtime", "node_modules", "@earendil-works");
const candidates = [
  path.join(runtimeNodeModules, "pi-ai", "dist", "providers", "data"),
  path.join(
    runtimeNodeModules,
    "pi-coding-agent",
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "providers",
    "data",
  ),
];

console.log(`HPP_DATA_DIR = ${dataDir}`);

let catalogDir = null;
for (const dir of candidates) {
  const ok = fs.existsSync(dir);
  console.log(`${ok ? "[命中]  " : "[缺失]  "} ${dir}`);
  if (ok && !catalogDir) catalogDir = dir;
}

const piAiPkg = readJson(path.join(runtimeNodeModules, "pi-ai", "package.json"));
console.log(`pi-ai 版本 = ${piAiPkg?.version ?? "未安装"}`);

if (!catalogDir) {
  console.log("\n=> 读不到 SDK 内置目录：所有模型都会被判成「自定义」。");
  console.log("   检查离线包是否用了 -SkipHppSDK，或装到了别的 -HppDataDir。");
}

const byProviderAndId = new Map();
const byId = new Map();

if (catalogDir) {
  const files = fs.readdirSync(catalogDir).filter((f) => f.endsWith(".json") && f !== ".manifest.json");
  for (const file of files) {
    const data = readJson(path.join(catalogDir, file));
    if (!data || typeof data !== "object") continue;
    for (const apiType of Object.keys(data)) {
      const models = data[apiType];
      if (!models || typeof models !== "object") continue;
      for (const key of Object.keys(models)) {
        const model = models[key];
        if (!model || !model.id) continue;
        if (model.provider) byProviderAndId.set(`${model.provider}:${model.id}`, model);
        if (!byId.has(model.id)) byId.set(model.id, model);
      }
    }
  }
  console.log(`catalog 文件数 = ${files.length}，条目数 = ${byId.size}`);
}

const configPath =
  (process.env.PI_CONFIG_PATH || "").trim() || path.join(os.homedir(), ".pi", "agent", "models.json");
const storePath = path.join(path.dirname(configPath), "models-store.json");
const config = readJson(configPath);
const store = readJson(storePath);

console.log(`models.json       = ${config ? configPath : `读不到（${configPath}）`}`);
console.log(`models-store.json = ${store ? storePath : `读不到（${storePath}）`}`);

const findInStore = (provider, id) => {
  if (!store) return null;
  const exact = store[provider]?.models?.find?.((m) => m && m.id === id);
  if (exact) return exact;
  for (const entry of Object.values(store)) {
    const hit = entry?.models?.find?.((m) => m && m.id === id);
    if (hit) return hit;
  }
  return null;
};

const isUsableEntry = (entry) => !!entry && typeof entry.reasoning === "boolean" && Array.isArray(entry.input);

console.log("");
const rows = [];
for (const [providerId, provider] of Object.entries(config?.providers || {})) {
  for (const model of provider?.models || []) {
    if (!model?.id) continue;
    const providerHit = byProviderAndId.get(`${providerId}:${model.id}`);
    const idHit = byId.get(model.id);
    const storeHit = !providerHit && !idHit ? findInStore(providerId, model.id) : null;
    const entry = providerHit || idHit || storeHit;
    const source = providerHit
      ? "SDK目录/provider"
      : idHit
        ? `SDK目录/byId(命中的 provider=${idHit.provider || "?"})`
        : storeHit
          ? "models-store"
          : "无";
    const builtin = isUsableEntry(entry);
    rows.push({ providerId, id: model.id, builtin, source, entry });
    console.log(`${builtin ? "内置  " : "自定义"} | ${providerId}/${model.id} | ${source}`);
  }
}

const custom = rows.filter((r) => !r.builtin);
console.log(`\n合计 ${rows.length} 个模型：内置 ${rows.length - custom.length} 个，自定义 ${custom.length} 个。`);

if (custom.length > 0) {
  console.log("\n判为自定义的模型在 catalog 里没有同名 id，或者命中的条目缺 reasoning/input。");
  console.log("如果这些模型在另一台机器上是内置的，多半是那边 SDK 的 pi-ai 目录更新的缘故。");
}

if (keyword) {
  console.log(`\n--- catalog 里含「${keyword}」的 id ---`);
  const hits = [...new Set([...byId.keys()])].filter((id) => id.toLowerCase().includes(keyword));
  if (hits.length === 0) console.log("（没有）");
  for (const id of hits) console.log(`  ${id}  -> provider=${byId.get(id)?.provider || "?"}`);
}