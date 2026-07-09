import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronState.userDataDir,
    getVersion: () => "0.0.0-test",
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

async function createPluginSource(
  root: string,
  id: string,
  version = "1.0.0",
  capabilities: Record<string, unknown> = { planMode: "prompt", guidance: false, fork: false, configuration: "openai-compatible" },
  moduleSource = backendModule,
) {
  const pluginDir = join(root, `${id}-source`);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, "hpp-agent-plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name: `Plugin ${id}`,
    version,
    entry: "agent.mjs",
    runtime: "plugin",
    capabilities,
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
    registry = new AgentPluginRegistry();
  });

  afterEach(async () => {
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

  it("allows installing an official plugin id as a normal plugin", async () => {
    const source = await createPluginSource(tempRoot, "codex");
    const result = await registry.installFromPath(source);

    expect(result.success).toBe(true);
    expect(result.agent?.id).toBe("codex");
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
        configuration: "openai-compatible",
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
      schemaVersion: 1,
      id: "zip-agent",
      name: "Zip Agent",
      version: "1.0.0",
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
