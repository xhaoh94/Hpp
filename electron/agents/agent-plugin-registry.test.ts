import { existsSync } from "fs";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  userDataDir: "",
  appVersion: "1.0.0",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronState.userDataDir,
    getAppPath: () => process.cwd(),
    getVersion: () => electronState.appVersion,
    isPackaged: false,
  },
  BrowserWindow: {
    fromWebContents: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
  },
}));

import { AgentPluginRegistry } from "./agent-plugin-registry";

const backendModule = `
export function createAgentBackend(context) {
  let sessionFilePath = null;
  return {
    setWindow() {},
    async init(_projectPath, existingSessionFilePath, options) {
      sessionFilePath = existingSessionFilePath || options?.hostSystemPrompt || context.sessionId;
    },
    isIdle() { return true; },
    async sendMessage(message) {
      context.sendEvent({ type: "stream_delta", delta: message });
    },
    async abort() {},
    async getModels() {
      return [{ id: "model-a", name: "Model A", provider: "test", reasoning: false }];
    },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return sessionFilePath; },
  };
}
`;

const providerConfiguration = {
  type: "provider",
  storage: "hpp",
  endpoints: [{ id: "chat-completions", label: "Chat Completions" }],
  defaultEndpoint: "chat-completions",
  modelDefaults: { reasoning: false, imageInput: false },
  fixedModelCapabilities: false,
  modelListMode: "merge",
};

async function createPluginSource(
  root: string,
  id: string,
  version = "1.0.0",
  capabilities: Record<string, unknown> = { planMode: "prompt", guidance: false, fork: false, configuration: providerConfiguration },
  moduleSource = backendModule,
  manifestOverrides: Record<string, unknown> = {},
) {
  const pluginDir = join(root, `${id}-source`);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, "hpp-agent-plugin.json"), JSON.stringify({
    schemaVersion: 3,
    id,
    name: `Plugin ${id}`,
    version,
    minHppVersion: "0.0.1",
    entry: "agent.mjs",
    runtime: "plugin",
    capabilities,
    ...manifestOverrides,
  }, null, 2));
  await writeFile(join(pluginDir, "agent.mjs"), moduleSource);
  return pluginDir;
}

