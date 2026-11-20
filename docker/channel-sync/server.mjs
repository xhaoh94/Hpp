#!/usr/bin/env node
/**
 * Hpp 渠道配置同步服务（NAS 端）。
 *
 * 零依赖的单文件 HTTP 服务，部署在飞牛 NAS 的 Docker 里，只做三件事：
 *   1. 接收 Hpp 主动上传的渠道配置包（PUT /snapshot），存盘并递增 revision；
 *   2. 把最新快照交还给 Hpp 主动拉取（GET /snapshot）；
 *   3. 保留最近若干份历史快照，误覆盖时能翻回去（GET /snapshots）。
 *
 * 整个协议只有「谁都能读的 /health」+「Bearer Token 保护的其余接口」。
 * 服务不主动连外网，也不做定时任务，所有同步都由用户在 Hpp 里手动触发。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const SERVICE_NAME = "hpp-channel-sync";
export const SERVICE_VERSION = 1;
export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_HISTORY_LIMIT = 20;

const SNAPSHOT_FILE = "snapshot.json";
const META_FILE = "meta.json";
const HISTORY_DIR = "history";

/** 只接受 Hpp 导出的配置包，避免把服务当成任意文件柜。 */
export function isChannelSyncPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.type !== "hpp-agent-config-export") return false;
  if (!Number.isInteger(value.version) || value.version !== 1) return false;
  const agents = value.agents;
  return !!agents && typeof agents === "object" && !Array.isArray(agents);
}

