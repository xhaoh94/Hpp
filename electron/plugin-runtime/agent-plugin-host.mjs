import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pending = new Map();
const backends = new Map();
let nextId = 0;
let pluginModule = null;
let pluginMeta = null;
let shutdownPromise = null;

const writeLog = (...args) => {
  process.stderr.write(`${args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ")}\n`);
};

console.log = writeLog;
console.info = writeLog;
console.debug = writeLog;
console.warn = writeLog;

const loadBuiltinBackend = async (backendName, sessionId, emit, context) => {
  const backendDir = process.env.HPP_AGENT_BACKEND_DIR || dirname(fileURLToPath(import.meta.url));
  const module = await import(pathToFileURL(`${backendDir}/plugin-backend-${backendName}.mjs`).href);
  return module.createBackend(sessionId, emit, context);
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const validateEvent = (event) => {
  if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string" || !event.type.trim()) {
    throw new Error("Plugin events must include a non-empty type.");
  }
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
    throw new Error("Plugin event exceeds the 1 MB size limit.");
  }
  return event;
};

const requestHost = (method, args = []) => new Promise((resolve, reject) => {
  const id = `host-${++nextId}`;
  pending.set(id, { resolve, reject });
  send({ kind: "request", id, method: "hostCall", params: { method, args } });
});

const host = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    return async (...args) => {
      return requestHost(property, args);
    };
  },
});

const createContext = (sessionId, backendId) => ({
  ...pluginMeta,
  sessionId,
  host,
  sendEvent: (event) => send({ kind: "event", backendId, event: validateEvent(event) }),
  getConfigState: () => requestHost("getConfigState", [backendId]),
  createBuiltinBackend: (backendName) => loadBuiltinBackend(
    backendName,
    sessionId,
    (event) => send({ kind: "event", backendId, event: validateEvent(event) }),
    {
      getConfigState: () => requestHost("getConfigState", [backendId]),
      dataDir: pluginMeta.dataDir,
      pluginDir: pluginMeta.pluginDir,
    },
  ),
});

const createStatusContext = () => ({ ...pluginMeta, host });

// 聚合插件宿主进程内各后端已缓存的实时模型（代码型后端通过 worker 从 app-server 拉取）。
// 与 configProvider 同进程，可直接在内存中共享，避免写回 app-server 持有的 models_cache.json。
const getRealtimeModels = () => {
  const seen = new Map();
  for (const backend of backends.values()) {
    const models = backend?.models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      if (model && typeof model.id === "string" && model.id && !seen.has(model.id)) {
        seen.set(model.id, model);
      }
    }
  }
  return Array.from(seen.values());
};

// 懒加载的「模型发现后端」：用户没开过 Codex 会话直接打开设置时，也能主动启动
// 一次 worker → app-server → model/list，把实时模型缓存到宿主进程内。
// 这样 gpt-5.6-sol 等新模型就能被 configProvider.read/lookup 按 id 命中。
const DISCOVERY_BACKEND_ID = "__model_discovery__";
let discoveryPromise = null;
const ensureDiscoveryModels = async () => {
  if (discoveryPromise) return discoveryPromise;
  discoveryPromise = (async () => {
    try {
      if (!backends.has(DISCOVERY_BACKEND_ID)) {
        const backend = await pluginModule.createAgentBackend(createContext(DISCOVERY_BACKEND_ID, DISCOVERY_BACKEND_ID));
        if (!backend) return getRealtimeModels();
        backends.set(DISCOVERY_BACKEND_ID, backend);
        if (typeof backend.init === "function") {
          try {
            await backend.init(process.cwd(), null, {});
          } catch (error) {
            console.warn("[plugin-host] discovery backend init failed:", error?.message || String(error));
          }
        }
      }
      const backend = backends.get(DISCOVERY_BACKEND_ID);
      if (backend && typeof backend.getModels === "function") {
        try { await backend.getModels(); } catch { /* ignored, getRealtimeModels will still aggregate */ }
      }
    } catch (error) {
      console.warn("[plugin-host] discovery models failed:", error?.message || String(error));
    }
    return getRealtimeModels();
  })();
  return discoveryPromise;
};
// 插件支持 configProvider.read / lookupModel 时：一旦主进程首次请求，就提前触发发现，
// 避免上层调用 getRealtimeModels() 时 backends 还是空数组。
const prefetchDiscoveryForConfig = async () => {
  try { await ensureDiscoveryModels(); } catch { /* ignored */ }
  return getRealtimeModels();
};