describe("AgentPluginRegistry", () => {
  let tempRoot = "";
  let registry: AgentPluginRegistry;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hpp-agent-registry-"));
    electronState.userDataDir = join(tempRoot, "user-data");
    electronState.appVersion = "1.0.0";
    registry = new AgentPluginRegistry();
  });

  afterEach(async () => {
    await registry.shutdown();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("starts with an empty catalog when no plugins are installed", async () => {
    await expect(registry.listAgents()).resolves.toEqual([]);
  });

  it("installs a directory plugin and creates its backend", async () => {
    const source = await createPluginSource(tempRoot, "fake-agent");
    const result = await registry.installFromPath(source);

    expect(result.success).toBe(true);
    expect(result.agent?.id).toBe("fake-agent");
    expect(result.agent?.capabilities.providerActivation).toBe("none");

    const backend = await registry.createBackend("fake-agent", "session-1");
    await backend.init(tempRoot);
    expect(backend.sessionFilePath).toBe("session-1");
    await expect(backend.getModels()).resolves.toEqual([
      { id: "model-a", name: "Model A", provider: "test", reasoning: false },
    ]);
  });

  it("passes host system prompt options to plugin init before runtime startup", async () => {
    const source = await createPluginSource(tempRoot, "host-prompt-agent");
    await expect(registry.installFromPath(source)).resolves.toMatchObject({ success: true });

    const backend = await registry.createBackend("host-prompt-agent", "session-1");
    await backend.init(tempRoot, undefined, { hostSystemPrompt: "Hpp host policy" });

    expect(backend.sessionFilePath).toBe("Hpp host policy");
  });

  it("waits for plugin capabilities across concurrent status checks", async () => {
    const source = await createPluginSource(
      tempRoot,
      "concurrent-status-agent",
      "1.0.0",
      undefined,
      `
await new Promise((resolve) => setTimeout(resolve, 40));
${backendModule}
export function getStatus() {
  return {
    installed: false,
    updateAvailable: false,
    canUpdate: true,
    latestVersion: "2.0.0",
  };
}
`,
    );
    await expect(registry.installFromPath(source)).resolves.toMatchObject({ success: true });

    const [first, second] = await Promise.all([
      registry.getStatus("concurrent-status-agent"),
      registry.getStatus("concurrent-status-agent"),
    ]);

    expect(first).toMatchObject({ installed: false, latestVersion: "2.0.0" });
    expect(second).toMatchObject({ installed: false, latestVersion: "2.0.0" });
  });

  it("preserves plugin-declared backend model visibility controls", async () => {
    const source = await createPluginSource(tempRoot, "visibility-agent", "1.0.0", {
      planMode: "prompt",
      guidance: false,
      fork: false,
      configuration: {
        ...providerConfiguration,
        backendModelVisibility: {
          userConfigurable: true,
          defaultVisible: false,
          label: "显示官方模型",
        },
      },
    });

    const result = await registry.installFromPath(source);

    expect(result.agent?.capabilities.configuration).toMatchObject({
      backendModelVisibility: {
        userConfigurable: true,
        defaultVisible: false,
        label: "显示官方模型",
      },
    });
  });

  it("rejects plugins that require a newer Hpp version", async () => {
    const source = await createPluginSource(tempRoot, "future-agent", "1.0.0", undefined, backendModule, {
      minHppVersion: "1.1.0",
    });

    const result = await registry.installFromPath(source);

    expect(result.success).toBe(false);
    expect(result.error).toContain("需要 Hpp v1.1.0");
    await expect(registry.listAgents()).resolves.toEqual([]);
  });

  it("accepts plugins whose minimum Hpp version is equal or lower", async () => {
    const equalSource = await createPluginSource(tempRoot, "equal-agent", "1.0.0", undefined, backendModule, {
      minHppVersion: "1.0.0",
    });
    const lowerSource = await createPluginSource(tempRoot, "lower-agent", "1.0.0", undefined, backendModule, {
      minHppVersion: "0.9.0",
    });

    await expect(registry.installFromPath(equalSource)).resolves.toMatchObject({ success: true });
    await expect(registry.installFromPath(lowerSource)).resolves.toMatchObject({ success: true });
  });

  it("rejects legacy schema plugins as new installations", async () => {
    const source = await createPluginSource(tempRoot, "legacy-agent", "1.0.0", undefined, backendModule, {
      schemaVersion: 2,
    });

    const result = await registry.installFromPath(source);

    expect(result.success).toBe(false);
    expect(result.error).toContain("schemaVersion 必须为 3");
  });

  it("continues loading legacy schema plugins that were already installed", async () => {
    const pluginRoot = join(electronState.userDataDir, "hpp-data", "agent-plugins");
    await mkdir(pluginRoot, { recursive: true });
    await createPluginSource(pluginRoot, "legacy-installed", "1.0.0", undefined, backendModule, {
      schemaVersion: 2,
      minHppVersion: undefined,
    });

    await expect(registry.listAgents()).resolves.toEqual([
      expect.objectContaining({ id: "legacy-installed", minHppVersion: "0.0.0-0" }),
    ]);
  });

  it("forces plugin events to the backend agent and session", async () => {
    const source = await createPluginSource(tempRoot, "event-agent");
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("event-agent", "session-1", {
      window: { webContents: { send } } as never,
    });

    await backend.sendMessage("hello", undefined, { clientMessageId: "client-message-1" });

    expect(send).toHaveBeenCalledWith("agent:event", expect.objectContaining({
      type: "stream_delta",
      delta: "hello",
      lifecycleRevision: expect.stringMatching(/^plugin-backend-\d+:[0-9a-f-]+:1$/),
      clientUserMessageId: "client-message-1",
      sessionId: "session-1",
      agentId: "event-agent",
    }));

    const firstRevision = send.mock.calls.find((call) => call[1].type === "stream_delta")?.[1].lifecycleRevision;
    await backend.sendMessage("again", undefined, { clientMessageId: "client-message-2" });
    const secondTurnEvent = [...send.mock.calls].reverse().find((call) => call[1].type === "stream_delta")?.[1];
    const secondRevision = secondTurnEvent?.lifecycleRevision;
    expect(secondRevision).not.toBe(firstRevision);
    expect(secondTurnEvent).toMatchObject({
      clientUserMessageId: "client-message-2",
    });
  });

  it("overrides conflicting plugin lifecycle identity with the host-owned turn", async () => {
    const source = await createPluginSource(
      tempRoot,
      "spoofed-lifecycle-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  return {
    setWindow() {},
    async init() {},
    isIdle() { return true; },
    async sendMessage() {
      context.sendEvent({
        type: "stream_delta",
        delta: "hello",
        lifecycleRevision: "plugin-owned-revision",
        clientUserMessageId: "plugin-owned-message",
      });
    },
    async abort() {},
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("spoofed-lifecycle-agent", "session-1", {
      window: { webContents: { send } } as never,
    });

    await backend.sendMessage("hello", undefined, { clientMessageId: "host-message" });

    expect(send).toHaveBeenCalledWith("agent:event", expect.objectContaining({
      type: "stream_delta",
      lifecycleRevision: expect.stringMatching(/^plugin-backend-\d+:[0-9a-f-]+:1$/),
      clientUserMessageId: "host-message",
    }));
    expect(send).not.toHaveBeenCalledWith("agent:event", expect.objectContaining({
      lifecycleRevision: "plugin-owned-revision",
    }));
  });

  it("updates cached backend idle state from plugin lifecycle events", async () => {
    const source = await createPluginSource(
      tempRoot,
      "idle-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    setWindow() {},
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
      setTimeout(() => {
        idle = true;
        context.sendEvent({ type: "stream_end" });
      }, 20);
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const backend = await registry.createBackend("idle-agent", "session-1", {
      window: { webContents: { send: vi.fn() } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello");
    expect(backend.isIdle()).toBe(false);
    await vi.waitFor(() => expect(backend.isIdle()).toBe(true));
  });

  it("does not treat agent_end as authoritative while the backend is still busy", async () => {
    const source = await createPluginSource(
      tempRoot,
      "retrying-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    setWindow() {},
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
      setTimeout(() => context.sendEvent({ type: "agent_end" }), 10);
      setTimeout(() => {
        idle = true;
        context.sendEvent({ type: "stream_end" });
      }, 100);
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("retrying-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(
      "agent:event",
      expect.objectContaining({ type: "agent_end" }),
    ));
    expect(backend.isIdle()).toBe(false);
    await vi.waitFor(() => expect(backend.isIdle()).toBe(true));
  });

  it("emits backend_idle when an agent_end-only turn becomes idle later", async () => {
    const source = await createPluginSource(
      tempRoot,
      "delayed-idle-agent-end-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    setWindow() {},
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
      context.sendEvent({ type: "agent_end" });
      setTimeout(() => { idle = true; }, 80);
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("delayed-idle-agent-end-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello", undefined, { clientMessageId: "delayed-idle-user" });

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(
      "agent:event",
      expect.objectContaining({
        type: "backend_idle",
        clientUserMessageId: "delayed-idle-user",
      }),
    ));
    const agentEnd = send.mock.calls.find((call) => call[1].type === "agent_end")?.[1];
    const backendIdle = send.mock.calls.find((call) => call[1].type === "backend_idle")?.[1];
    expect(backendIdle.lifecycleRevision).toBe(agentEnd.lifecycleRevision);
    expect(backend.isIdle()).toBe(true);
  });

  it("does not postpone agent_end reconciliation for trailing terminal records", async () => {
    const source = await createPluginSource(
      tempRoot,
      "agent-end-tail-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    setWindow() {},
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
      setTimeout(() => {
        context.sendEvent({ type: "agent_end" });
        context.sendEvent({ type: "tool_end", toolCallId: "tail-tool" });
        context.sendEvent({ type: "thinking_end" });
        context.sendEvent({ type: "plan_update", steps: [{ step: "done", status: "completed" }] });
        context.sendEvent({ type: "stream_delta", delta: "" });
        setTimeout(() => { idle = true; }, 20);
      }, 10);
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("agent-end-tail-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello", undefined, { clientMessageId: "tail-user" });

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(
      "agent:event",
      expect.objectContaining({ type: "backend_idle", clientUserMessageId: "tail-user" }),
    ));
    const agentEnd = send.mock.calls.find((call) => call[1].type === "agent_end")?.[1];
    const backendIdle = send.mock.calls.find((call) => call[1].type === "backend_idle")?.[1];
    expect(backendIdle.lifecycleRevision).toBe(agentEnd.lifecycleRevision);
  });

  it("gives an independent post-turn compaction a lifecycle that backend_idle can close", async () => {
    const source = await createPluginSource(
      tempRoot,
      "post-turn-compaction-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    setWindow() {},
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
      idle = true;
      context.sendEvent({ type: "stream_end", content: "done" });
      setTimeout(() => {
        idle = false;
        context.sendEvent({ type: "context_compaction", id: "compact-1", phase: "started" });
        setTimeout(() => { idle = true; }, 20);
      }, 10);
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("post-turn-compaction-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);
    await backend.sendMessage("hello", undefined, { clientMessageId: "completed-turn-user" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(
      "agent:event",
      expect.objectContaining({ type: "context_compaction", phase: "started" }),
    ));
    await new Promise((resolve) => setTimeout(resolve, 40));

    await backend.refreshIdle!();

    const streamEnd = send.mock.calls.find((call) => call[1].type === "stream_end")?.[1];
    const compaction = send.mock.calls.find((call) => call[1].type === "context_compaction")?.[1];
    const backendIdle = send.mock.calls.find((call) => call[1].type === "backend_idle")?.[1];
    expect(compaction.lifecycleRevision).not.toBe(streamEnd.lifecycleRevision);
    expect(compaction.clientUserMessageId).toBeUndefined();
    expect(backendIdle).toMatchObject({
      lifecycleRevision: compaction.lifecycleRevision,
      sessionId: "session-1",
    });
  });

  it("does not treat stream_end as idle before the plugin backend settles", async () => {
    const source = await createPluginSource(
      tempRoot,
      "slow-stream-end-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    setWindow() {},
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
      setTimeout(() => {
        context.sendEvent({ type: "stream_end" });
        setTimeout(() => {
          idle = true;
        }, 80);
      }, 10);
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("slow-stream-end-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(
      "agent:event",
      expect.objectContaining({ type: "stream_end" }),
    ));
    expect(backend.isIdle()).toBe(false);
    await vi.waitFor(() => expect(backend.isIdle()).toBe(true));
  });

  it("refreshes idle after send resolves even when a plugin omits terminal events", async () => {
    const source = await createPluginSource(
      tempRoot,
      "missing-terminal-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    setWindow() {},
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      idle = true;
    },
    async abort() { idle = true; },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("missing-terminal-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello", undefined, { clientMessageId: "missing-terminal-message" });

    expect(backend.isIdle()).toBe(true);
    const streamStart = send.mock.calls.find((call) => call[1].type === "stream_start")?.[1];
    const backendIdle = send.mock.calls.find((call) => call[1].type === "backend_idle")?.[1];
    expect(backendIdle).toMatchObject({
      lifecycleRevision: streamStart.lifecycleRevision,
      clientUserMessageId: "missing-terminal-message",
      sessionId: "session-1",
    });
  });

  it("does not treat a missing optional isIdle result as authoritative idle", async () => {
    const source = await createPluginSource(
      tempRoot,
      "no-idle-probe-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  return {
    setWindow() {},
    async init() {},
    async sendMessage() { context.sendEvent({ type: "stream_start" }); },
    async abort() {},
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("no-idle-probe-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello", undefined, { clientMessageId: "no-idle-user" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(backend.isIdle()).toBe(false);
    expect(send.mock.calls.some((call) => call[1].type === "backend_idle")).toBe(false);
  });

  it("does not synthesize backend_idle from agent_end when isIdle is unavailable", async () => {
    const source = await createPluginSource(
      tempRoot,
      "agent-end-without-idle-probe-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  return {
    setWindow() {},
    async init() {},
    async sendMessage() {
      context.sendEvent({ type: "stream_start" });
      context.sendEvent({ type: "agent_end" });
    },
    async abort() {},
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("agent-end-without-idle-probe-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello", undefined, { clientMessageId: "no-idle-agent-end-user" });
    await new Promise((resolve) => setTimeout(resolve, 850));

    expect(backend.isIdle()).toBe(false);
    expect(send.mock.calls.some((call) => call[1].type === "backend_idle")).toBe(false);
    await expect(backend.refreshIdle!()).rejects.toThrow("does not implement isIdle");
  });

  it("does not reopen a legacy backend for records trailing an explicit terminal", async () => {
    const source = await createPluginSource(
      tempRoot,
      "legacy-terminal-tail-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  return {
    setWindow() {},
    async init() {},
    async sendMessage() {
      context.sendEvent({ type: "stream_start" });
      context.sendEvent({ type: "stream_end" });
      context.sendEvent({ type: "agent_end" });
      context.sendEvent({ type: "stream_delta", delta: "late tail" });
      context.sendEvent({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "late terminal detail",
        state: "error",
      });
    },
    async abort() {},
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("legacy-terminal-tail-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello");

    expect(send.mock.calls.map((call) => call[1].type)).toEqual(expect.arrayContaining([
      "stream_end",
      "agent_end",
      "stream_delta",
      "process_event",
    ]));
    expect(backend.isIdle()).toBe(true);
    await expect(backend.refreshIdle!()).resolves.toBe(true);
  });

  it("settles an independent completed compaction without isIdle support", async () => {
    const source = await createPluginSource(
      tempRoot,
      "legacy-compaction-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  return {
    setWindow() {},
    async init() {},
    async sendMessage() {
      context.sendEvent({ type: "stream_start" });
      context.sendEvent({ type: "stream_end" });
      context.sendEvent({ type: "context_compaction", id: "compact-1", phase: "started" });
      context.sendEvent({ type: "context_compaction", id: "compact-1", phase: "completed" });
    },
    async abort() {},
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("legacy-compaction-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello");

    expect(backend.isIdle()).toBe(true);
    await expect(backend.refreshIdle!()).resolves.toBe(true);
    const streamEnd = send.mock.calls.find((call) => call[1].type === "stream_end")?.[1];
    const compactionStart = send.mock.calls.find((call) => (
      call[1].type === "context_compaction" && call[1].phase === "started"
    ))?.[1];
    expect(compactionStart.lifecycleRevision).not.toBe(streamEnd.lifecycleRevision);
  });

  it("does not let active-turn compaction completion end a legacy turn", async () => {
    const source = await createPluginSource(
      tempRoot,
      "legacy-active-compaction-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  return {
    setWindow() {},
    async init() {},
    async sendMessage() {
      context.sendEvent({ type: "stream_start" });
      context.sendEvent({ type: "context_compaction", id: "compact-1", phase: "started" });
      context.sendEvent({ type: "context_compaction", id: "compact-1", phase: "completed" });
    },
    async abort() {},
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const backend = await registry.createBackend("legacy-active-compaction-agent", "session-1", {
      window: { webContents: { send: vi.fn() } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello");

    expect(backend.isIdle()).toBe(false);
    await expect(backend.refreshIdle!()).rejects.toThrow("does not implement isIdle");
  });

  it("stamps restored activity and closes it when the backend becomes idle without a host send", async () => {
    const source = await createPluginSource(
      tempRoot,
      "restored-activity-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = false;
  context.sendEvent({ type: "stream_start" });
  return {
    setWindow() {},
    async init() { idle = true; },
    isIdle() { return idle; },
    async sendMessage() {},
    async abort() { idle = true; },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("restored-activity-agent", "session-1", {
      window: { webContents: { send } } as never,
    });

    await backend.init(tempRoot);

    const streamStart = send.mock.calls.find((call) => call[1].type === "stream_start")?.[1];
    const backendIdle = send.mock.calls.find((call) => call[1].type === "backend_idle")?.[1];
    expect(streamStart.lifecycleRevision).toMatch(/^plugin-backend-\d+:[0-9a-f-]+:1$/);
    expect(backendIdle).toMatchObject({ lifecycleRevision: streamStart.lifecycleRevision });
    expect(backend.isIdle()).toBe(true);
  });

  it("returns the guarded busy cache when an idle refresh is invalidated by a new turn", async () => {
    const source = await createPluginSource(
      tempRoot,
      "public-idle-race-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  let idleReads = 0;
  return {
    setWindow() {},
    async init() {},
    async isIdle() {
      const snapshot = idle;
      idleReads += 1;
      if (snapshot && idleReads > 1) await new Promise((resolve) => setTimeout(resolve, 100));
      return snapshot;
    },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
    },
    async abort() { idle = true; },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const backend = await registry.createBackend("public-idle-race-agent", "session-1", {
      window: { webContents: { send: vi.fn() } } as never,
    });
    await backend.init(tempRoot);

    const staleRefresh = backend.refreshIdle!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await backend.sendMessage("new turn");

    await expect(staleRefresh).resolves.toBe(false);
    expect(backend.isIdle()).toBe(false);
  });

  it("ignores stale out-of-order idle query results", async () => {
    const source = await createPluginSource(
      tempRoot,
      "idle-query-race-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  let delayBusyQuery = false;
  return {
    setWindow() {},
    async init() {},
    async isIdle() {
      const snapshot = idle;
      if (!snapshot && delayBusyQuery) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return snapshot;
    },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
      setTimeout(() => {
        delayBusyQuery = true;
        context.sendEvent({ type: "stream_end" });
        setTimeout(() => {
          idle = true;
          context.sendEvent({ type: "agent_end" });
        }, 15);
      }, 10);
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const backend = await registry.createBackend("idle-query-race-agent", "session-1", {
      window: { webContents: { send: vi.fn() } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello");
    await vi.waitFor(() => expect(backend.isIdle()).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(backend.isIdle()).toBe(true);
  });

  it("closes an errored process only after the backend confirms it is idle", async () => {
    const source = await createPluginSource(
      tempRoot,
      "failed-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    setWindow() {},
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
      setTimeout(() => {
        idle = true;
        context.sendEvent({
          type: "process_event",
          entryType: "error",
          kind: "error",
          title: "Request failed",
          state: "error",
        });
      }, 20);
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("failed-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello");
    expect(backend.isIdle()).toBe(false);
    await vi.waitFor(() => expect(backend.isIdle()).toBe(true));
    expect(send).toHaveBeenCalledWith("agent:event", expect.objectContaining({
      type: "backend_idle",
      lifecycleRevision: expect.stringMatching(/^plugin-backend-\d+:[0-9a-f-]+:1$/),
    }));
  });

  it("keeps the turn open when a process errors but the backend remains busy", async () => {
    const source = await createPluginSource(
      tempRoot,
      "busy-after-error-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    setWindow() {},
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
      context.sendEvent({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "Recoverable tool failure",
        state: "error",
      });
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("busy-after-error-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello");
    await backend.refreshIdle!();

    expect(backend.isIdle()).toBe(false);
    expect(send.mock.calls.some((call) => call[1].type === "backend_idle")).toBe(false);
  });

  it("settles a restored process error immediately when the backend is already idle", async () => {
    const source = await createPluginSource(
      tempRoot,
      "restored-idle-error-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  return {
    setWindow() {},
    async init() {
      context.sendEvent({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "Recovered tool failure",
        state: "error",
      });
    },
    isIdle() { return true; },
    async sendMessage() {},
    async abort() {},
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("restored-idle-error-agent", "session-1", {
      window: { webContents: { send } } as never,
    });

    await backend.init(tempRoot);

    const processError = send.mock.calls.find((call) => call[1].type === "process_event")?.[1];
    const backendIdle = send.mock.calls.find((call) => call[1].type === "backend_idle")?.[1];
    expect(processError.lifecycleRevision).toMatch(/^plugin-backend-\d+:[0-9a-f-]+:1$/);
    expect(backendIdle).toMatchObject({ lifecycleRevision: processError.lifecycleRevision });
    expect(backend.isIdle()).toBe(true);
  });

  it("reconciles idle immediately after answering a question held open past stream_end", async () => {
    const source = await createPluginSource(
      tempRoot,
      "pending-answer-idle-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    setWindow() {},
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
      context.sendEvent({ type: "ask_user_question", id: "question-1", question: "Continue?" });
      idle = true;
      context.sendEvent({ type: "stream_end" });
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    async sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("pending-answer-idle-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await backend.sendMessage("hello", undefined, { clientMessageId: "pending-answer-user" });
    expect(send.mock.calls.some((call) => call[1].type === "backend_idle")).toBe(false);
    const streamStart = send.mock.calls.find((call) => call[1].type === "stream_start")?.[1];

    await backend.sendUIResponse({ id: "question-1", text: "yes" });

    expect(send).toHaveBeenCalledWith("agent:event", expect.objectContaining({
      type: "backend_idle",
      lifecycleRevision: streamStart.lifecycleRevision,
      clientUserMessageId: "pending-answer-user",
    }));
    expect(backend.isIdle()).toBe(true);
  });

  it("rejects malformed plugin events", async () => {
    const source = await createPluginSource(
      tempRoot,
      "invalid-event-agent",
      "1.0.0",
      undefined,
      backendModule.replace(
        'context.sendEvent({ type: "stream_delta", delta: message });',
        'context.sendEvent({ delta: message });',
      ),
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("invalid-event-agent", "session-1", {
      window: { webContents: { send } } as never,
    });

    await expect(backend.sendMessage("hello", undefined, { clientMessageId: "failed-client-message" }))
      .rejects.toThrow("non-empty type");
    expect(send).toHaveBeenCalledWith("agent:event", expect.objectContaining({
      type: "turn_failed",
      lifecycleRevision: expect.stringMatching(/^plugin-backend-\d+:[0-9a-f-]+:1$/),
      clientUserMessageId: "failed-client-message",
    }));
  });

  it("disposes active backends before shutting down the plugin host", async () => {
    const source = await createPluginSource(
      tempRoot,
      "shutdown-agent",
      "1.0.0",
      undefined,
      `
import { writeFile } from "node:fs/promises";
export function createAgentBackend(context) {
  return {
    async init() {},
    isIdle() { return true; },
    async sendMessage() {},
    async abort() {},
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    async dispose() { await writeFile(context.pluginDir + "/disposed.marker", "done", "utf8"); },
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const backend = await registry.createBackend("shutdown-agent", "session-1");
    await backend.init(tempRoot);

    await registry.shutdown();

    const installedDir = join(electronState.userDataDir, "hpp-data", "agent-plugins", "shutdown-agent");
    expect(existsSync(join(installedDir, "disposed.marker"))).toBe(true);
  });

  it("resolves status requests that are pending during final shutdown", async () => {
    const source = await createPluginSource(
      tempRoot,
      "status-shutdown-agent",
      "1.0.0",
      undefined,
      `
import { writeFile } from "node:fs/promises";
${backendModule}
export async function getStatus(context) {
  await writeFile(context.pluginDir + "/status-started.marker", "started", "utf8");
  await new Promise(() => {});
}
`,
    );
    await registry.installFromPath(source);
    const installedDir = join(electronState.userDataDir, "hpp-data", "agent-plugins", "status-shutdown-agent");

    const pendingStatus = registry.getStatus("status-shutdown-agent");
    await vi.waitFor(() => expect(existsSync(join(installedDir, "status-started.marker"))).toBe(true));
    await registry.shutdown(true);

    await expect(pendingStatus).resolves.toMatchObject({
      installed: true,
      currentVersion: "1.0.0",
      updateAvailable: false,
    });
    await expect(registry.getStatus("status-shutdown-agent")).resolves.toMatchObject({
      installed: true,
      currentVersion: "1.0.0",
      updateAvailable: false,
    });
  });

  it("notifies sessions when the plugin host crashes", async () => {
    const source = await createPluginSource(
      tempRoot,
      "crash-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend() {
  return {
    async init() {},
    isIdle() { return false; },
    async sendMessage() { process.exit(12); },
    async abort() {},
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("crash-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);

    await expect(backend.sendMessage("crash")).rejects.toThrow(/Plugin host (?:exited|output pipe closed)/);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("agent:event", expect.objectContaining({
      type: "agent_disconnected",
      sessionId: "session-1",
      agentId: "crash-agent",
    })));
  });

  it("propagates plugin UI response failures to the host", async () => {
    const source = await createPluginSource(
      tempRoot,
      "ui-response-failure-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend() {
  return {
    async init() {},
    isIdle() { return false; },
    async sendMessage() {},
    async abort() {},
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    async sendUIResponse() { throw new Error("plugin response failed"); },
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const backend = await registry.createBackend("ui-response-failure-agent", "session-1");
    await backend.init(tempRoot);

    await expect(backend.sendUIResponse({ id: "question-1", text: "answer" }))
      .rejects.toThrow("plugin response failed");
  });

  it("rejects UI responses when a plugin backend omits the required method", async () => {
    const source = await createPluginSource(
      tempRoot,
      "missing-ui-response-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend() {
  return {
    async init() {},
    isIdle() { return true; },
    async sendMessage() {},
    async abort() {},
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const backend = await registry.createBackend("missing-ui-response-agent", "session-1");
    await backend.init(tempRoot);

    await expect(backend.sendUIResponse({ id: "question-1", text: "answer" }))
      .rejects.toThrow("Plugin backend is missing sendUIResponse()");
  });

  it("terminalizes busy sessions when the plugin host emits an error without exiting", async () => {
    const source = await createPluginSource(
      tempRoot,
      "host-error-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("host-error-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);
    await backend.sendMessage("start");
    expect(backend.isIdle()).toBe(false);

    const records = (registry as unknown as {
      pluginRecords: Map<string, { process?: { child?: { emit: (event: string, error: Error) => void } } }>;
    }).pluginRecords;
    const child = records.get("host-error-agent")?.process?.child;
    expect(child).toBeDefined();
    child!.emit("error", new Error("simulated host transport failure"));

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("agent:event", expect.objectContaining({
      type: "agent_disconnected",
      reason: "plugin-host-error",
      detail: "simulated host transport failure",
      sessionId: "session-1",
      agentId: "host-error-agent",
    })));
    expect(backend.isIdle()).toBe(true);
  });

  it("terminalizes busy sessions when the plugin host stdin emits an error", async () => {
    const source = await createPluginSource(
      tempRoot,
      "host-stdin-error-agent",
      "1.0.0",
      undefined,
      `
export function createAgentBackend(context) {
  let idle = true;
  return {
    async init() {},
    isIdle() { return idle; },
    async sendMessage() {
      idle = false;
      context.sendEvent({ type: "stream_start" });
    },
    async abort() { idle = true; context.sendEvent({ type: "aborted" }); },
    async getModels() { return []; },
    async setModel() {},
    async setThinkingLevel() {},
    async sendUIResponse() {},
    dispose() {},
    get sessionFilePath() { return null; },
  };
}
`,
    );
    await registry.installFromPath(source);
    const send = vi.fn();
    const backend = await registry.createBackend("host-stdin-error-agent", "session-1", {
      window: { webContents: { send } } as never,
    });
    await backend.init(tempRoot);
    await backend.sendMessage("start");
    expect(backend.isIdle()).toBe(false);

    const records = (registry as unknown as {
      pluginRecords: Map<string, {
        process?: { child?: { stdin: { emit: (event: string, error: Error) => void } } };
      }>;
    }).pluginRecords;
    const child = records.get("host-stdin-error-agent")?.process?.child;
    expect(child).toBeDefined();
    child!.stdin.emit("error", new Error("simulated plugin stdin failure"));

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("agent:event", expect.objectContaining({
      type: "agent_disconnected",
      reason: "plugin-host-stdin-error",
      detail: "simulated plugin stdin failure",
      sessionId: "session-1",
      agentId: "host-stdin-error-agent",
    })));
    expect(backend.isIdle()).toBe(true);
    await expect(backend.sendUIResponse({ id: "question-1", text: "answer" }))
      .rejects.toThrow("simulated plugin stdin failure");
  });

  it("allows installing an official plugin id as a normal plugin", async () => {
    const source = await createPluginSource(tempRoot, "codex");
    const result = await registry.installFromPath(source);

    expect(result.success).toBe(true);
    expect(result.agent?.id).toBe("codex");
  });

  it("treats an existing but unusable CLI command as not installed", async () => {
    const brokenCommand = join(tempRoot, "broken-command");
    await writeFile(brokenCommand, "not an executable", "utf8");
    const source = await createPluginSource(
      tempRoot,
      "broken-cli",
      "1.0.0",
      undefined,
      backendModule,
      { runtime: "cli", command: brokenCommand },
    );
    await expect(registry.installFromPath(source)).resolves.toMatchObject({ success: true });

    await expect(registry.getStatus("broken-cli")).resolves.toMatchObject({
      installed: false,
      updateAvailable: false,
    });
    expect((await registry.getStatus("broken-cli")).error).toContain("点击安装进行修复");
  });

  it("delegates single-active provider activation to the plugin hook", async () => {
    const source = await createPluginSource(
      tempRoot,
      "activating-agent",
      "1.0.0",
      {
        planMode: "prompt",
        guidance: false,
        fork: false,
        configuration: providerConfiguration,
        providerActivation: "single-active",
      },
      `${backendModule}
export const configProvider = {
  activateProvider(context, args) {
    return {
      snapshots: [{ filePath: args.providerId, existed: false, content: context.agentId }]
    };
  }
};
`
    );
    await expect(registry.installFromPath(source)).resolves.toMatchObject({ success: true });

    await expect(registry.activateProvider("activating-agent", {
      providerId: "provider-a",
      provider: { providerId: "provider-a" },
      state: { providers: [] },
    })).resolves.toEqual({
      snapshots: [{ filePath: "provider-a", existed: false, content: "activating-agent" }],
    });
  });

  it("rejects provider activation without the single-active capability", async () => {
    const source = await createPluginSource(tempRoot, "passive-agent");
    await expect(registry.installFromPath(source)).resolves.toMatchObject({ success: true });

    await expect(registry.activateProvider("passive-agent", {
      providerId: "provider-a",
      provider: { providerId: "provider-a" },
      state: { providers: [] },
    })).rejects.toThrow("不支持");
  });

  it("delegates provider configuration reads and writes to plugin hooks", async () => {
    const source = await createPluginSource(
      tempRoot,
      "config-agent",
      "1.0.0",
      { planMode: "prompt", guidance: false, fork: false, configuration: { ...providerConfiguration, storage: "plugin" } },
      `${backendModule}
export const configProvider = {
  read() {
    return { providers: [{ providerId: "native" }] };
  },
  write(_context, { state }) {
    return { snapshots: [{ filePath: state.providers[0].providerId, existed: false, content: "" }] };
  }
};
`
    );
    await expect(registry.installFromPath(source)).resolves.toMatchObject({ success: true });
    await expect(registry.readProviderConfig("config-agent")).resolves.toEqual({
      providers: [{ providerId: "native" }],
    });
    await expect(registry.writeProviderConfig("config-agent", {
      providers: [{ providerId: "saved" }],
    })).resolves.toEqual({
      snapshots: [{ filePath: "saved", existed: false, content: "" }],
    });
  });

  it("rejects replacement when the caller reports active sessions", async () => {
    const source = await createPluginSource(tempRoot, "replace-agent", "1.0.0");
    const updateSource = await createPluginSource(tempRoot, "replace-agent", "2.0.0");
    await expect(registry.installFromPath(source)).resolves.toMatchObject({ success: true });

    const result = await registry.installFromPath(updateSource, { canReplace: () => false });

    expect(result.success).toBe(false);
    expect(result.error).toContain("仍有会话");
  });

  it("rejects install when the expected official plugin id does not match", async () => {
    const source = await createPluginSource(tempRoot, "unexpected-agent");
    const result = await registry.installFromPath(source, { expectedAgentId: "expected-agent" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("插件 ID 与预期不匹配");
    await expect(registry.listAgents()).resolves.toEqual([]);
  });

  it("rejects zip entries that escape the plugin root", async () => {
    const zip = new AdmZip();
    zip.addFile("hpp-agent-plugin.json", Buffer.from(JSON.stringify({
      schemaVersion: 3,
      id: "zip-agent",
      name: "Zip Agent",
      version: "1.0.0",
      minHppVersion: "0.0.1",
      entry: "agent.mjs",
    })));
    zip.addFile("agent.mjs", Buffer.from(backendModule));
    zip.addFile("C:/evil.txt", Buffer.from("nope"));
    const zipPath = join(tempRoot, "zip-agent.zip");
    zip.writeZip(zipPath);

    const result = await registry.installFromPath(zipPath);

    expect(result.success).toBe(false);
    expect(result.error).toContain("非法路径");
  });
});
