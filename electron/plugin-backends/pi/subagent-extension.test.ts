import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

// The project currently has no declarations for worker-side .mjs modules.
// @ts-expect-error Hpp worker extension is intentionally shipped as ESM.
import { createHppSubagentExtension, normalizeTaskTimeout } from "./subagent-extension.mjs";
// @ts-expect-error Hpp child bridge is intentionally shipped as ESM.
import createHppSubagentBridgeExtension from "./subagent-bridge-extension.mjs";

describe("Pi built-in subagent extension", () => {
  it("defaults subagent tasks to 30 minutes and caps longer values", () => {
    expect(normalizeTaskTimeout(undefined)).toBe(30 * 60 * 1000);
    expect(normalizeTaskTimeout(300_000)).toBe(300_000);
    expect(normalizeTaskTimeout(60 * 60 * 1000)).toBe(30 * 60 * 1000);
  });

  it("answers child-agent questionnaire tools through RPC select dialogs", async () => {
    const tools: Array<Record<string, any>> = [];
    createHppSubagentBridgeExtension({ registerTool: (tool: Record<string, any>) => tools.push(tool), on: () => {} });
    const select = vi.fn()
      .mockResolvedValueOnce("Yes")
      .mockResolvedValueOnce("No");
    const questionnaire = tools.find((tool) => tool.name === "questionnaire");
    expect(questionnaire).toBeDefined();
    const result = await questionnaire!.execute(
      "questionnaire-1",
      {
        questions: [
          { id: "one", question: "继续吗？", options: [{ label: "Yes" }, { label: "No" }] },
          { id: "two", question: "发布吗？", options: [{ label: "Yes" }, { label: "No" }] },
        ],
      },
      new AbortController().signal,
      undefined,
      { hasUI: true, mode: "rpc", ui: { select } },
    );

    expect(select).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      details: {
        cancelled: false,
        answers: [
          { id: "one", answer: "Yes", values: ["Yes"] },
          { id: "two", answer: "No", values: ["No"] },
        ],
      },
    });
  });

  it("is a fallback behind an external same-name extension", () => {
    const builtInFactory = createHppSubagentExtension({
      packageRoot: "C:/pi-runtime",
      agentDir: "C:/pi-agent",
    });
    const externalFactory = (pi: { registerTool: (tool: { name: string; label: string }) => void }) => {
      pi.registerTool({ name: "subagent", label: "External Subagent" });
    };
    const extensions = [externalFactory, builtInFactory];
    const registered = extensions.flatMap((factory) => {
      const tools: Array<{ name: string; label: string }> = [];
      factory({ registerTool: (tool: { name?: unknown; label?: unknown }) => tools.push(tool as { name: string; label: string }) });
      return tools;
    });
    const firstRegistration = new Map<string, { name: string; label: string }>();
    for (const tool of registered) {
      if (!firstRegistration.has(tool.name)) firstRegistration.set(tool.name, tool);
    }

    expect(registered.map((tool) => tool.label)).toEqual(["External Subagent", "Subagent"]);
    expect(firstRegistration.get("subagent")).toMatchObject({ label: "External Subagent" });
  });

  it("does not register the fallback tool when built-in subagents are disabled", () => {
    const factory = createHppSubagentExtension({
      packageRoot: "C:/pi-runtime",
      agentDir: "C:/pi-agent",
      subagentConfig: { enabled: false },
    });
    const tools: Array<Record<string, unknown>> = [];
    factory({ registerTool: (tool: Record<string, unknown>) => tools.push(tool) });
    expect(tools).toEqual([]);
  });

  it("uses a configured profile model before inheriting the parent model", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-model-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:process.argv.join('|')}], stopReason:'stop', model:'test/child'}})+'\\n');",
      ].join("\\n"), "utf8");
      const factory = createHppSubagentExtension({
        packageRoot: root,
        agentDir: join(root, "agent"),
        subagentConfig: {
          enabled: true,
          defaultModelMode: "inherit",
          profiles: { scout: { modelMode: "custom", model: "configured/scout" } },
        },
      });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
      const result = await tools[0].execute(
        "call-model",
        { agent: "scout", task: "检查模型" },
        new AbortController().signal,
        undefined,
        { cwd: root, model: { provider: "parent", id: "model" }, hasUI: false },
      );
      expect(result.content[0].text).toContain("--model|configured/scout");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads the installed pi-fff package only for read-only built-in agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-fff-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:process.argv.join('|')}], stopReason:'stop', model:'test/child'}})+'\\n');",
      ].join("\\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        packages: ["npm:@ff-labs/pi-fff"],
      }), "utf8");
      const fffDir = join(agentDir, "npm", "node_modules", "@ff-labs", "pi-fff");
      await mkdir(join(fffDir, "src"), { recursive: true });
      await writeFile(join(fffDir, "package.json"), JSON.stringify({
        name: "@ff-labs/pi-fff",
        pi: { extensions: ["./src/index.ts"] },
      }), "utf8");
      const extensionPath = join(fffDir, "src", "index.ts");
      await writeFile(extensionPath, "export default function () {}\n", "utf8");

      const factory = createHppSubagentExtension({ packageRoot: root, agentDir });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const scoutResult = await tools[0].execute(
        "call-fff-scout",
        { agent: "scout", task: "使用 FFF 检查项目" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const workerResult = await tools[0].execute(
        "call-fff-worker",
        { agent: "worker", task: "不要加载 FFF" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );

      const scoutArgs = scoutResult.content[0].text;
      const workerArgs = workerResult.content[0].text;
      expect(scoutArgs).toContain(`--extension|${extensionPath}`);
      expect(scoutArgs).toContain("--tools|read,grep,find,ls,fffind,ffgrep,fff-multi-grep");
      expect(workerArgs).not.toContain(extensionPath);
      expect(workerArgs).not.toContain("fffind");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses manifest-declared subagent metadata for other Pi packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-manifest-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:process.argv.join('|')}], stopReason:'stop', model:'test/child'}})+'\\n');",
      ].join("\\n"), "utf8");
      const agentDir = join(root, "agent");
      const packageDir = join(agentDir, "npm", "node_modules", "@example", "search-extension");
      await mkdir(join(packageDir, "src"), { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        packages: ["npm:@example/search-extension@1.0.0"],
      }), "utf8");
      await writeFile(join(packageDir, "package.json"), JSON.stringify({
        name: "@example/search-extension",
        pi: {
          extensions: ["./src/index.ts"],
          subagent: { profiles: ["scout"], tools: ["example-search"] },
        },
      }), "utf8");
      const extensionPath = join(packageDir, "src", "index.ts");
      await writeFile(extensionPath, "export default function () {}\n", "utf8");

      const factory = createHppSubagentExtension({ packageRoot: root, agentDir });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
      const result = await tools[0].execute(
        "call-manifest-extension",
        { agent: "scout", task: "使用扩展检查项目" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );

      expect(result.content[0].text).toContain(`--extension|${extensionPath}`);
      expect(result.content[0].text).toContain("--tools|read,grep,find,ls,example-search");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs an isolated child Pi process and returns capped structured details", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'child summary'}], stopReason:'stop', model:'test/child'}})+'\\n');",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const result = await tools[0].execute(
        "call-1",
        { agent: "scout", task: "检查项目" },
        new AbortController().signal,
        () => undefined,
        {
          cwd: root,
          model: { provider: "test", id: "parent" },
          thinkingLevel: "low",
          hasUI: false,
        },
      );

      expect(result).toMatchObject({
        content: [{ type: "text", text: "child summary" }],
        details: {
          mode: "single",
          results: [expect.objectContaining({
            agent: "scout",
            output: "child summary",
            model: "test/child",
            exitCode: 0,
          })],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards RPC child permission requests through the host UI callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-rpc-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "import { createInterface } from 'node:readline';",
        "const rl = createInterface({input: process.stdin});",
        "rl.on('line', (line) => { const command = JSON.parse(line);",
        "if (command.type === 'prompt') process.stdout.write(JSON.stringify({type:'extension_ui_request', id:'child-confirm-1', method:'confirm', title:'Child permission', message:'Allow edit?'})+'\\n');",
        "if (command.type === 'extension_ui_response') { const text = command.confirmed ? 'child approved' : 'child denied'; process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text}], stopReason:'stop', model:'test/rpc-child'}})+'\\n'); process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n'); } });",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const requests: Array<Record<string, unknown>> = [];
      const factory = createHppSubagentExtension({
        packageRoot: root,
        agentDir,
        requestUI: async (request: Record<string, unknown>) => {
          requests.push(request);
          return { confirmed: true };
        },
      });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const result = await tools[0].execute(
        "call-rpc",
        { agent: "worker", task: "修改认证逻辑" },
        new AbortController().signal,
        () => undefined,
        {
          cwd: root,
          model: { provider: "test", id: "parent" },
          thinkingLevel: "low",
          hasUI: true,
        },
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        type: "extension_ui_request",
        method: "confirm",
        id: "child-confirm-1",
      });
      expect(result).toMatchObject({
        content: [{ type: "text", text: "child approved" }],
        details: { results: [expect.objectContaining({ model: "test/rpc-child", exitCode: 0 })] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a child task as timed out instead of waiting forever", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-timeout-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), "setInterval(() => {}, 1000);\n", "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const result = await tools[0].execute(
        "call-timeout",
        { agent: "scout", task: "等待超时", timeoutMs: 1000 },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );

      expect(result).toMatchObject({
        isError: true,
        details: { results: [expect.objectContaining({ stopReason: "timeout", exitCode: 1 })] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("registers the built-in tool when no external implementation exists", () => {
    const factory = createHppSubagentExtension({ packageRoot: "C:/pi-runtime", agentDir: "C:/pi-agent" });
    const tools: Array<Record<string, unknown>> = [];
    factory({ registerTool: (tool: Record<string, unknown>) => tools.push(tool) });

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "subagent", label: "Subagent" });
    expect(tools[0].parameters).toMatchObject({
      type: "object",
      properties: { timeoutMs: { default: 30 * 60 * 1000 } },
    });
  });
});
