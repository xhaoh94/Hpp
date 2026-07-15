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
    async init(_projectPath, existingSessionFilePath) {
      sessionFilePath = existingSessionFilePath || context.sessionId;
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

    await backend.sendMessage("hello");

    expect(send).toHaveBeenCalledWith("agent:event", {
      type: "stream_delta",
      delta: "hello",
      sessionId: "session-1",
      agentId: "event-agent",
    });
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
    const backend = await registry.createBackend("invalid-event-agent", "session-1", {
      window: { webContents: { send: vi.fn() } } as never,
    });

    await expect(backend.sendMessage("hello")).rejects.toThrow("non-empty type");
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

    await expect(backend.sendMessage("crash")).rejects.toThrow("Plugin host exited");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("agent:event", expect.objectContaining({
      type: "agent_disconnected",
      sessionId: "session-1",
      agentId: "crash-agent",
    })));
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