const disposeAllBackends = async () => {
  const activeBackends = Array.from(backends.values());
  backends.clear();
  await Promise.allSettled(activeBackends.map((backend) => backend?.dispose?.()));
};

const shutdownHost = async () => {
  if (!shutdownPromise) shutdownPromise = disposeAllBackends();
  await shutdownPromise;
};

const methods = {
  async load({ entryPath, meta }) {
    pluginMeta = meta;
    pluginModule = await import(`${pathToFileURL(entryPath).href}?host=${Date.now()}`);
    if (typeof pluginModule.createAgentBackend !== "function") {
      throw new Error("Plugin must export createAgentBackend(context).");
    }
    return {
      getStatus: typeof pluginModule.getStatus === "function",
      update: typeof pluginModule.update === "function",
      uninstall: typeof pluginModule.uninstall === "function",
      getDefaultThinkingLevel: typeof pluginModule.getDefaultThinkingLevel === "function",
      readProviderConfig: typeof pluginModule.configProvider?.read === "function",
      writeProviderConfig: typeof pluginModule.configProvider?.write === "function",
      activateProvider: typeof pluginModule.configProvider?.activateProvider === "function",
      lookupModel: typeof pluginModule.configProvider?.lookupModel === "function",
    };
  },
  async getStatus() { return pluginModule.getStatus?.(createStatusContext()); },
  async update(args) { return pluginModule.update?.(createStatusContext(), args); },
  async uninstall() { return pluginModule.uninstall?.(createStatusContext()); },
  async getDefaultThinkingLevel() { return pluginModule.getDefaultThinkingLevel?.(createStatusContext()); },
  async readProviderConfig(args) {
    const realtimeModels = await prefetchDiscoveryForConfig();
    return pluginModule.configProvider?.read?.(createStatusContext(), { ...args, realtimeModels });
  },
  async writeProviderConfig(args) { return pluginModule.configProvider?.write?.(createStatusContext(), args); },
  async activateProvider(args) { return pluginModule.configProvider?.activateProvider?.(createStatusContext(), args); },
  async lookupModel(args) {
    const realtimeModels = await prefetchDiscoveryForConfig();
    return pluginModule.configProvider?.lookupModel?.(createStatusContext(), { ...args, realtimeModels });
  },
  async createBackend({ backendId, sessionId }) {
    const backend = await pluginModule.createAgentBackend(createContext(sessionId, backendId));
    if (!backend || typeof backend !== "object") throw new Error("Plugin backend must be an object.");
    backends.set(backendId, backend);
    return {
      sendGuidance: typeof backend.sendGuidance === "function",
      forkSession: typeof backend.forkSession === "function",
      listActions: typeof backend.listActions === "function",
    };
  },
  async backendCall({ backendId, method, args = [] }) {
    const backend = backends.get(backendId);
    if (!backend) throw new Error(`Unknown plugin backend: ${backendId}`);
    if (method === "sessionFilePath") {
      if (typeof backend.getSessionFilePath === "function") return backend.getSessionFilePath();
      return backend.sessionFilePath ?? null;
    }
    const fn = backend[method];
    if (typeof fn !== "function") {
      if (["isIdle", "sendGuidance", "forkSession", "listActions"].includes(method)) return undefined;
      throw new Error(`Plugin backend is missing ${method}().`);
    }
    return fn.apply(backend, args);
  },
  async disposeBackend({ backendId }) {
    const backend = backends.get(backendId);
    backends.delete(backendId);
    await backend?.dispose?.();
  },
  async shutdown() {
    await shutdownHost();
    setTimeout(() => process.exit(0), 0);
    return { success: true };
  },
};

const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.kind === "response") {
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error));
    else callback.resolve(message.result);
    return;
  }
  if (message.kind !== "request") return;
  try {
    const fn = methods[message.method];
    if (typeof fn !== "function") throw new Error(`Unknown plugin host method: ${message.method}`);
    send({ kind: "response", id: message.id, result: await fn(message.params || {}) });
  } catch (error) {
    send({ kind: "response", id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});

const exitAfterShutdown = () => {
  void shutdownHost().finally(() => process.exit(0));
};

input.on("close", exitAfterShutdown);
process.on("disconnect", exitAfterShutdown);
process.on("SIGINT", exitAfterShutdown);
process.on("SIGTERM", exitAfterShutdown);
