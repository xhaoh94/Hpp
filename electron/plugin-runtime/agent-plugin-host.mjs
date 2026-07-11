import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const pending = new Map();
const backends = new Map();
let nextId = 0;
let pluginModule = null;
let pluginMeta = null;

const loadBuiltinBackend = async (backendName, sessionId, emit) => {
  const backendDir = process.env.HPP_AGENT_BACKEND_DIR;
  if (!backendDir) throw new Error("HPP_AGENT_BACKEND_DIR is not configured.");
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
      getDefaultThinkingLevel: typeof pluginModule.getDefaultThinkingLevel === "function",
      activateProvider: typeof pluginModule.configProvider?.activateProvider === "function",
    };
  },
  async getStatus() { return pluginModule.getStatus?.(createStatusContext()); },
  async update() { return pluginModule.update?.(createStatusContext()); },
  async getDefaultThinkingLevel() { return pluginModule.getDefaultThinkingLevel?.(createStatusContext()); },
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
};

createInterface({ input: process.stdin }).on("line", async (line) => {
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

process.on("disconnect", () => process.exit(0));