function createJsonResponse(res, statusCode, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        const error = new Error("配置包超出服务端大小限制。");
        error.statusCode = 413;
        // 不立刻 destroy：先把 413 写回去，剩下的请求体继续被消费但不落内存。
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/**
 * 创建服务实例但不监听端口，便于测试里直接 listen(0)。
 */
export function createChannelSyncServer(options = {}) {
  const dataDir = options.dataDir || "/data";
  const token = String(options.token || "").trim();
  if (!token) {
    throw new Error("缺少同步 Token：请为容器设置环境变量 HPP_SYNC_TOKEN。");
  }
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const historyLimit = Number.isFinite(options.historyLimit)
    ? Math.max(0, Math.floor(Number(options.historyLimit)))
    : DEFAULT_HISTORY_LIMIT;
  const now = options.now || (() => new Date());
  const log = options.log || (() => {});

  const expectedDigest = createHash("sha256").update(token).digest();
  const snapshotPath = join(dataDir, SNAPSHOT_FILE);
  const metaPath = join(dataDir, META_FILE);
  const historyDir = join(dataDir, HISTORY_DIR);

  /** 读改写串行化：两个 Hpp 同时点备份时不能互相覆盖 revision。 */
  let writeChain = Promise.resolve();
  const enqueue = (operation) => {
    const next = writeChain.then(operation, operation);
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  async function readJsonFile(filePath) {
    try {
      return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      log(`[hpp-sync] 读取 ${filePath} 失败：${error?.message || error}`);
      return null;
    }
  }

  async function writeAtomic(filePath, text) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, filePath);
  }

  async function readRevision() {
    const meta = await readJsonFile(metaPath);
    return Number.isInteger(meta?.revision) && meta.revision >= 0 ? meta.revision : 0;
  }

  const historyFileName = (revision) => `${String(revision).padStart(6, "0")}.json`;

  async function pruneHistory() {
    if (historyLimit <= 0) return;
    let entries = [];
    try {
      entries = await readdir(historyDir);
    } catch {
      return;
    }
    const files = entries.filter((name) => /^\d{6,}\.json$/.test(name)).sort();
    const excess = files.length - historyLimit;
    if (excess <= 0) return;
    for (const name of files.slice(0, excess)) {
      try {
        await rm(join(historyDir, name), { force: true });
      } catch {
        // 清理历史失败不影响本次备份，交给下一次重试。
      }
    }
  }

  async function saveSnapshot(payload) {
    return enqueue(async () => {
      const revision = (await readRevision()) + 1;
      const savedAt = now().toISOString();
      const record = { revision, savedAt, payload };
      const text = `${JSON.stringify(record, null, 2)}\n`;
      // 先写历史再写当前快照：中途断电时最多丢本次，不会出现「当前指向不存在的历史」。
      await writeAtomic(join(historyDir, historyFileName(revision)), text);
      await writeAtomic(snapshotPath, text);
      await writeAtomic(metaPath, `${JSON.stringify({ revision, savedAt }, null, 2)}\n`);
      await pruneHistory();
      log(`[hpp-sync] 已保存 revision ${revision}`);
      return { revision, savedAt };
    });
  }

  async function readSnapshot() {
    const record = await readJsonFile(snapshotPath);
    if (!record || typeof record !== "object" || !record.payload) return null;
    return record;
  }

  async function listSnapshots() {
    const meta = await readJsonFile(metaPath);
    let names = [];
    try {
      names = (await readdir(historyDir)).filter((name) => /^\d{6,}\.json$/.test(name)).sort();
    } catch {
      names = [];
    }
    const snapshots = [];
    for (const name of names) {
      const record = await readJsonFile(join(historyDir, name));
      if (!record || !Number.isInteger(record.revision)) continue;
      snapshots.push({ revision: record.revision, savedAt: record.savedAt });
    }
    snapshots.sort((left, right) => right.revision - left.revision);
    return { currentRevision: Number.isInteger(meta?.revision) ? meta.revision : 0, snapshots };
  }

  function isAuthorized(req) {
    const header = String(req.headers.authorization || "").trim();
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return false;
    const digest = createHash("sha256").update(match[1].trim()).digest();
    return digest.length === expectedDigest.length && timingSafeEqual(digest, expectedDigest);
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // 探测接口不校验 Token：用户可以用浏览器/curl 先确认服务活着，
    // 它不返回任何配置内容，只回报 revision 数字。
    if (path === "/health" && req.method === "GET") {
      return createJsonResponse(res, 200, {
        ok: true,
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        revision: await readRevision(),
      });
    }

    if (!isAuthorized(req)) {
      return createJsonResponse(res, 401, { error: "unauthorized", message: "Token 不匹配。" });
    }

    if (path === "/snapshot" && req.method === "GET") {
      const record = await readSnapshot();
      if (!record) {
        return createJsonResponse(res, 404, { error: "empty", message: "还没有备份。" });
      }
      return createJsonResponse(res, 200, {
        revision: record.revision,
        savedAt: record.savedAt,
        payload: record.payload,
      });
    }

    if (path === "/snapshot" && req.method === "PUT") {
      let parsed;
      try {
        const raw = await readRequestBody(req, maxBytes);
        parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
      } catch (error) {
        if (error && error.statusCode === 413) {
          return createJsonResponse(res, 413, { error: "too_large", message: error.message });
        }
        return createJsonResponse(res, 400, { error: "invalid_json", message: "请求体不是有效的 JSON。" });
      }
      if (!isChannelSyncPayload(parsed)) {
        return createJsonResponse(res, 400, {
          error: "invalid_payload",
          message: "请求体不是 Hpp 渠道配置包。",
        });
      }
      const saved = await saveSnapshot(parsed);
      return createJsonResponse(res, 200, { success: true, ...saved });
    }

    if (path === "/snapshots" && req.method === "GET") {
      const list = await listSnapshots();
      return createJsonResponse(res, 200, list);
    }

    const historyMatch = /^\/snapshot\/(\d+)$/.exec(path);
    if (historyMatch && req.method === "GET") {
      const revision = Number(historyMatch[1]);
      const record = await readJsonFile(join(historyDir, historyFileName(revision)));
      if (!record || record.revision !== revision) {
        return createJsonResponse(res, 404, { error: "not_found", message: "没有这一版快照。" });
      }
      return createJsonResponse(res, 200, {
        revision: record.revision,
        savedAt: record.savedAt,
        payload: record.payload,
      });
    }

    return createJsonResponse(res, 404, { error: "not_found", message: "没有这个接口。" });
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      log(`[hpp-sync] 请求处理失败：${error?.stack || error}`);
      if (!res.headersSent) {
        createJsonResponse(res, 500, { error: "internal_error" });
      } else {
        res.end();
      }
    });
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return server;
}

/** 读取环境变量并启动监听，返回 server 实例（已 listen）。 */
export async function startChannelSyncServer(env = process.env) {
  const server = createChannelSyncServer({
    dataDir: env.HPP_SYNC_DATA_DIR || "/data",
    token: env.HPP_SYNC_TOKEN,
    maxBytes: Number(env.HPP_SYNC_MAX_BYTES),
    historyLimit: env.HPP_SYNC_HISTORY_LIMIT,
    log: (message) => console.log(message),
  });
  const port = Number(env.HPP_SYNC_PORT || DEFAULT_PORT);
  const host = env.HPP_SYNC_HOST || "0.0.0.0";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(`[hpp-sync] 已监听 http://${host}:${port}`);
  return server;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  startChannelSyncServer()
    .then((server) => {
      const shutdown = () => {
        server.close(() => process.exit(0));
        // 容器停止时可能有连接没断，兜底退出。
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    })
    .catch((error) => {
      console.error(`[hpp-sync] 启动失败：${error?.message || error}`);
      process.exit(1);
    });
}
