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

const loadBuiltinBackend = async (backendName, sessionId, emit) => {
  const backendDir = process.env.HPP_AGENT_BACKEND_DIR || dirname(fileURLToPath(import.meta.url));
  const module = await import(pathToFileURL(`${backendDir}/plugin-backend-${backendName}.mjs`).href);
  return module.createBackend(sessionId, emit);
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
  ),
});

const createStatusContext = () => ({ ...pluginMeta, host });

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
    };
  },
  async getStatus() { return pluginModule.getStatus?.(createStatusContext()); },
  async update() { return pluginModule.update?.(createStatusContext()); },
  async uninstall() { return pluginModule.uninstall?.(createStatusContext()); },
  async getDefaultThinkingLevel() { return pluginModule.getDefaultThinkingLevel?.(createStatusContext()); },
  async readProviderConfig(args) { return pluginModule.configProvider?.read?.(createStatusContext(), args); },
  async writeProviderConfig(args) { return pluginModule.configProvider?.write?.(createStatusContext(), args); },
  async activateProvider(args) { return pluginModule.configProvider?.activateProvider?.(createStatusContext(), args); },
  async createBackend({ backendId, sessionId }) {
    const backend = await pluginModule.createAgentBackend(createContext(sessionId, backendId));
    if (!backend || typeof backend !== "object") throw new Error("Plugin backend must be an object.");
    backends.set(backendId, backend);
    return {
      sendGuidance: typeof backend.sendGuidance === "function",
      forkSession: typeof backend.forkSession === "function",
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
      if (["isIdle", "sendGuidance", "forkSession", "sendUIResponse"].includes(method)) return undefined;
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
