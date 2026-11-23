import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

// The project currently has no declarations for worker-side .mjs modules.
// @ts-expect-error Hpp worker extension is intentionally shipped as ESM.
import { createHppSubagentExtension, normalizeHppSubagentConfig, normalizeTaskTimeout } from "./subagent-extension.mjs";
// @ts-expect-error Hpp child bridge is intentionally shipped as ESM.
import createHppSubagentBridgeExtension from "./subagent-bridge-extension.mjs";

describe("Pi built-in subagent extension", () => {
  it("leaves subagent tasks without a wall-clock timeout unless one is asked for", () => {
    // 上游（Claude Code / Codex / Hpp Agent 工具）都没有运行时长上限，Hpp 不再自己加。
    expect(normalizeTaskTimeout(undefined)).toBe(0);
    expect(normalizeTaskTimeout(0)).toBe(0);
    expect(normalizeTaskTimeout(-1)).toBe(0);
    expect(normalizeTaskTimeout(300_000)).toBe(300_000);
    // 显式传的时限原样保留，不再被 30 分钟砍半。
    expect(normalizeTaskTimeout(60 * 60 * 1000)).toBe(60 * 60 * 1000);
  });

  it("exposes a display-only title in the tool schema and passes it through results", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-title-"));
    try {
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir: join(root, "agent") });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
      const tool = tools[0];
      const props = tool.parameters.properties;
      expect(props.title).toMatchObject({ type: "string" });
      expect(props.tasks.items.properties.title).toMatchObject({ type: "string" });
      expect(props.chain.items.properties.title).toMatchObject({ type: "string" });
      // 未知 agent 的早退分支也要带 title，界面失败时仍能显示短标题。
      const result = await tool.execute(
        "call-title",
        { agent: "no-such-agent", task: "做事", title: "补齐静态红点" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(result.details.results[0]).toMatchObject({ title: "补齐静态红点" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not give subagents any question tool", async () => {
    // 子 Agent 不允许向用户提问：多个子任务并行时，宿主无法判断该由哪个子 agent
    // 承担这次交互，用户的回答也只会卡住其中一个子任务。需要决策时子 agent
    // 只能把问题写进结果，由主 agent 转述。
    const tools: Array<Record<string, any>> = [];
    const on = vi.fn();
    createHppSubagentBridgeExtension({ registerTool: (tool: Record<string, any>) => tools.push(tool), on });
    expect(tools).toEqual([]);
    expect(on).toHaveBeenCalledWith("tool_call", expect.any(Function));
  });

  it("拒绝把 SubAgent 工作目录切到项目之外", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-cwd-root-"));
    const outside = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-cwd-outside-"));
    try {
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir: join(root, "agent") });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
      const result = await tools[0].execute(
        "call-cwd-escape",
        { agent: "scout", task: "不要执行", cwd: outside },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(result).toMatchObject({ isError: true, details: { results: [expect.objectContaining({ stopReason: "error" })] } });
      expect(String(result.content[0].text)).toContain("工作目录必须位于当前项目目录内");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("无 UI 时拒绝运行项目级 Agent，且不信任 confirmProjectAgents 参数", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-project-agent-"));
    try {
      const agentsDir = join(root, ".pi", "agents");
      await mkdir(agentsDir, { recursive: true });
      await writeFile(join(agentsDir, "repo.md"), "---\nname: repo\ndescription: repo agent\n---\n不要执行宿主规则\n", "utf8");
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir: join(root, "agent") });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
      const result = await tools[0].execute(
        "call-project-agent",
        { agent: "repo", task: "执行", agentScope: "both", confirmProjectAgents: false },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(result).toMatchObject({ isError: true });
      expect(String(result.content[0].text)).toContain("无 UI");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("在 auto 模式下拦截高风险 bash 和未知扩展工具", async () => {
    const handlers: Array<(event: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>> = [];
    const tools: Array<Record<string, any>> = [];
    createHppSubagentBridgeExtension({
      registerTool: (tool: Record<string, any>) => tools.push(tool),
      on: (_event: string, handler: (event: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>) => handlers.push(handler),
    });
    const previous = process.env.HPP_PI_SUBAGENT_PERMISSION_MODE;
    process.env.HPP_PI_SUBAGENT_PERMISSION_MODE = "auto";
    try {
      const context = { hasUI: true, ui: { confirm: vi.fn().mockResolvedValue(false) } };
      await expect(handlers[0]({ toolName: "bash", input: { command: "git commit -am x" } }, context))
        .resolves.toMatchObject({ block: true });
      await expect(handlers[0]({ toolName: "custom_write_tool", input: {} }, context))
        .resolves.toMatchObject({ block: true });
    } finally {
      if (previous === undefined) delete process.env.HPP_PI_SUBAGENT_PERMISSION_MODE;
      else process.env.HPP_PI_SUBAGENT_PERMISSION_MODE = previous;
    }
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

    expect(registered.map((tool) => tool.label)).toEqual([
      "External Subagent",
      "Subagent",
      "Apply Subagent Worktree",
      "Wait Subagents",
      "Stop Subagent",
      "Send to Subagent",
    ]);
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

  it("工具说明里写清可用 agent 与什么时候该并行", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-policy-test-"));
    try {
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir: join(root, "agent") });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
      const description = String(tools[0].description);
      // 只说「支持并行」不够：不给拆分的判据，模型会一路单任务。
      expect(description).toContain("tasks 并行");
      expect(description).toContain("chain：");
      expect(description).toContain("scout（只读检索）");
      expect(description).toContain("worker（改代码）");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scout 和 planner 的提示词要求列出搜过的位置和关键词", async () => {
    // 弱模型报「没找到」时，主 Agent 无法判断是真的不存在还是没搜全；
    // 让子 Agent 交代搜索范围，主 Agent 才能识别假阴性。
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-agent-prompt-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:process.argv.join('|')}], stopReason:'stop', model:'test/child'}})+'\\n');",
      ].join("\\n"), "utf8");
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir: join(root, "agent") });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
      for (const agent of ["scout", "planner"]) {
        const result = await tools[0].execute(
          `call-prompt-${agent}`,
          { agent, task: "检查项目" },
          new AbortController().signal,
          undefined,
          { cwd: root, hasUI: false },
        );
        expect(String(result.content[0].text)).toContain("列出搜过的位置和关键词");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("落盘超长输出，并在内联截断之外给出完整结果的路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-result-file-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      // 40KB 超过 single 路径的 32KB 内联预算，必须落盘。
      const longText = "B".repeat(40_000);
      await writeFile(join(cliDir, "cli.js"), [
        `process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:${JSON.stringify(longText)}}], stopReason:'stop', model:'test/child'}})+'\\n');`,
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const factory = createHppSubagentExtension({
        packageRoot: root,
        agentDir,
        subagentDataDir: join(root, "subs"),
      });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const result = await tools[0].execute(
        "call-long-output",
        { agent: "reviewer", task: "写一份长报告" },
        new AbortController().signal,
        () => undefined,
        { cwd: root, hasUI: false },
      );

      const text = String(result.content[0].text);
      // 内联仍然按预算截断，并把省略量说清楚。
      expect(text).toContain("[输出已截断");
      // 路径必须拼在截断之外，模型才拿得到全文。
      expect(text).toContain("[完整输出]");
      const pathLine = text.split("\n").find((line) => line.includes(".result.md")) || "";
      const filePath = (pathLine.match(/([A-Za-z]:.*\.result\.md)/) || [])[1] || "";
      expect(filePath).not.toBe("");
      const body = await readFile(filePath, "utf8");
      expect(body).toContain(longText);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("短输出不落盘，也不给模型多一行路径噪音", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-short-output-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'ok'}], stopReason:'stop', model:'test/child'}})+'\\n');",
      ].join("\n"), "utf8");
      const factory = createHppSubagentExtension({
        packageRoot: root,
        agentDir: join(root, "agent"),
        subagentDataDir: join(root, "subs"),
      });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const result = await tools[0].execute(
        "call-short-output",
        { agent: "scout", task: "看看入口" },
        new AbortController().signal,
        () => undefined,
        { cwd: root, hasUI: false },
      );

      const text = String(result.content[0].text);
      expect(text).toContain("ok");
      expect(text).not.toContain("[完整输出]");
      expect(text).not.toContain("[输出已截断");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("关闭模型池后跟随主 Agent 当前模型", async () => {
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
          poolEnabled: false,
          pool: [{ model: "pool/first" }],
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
      expect(String(result.content[0].text)).toContain("--model|parent/model");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-reads the subagent config on every call so host hot updates apply immediately", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-hot-config-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:process.argv.join('|')}], stopReason:'stop', model:'test/child'}})+'\\n');",
      ].join("\\n"), "utf8");
      let current: Record<string, unknown> = {
        enabled: true,
        pool: [{ model: "provider/first" }],
      };
      const factory = createHppSubagentExtension({
        packageRoot: root,
        agentDir: join(root, "agent"),
        getSubagentConfig: () => current,
      });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
      const first = await tools[0].execute(
        "call-hot-1",
        { agent: "scout", task: "第一次检查" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(first.content[0].text).toContain("--model|provider/first");

      current = { ...current, pool: [{ model: "provider/second" }] };
      const second = await tools[0].execute(
        "call-hot-2",
        { agent: "scout", task: "第二次检查" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(second.content[0].text).toContain("--model|provider/second");

      current = { ...current, enabled: false };
      const disabled = await tools[0].execute(
        "call-hot-3",
        { agent: "scout", task: "第三次检查" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(disabled.isError).toBe(true);
      expect(disabled.content[0].text).toContain("已在设置中禁用");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("模型池", () => {
    const CLI_ECHO_ARGS = [
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:process.argv.join('|')}], stopReason:'stop', model:'test/child'}})+'\\n');",
    ].join("\\n");

    const createHarness = async (
      subagentConfig: Record<string, unknown>,
      options: Record<string, unknown> = {},
    ) => {
      const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-pool-test-"));
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), CLI_ECHO_ARGS, "utf8");
      const factory = createHppSubagentExtension({
        packageRoot: root,
        agentDir: join(root, "agent"),
        subagentConfig,
        ...options,
      });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
      return { root, tools };
    };

    it("去重、丢弃空值，并把池限制在 8 条以内", () => {
      const normalized = normalizeHppSubagentConfig({
        pool: [
          { model: "p/a" },
          { model: "p/a" },
          { model: "  " },
          { model: 42 },
          ...Array.from({ length: 10 }, (_, index) => ({ model: `p/x${index}` })),
        ],
      });
      expect(normalized.pool).toHaveLength(8);
      expect(normalized.pool[0]).toMatchObject({ model: "p/a" });
      expect(normalized.pool.filter((entry) => entry.model === "p/a")).toHaveLength(1);
    });

    it("未单独配置时从池首项起步", async () => {
      const { root, tools } = await createHarness({
        enabled: true,
        pool: [{ model: "pool/fast" }, { model: "pool/deep" }],
      });
      try {
        const result = await tools[0].execute(
          "call-pool-start",
          { agent: "scout", task: "看下项目结构" },
          new AbortController().signal,
          undefined,
          { cwd: root, model: { provider: "parent", id: "current" }, hasUI: false },
        );
        expect(String(result.content[0].text)).toContain("--model|pool/fast");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("工具说明里带模型目录的能力摘要", async () => {
      const { root, tools } = await createHarness({
        enabled: true,
        pool: [{ model: "pool/fast" }, { model: "pool/deep" }],
      }, {
        // 模型 id 本身说明不了强弱，能力摘要必须来自目录里的真值。
        getModelMeta: (provider: string, id: string) => (id === "fast"
          ? { contextWindow: 128000, reasoning: false, images: false, cost: { input: 0.1, output: 0.4 } }
          : { contextWindow: 1_000_000, reasoning: true, thinkingLevels: ["high", "max"], images: true, cost: { input: 3, output: 15 } }),
      });
      try {
        const description = String(tools[0].description);
        expect(description).toContain("- pool/fast｜ctx 128k｜$0.10/$0.40 每 M");
        expect(description).toContain("- pool/deep｜ctx 1M｜思考 high/max｜视觉｜$3/$15 每 M");
        expect(description).toContain("默认不填 model");
        expect(description).toContain("不同厂商");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("查不到模型目录时只列 id，不编造能力", async () => {
      const { root, tools } = await createHarness({
        enabled: true,
        pool: [{ model: "pool/fast" }],
      });
      try {
        expect(String(tools[0].description)).toContain("- pool/fast");
        expect(String(tools[0].description)).not.toContain("ctx ");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("委派时指定的池内模型优先于池首项", async () => {
      const { root, tools } = await createHarness({
        enabled: true,
        pool: [{ model: "pool/fast" }, { model: "pool/deep" }],
      });
      try {
        const result = await tools[0].execute(
          "call-pool-pick",
          { agent: "scout", task: "设计一下改法", model: "pool/deep" },
          new AbortController().signal,
          undefined,
          { cwd: root, hasUI: false },
        );
        expect(String(result.content[0].text)).toContain("--model|pool/deep");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("并行任务可以各用不同模型", async () => {
      const { root, tools } = await createHarness({
        enabled: true,
        pool: [{ model: "pool/fast" }, { model: "pool/deep" }],
      });
      try {
        const result = await tools[0].execute(
          "call-pool-parallel",
          {
            tasks: [
              { agent: "scout", task: "找一下路由入口", model: "pool/fast" },
              { agent: "planner", task: "设计分层改法", model: "pool/deep" },
            ],
          },
          new AbortController().signal,
          undefined,
          { cwd: root, hasUI: false },
        );
        const text = String(result.content[0].text);
        expect(text).toContain("--model|pool/fast");
        expect(text).toContain("--model|pool/deep");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("池外模型直接拒绝，并列出当前可用的池", async () => {
      const { root, tools } = await createHarness({
        enabled: true,
        pool: [{ model: "pool/fast" }],
      });
      try {
        const result = await tools[0].execute(
          "call-pool-outside",
          { agent: "scout", task: "用个不存在的模型", model: "other/model" },
          new AbortController().signal,
          undefined,
          { cwd: root, hasUI: false },
        );
        expect(result.isError).toBe(true);
        expect(String(result.content[0].text)).toContain("不在模型池内");
        expect(result.details.results[0]).toMatchObject({ stopReason: "error" });
        expect(String(result.details.results[0].errorMessage)).toContain("pool/fast");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("关闭模型池后不列候选、也拒绝按任务指定模型", async () => {
      const { root, tools } = await createHarness({
        enabled: true,
        poolEnabled: false,
        pool: [{ model: "pool/fast" }],
      });
      try {
        // 说明里挂着候选、实际却被拒绝，比干脆不写更糟。
        expect(String(tools[0].description)).not.toContain("模型池（默认用第一项");
        const result = await tools[0].execute(
          "call-pool-off",
          { agent: "scout", task: "指定模型", model: "pool/fast" },
          new AbortController().signal,
          undefined,
          { cwd: root, hasUI: false },
        );
        expect(result.isError).toBe(true);
        expect(String(result.content[0].text)).toContain("模型池已在设置中关闭");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("markdown 里钉死 model 的 Agent 沿用钉死的模型", async () => {
      const { root, tools } = await createHarness({
        enabled: true,
        pool: [{ model: "pool/fast" }, { model: "pool/deep" }],
      });
      try {
        const agentsDir = join(root, "agent", "agents");
        await mkdir(agentsDir, { recursive: true });
        await writeFile(
          join(agentsDir, "pinned.md"),
          "---\nname: pinned\ndescription: 钉死模型的 agent\nmodel: pinned/model\n---\n只做一件事\n",
          "utf8",
        );
        const noParam = await tools[0].execute(
          "call-pool-pinned",
          { agent: "pinned", task: "干活" },
          new AbortController().signal,
          undefined,
          { cwd: root, hasUI: false },
        );
        expect(String(noParam.content[0].text)).toContain("--model|pinned/model");

        // 钉死就是钉死：按任务另指一个模型要明确报错，不能悄悄忽略。
        const override = await tools[0].execute(
          "call-pool-pinned-override",
          { agent: "pinned", task: "干活", model: "pool/deep" },
          new AbortController().signal,
          undefined,
          { cwd: root, hasUI: false },
        );
        expect(override.isError).toBe(true);
        expect(String(override.content[0].text)).toContain("不接受按任务指定");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
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

  it("reports live child activity before the final subagent result", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-progress-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "process.stdout.write(JSON.stringify({type:'tool_execution_start', toolName:'grep', args:{pattern:'认证'}})+'\\n');",
        "process.stdout.write(JSON.stringify({type:'message_update', assistantMessageEvent:{type:'thinking_delta', delta:'分析结果'}})+'\\n');",
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'child summary'}], stopReason:'stop', model:'test/child'}})+'\\n');",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const updates: Array<Record<string, any>> = [];
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      await tools[0].execute(
        "call-progress",
        { agent: "scout", task: "检查认证逻辑" },
        new AbortController().signal,
        (update: Record<string, any>) => updates.push(update),
        { cwd: root, hasUI: false },
      );

      expect(updates.some((update) => (
        update.details?.results?.[0]?.message === "正在搜索内容：认证"
      ))).toBe(true);
      expect(updates.at(-1)).toMatchObject({
        details: { results: [expect.objectContaining({ output: "child summary", exitCode: 0 })] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps parallel completion counts at zero until a child process exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-parallel-progress-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'child summary'}], stopReason:'stop', model:'test/child'}})+'\\n');",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const updates: Array<{ text: string; update: Record<string, any> }> = [];
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      await tools[0].execute(
        "call-parallel-progress",
        {
          tasks: [
            { agent: "scout", task: "检查认证逻辑" },
            { agent: "reviewer", task: "检查测试" },
          ],
        },
        new AbortController().signal,
        (update: Record<string, any>) => updates.push({
          text: update.content?.[0]?.text || "",
          update,
        }),
        { cwd: root, hasUI: false },
      );

      expect(updates.slice(0, 3).map((item) => item.text)).toEqual([
        "并行任务：0/2 已完成",
        "并行任务：0/2 已完成",
        "并行任务：0/2 已完成",
      ]);
      expect(updates[1].update.details.results[0].message).toBe("正在启动 scout…");
      expect(updates.at(-1)?.text).toBe("并行任务：2/2 已完成");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * 回归（用户实测「pi subagent 经常工作失败」）：pi 的 print 模式只在 `mode === "text"` 时
   * 把「最后一轮是 error」映射成 exit 1（`dist/modes/print-mode.js`，全文件唯一一处
   * `exitCode = 1`），而 Hpp 的子进程跑的是 `--mode json` / `--mode rpc` —— 上游 503/overloaded
   * 时子进程**退 0**，原因只留在 message 的 errorMessage 里。
   * 只看 exitCode 就会把它显示成「子 Agent 未返回输出」，用户完全看不出是限流。
   */
  it("surfaces the provider error when the child reports stopReason=error but exits 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-provider-error-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[], stopReason:'error', errorMessage:'Our servers are currently overloaded. Please try again later.', model:'test/child'}})+'\\n');",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      // 这个错误是「可重试」的，不调小间隔就会等真实的 15s。
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir, retryDelaysMs: [20] });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const result = await tools[0].execute(
        "call-provider-error",
        { agent: "reviewer", task: "审查" },
        new AbortController().signal,
        () => undefined,
        { cwd: root, hasUI: false },
      );

      const text = String(result.content[0].text);
      expect(text).toContain("overloaded");
      expect(text).not.toContain("未返回输出");
      // 子进程确实退 0（就是这条路径最容易骗人），真实原因在 errorMessage 里。
      expect(result).toMatchObject({
        isError: true,
        details: { results: [expect.objectContaining({ exitCode: 0, stopReason: "error" })] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * 回归：并行汇总原先「每个任务按 MAX_TASK_OUTPUT_BYTES(8KB) 截断、拼完再按
   * MAX_TOOL_OUTPUT_BYTES(32KB) 整体截一次」—— 任务一多，前面的就把 32KB 吃光，
   * 后面的整段消失（5 个任务 × 8KB = 40KB > 32KB）。并行审查时表现为「只看到前几个
   * reviewer 的结论」，而且没有任何提示。
   */
  it("gives every parallel task a share of the output budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-budget-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "const task = String(process.argv[process.argv.length - 1] || '').replace(/^Task: /, '');",
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:`TASK=${task}|` + 'x'.repeat(12000)}], stopReason:'stop', model:'test/child'}})+'\\n');",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const tasks = ["AAA", "BBB", "CCC", "DDD", "EEE"].map((task) => ({ agent: "reviewer", task }));
      const result = await tools[0].execute(
        "call-budget",
        { tasks },
        new AbortController().signal,
        () => undefined,
        { cwd: root, hasUI: false },
      );

      const text = String(result.content[0].text);
      // 5 × 8KB 的旧截断会让后面几个任务整段消失。
      for (const task of tasks) expect(text).toContain(`TASK=${task.task}`);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * 上游 overloaded / 限流是**可恢复**的：pi 自己在子进程内只重试 3 次、固定 2s 起，
   * 且并行的几个子进程会同步重试、继续捶上游。所以 Hpp 这层要退到外层重跑并加抖动。
   */
  describe("retry on retryable upstream failures", () => {
    const writeCountingCli = async (cliDir: string, firstMessage: string, secondMessage: string) => {
      await writeFile(join(cliDir, "cli.js"), [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const counter = path.join(__dirname, 'attempts.txt');",
        "const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;",
        "fs.writeFileSync(counter, String(attempt));",
        `const message = attempt === 1 ? ${firstMessage} : ${secondMessage};`,
        "process.stdout.write(JSON.stringify({type:'message_end', message})+'\\n');",
      ].join("\n"), "utf8");
    };
    const overloadedMessage = "{role:'assistant', content:[], stopReason:'error', errorMessage:'Our servers are currently overloaded. Please try again later.'}";
    const attemptsPath = (cliDir: string) => join(cliDir, "attempts.txt");

    it("reruns the child and reports how many retries it took", async () => {
      const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-retry-test-"));
      try {
        const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
        await mkdir(cliDir, { recursive: true });
        await writeCountingCli(
          cliDir,
          overloadedMessage,
          "{role:'assistant', content:[{type:'text', text:'recovered on attempt ' + attempt}], stopReason:'stop'}",
        );
        const agentDir = join(root, "agent");
        await mkdir(agentDir, { recursive: true });
        // 真实间隔是 15s / 45s，测试里调小。
        const factory = createHppSubagentExtension({ packageRoot: root, agentDir, retryDelaysMs: [20, 30] });
        const tools: Array<Record<string, any>> = [];
        factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

        const result = await tools[0].execute(
          "call-retry",
          { agent: "reviewer", task: "审查" },
          new AbortController().signal,
          () => undefined,
          { cwd: root, hasUI: false },
        );

        expect(result.content[0].text).toBe("recovered on attempt 2");
        expect(result.isError).toBeUndefined();
        expect(result.details.results[0]).toMatchObject({ retries: 1, exitCode: 0, stopReason: "stop" });
        expect(await readFile(attemptsPath(cliDir), "utf8")).toBe("2");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("keeps the failure when retries are exhausted, and says how many were made", async () => {
      const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-retry-exhausted-test-"));
      try {
        const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
        await mkdir(cliDir, { recursive: true });
        await writeCountingCli(cliDir, overloadedMessage, overloadedMessage);
        const agentDir = join(root, "agent");
        await mkdir(agentDir, { recursive: true });
        const factory = createHppSubagentExtension({ packageRoot: root, agentDir, retryDelaysMs: [20, 30] });
        const tools: Array<Record<string, any>> = [];
        factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

        const result = await tools[0].execute(
          "call-retry-exhausted",
          { agent: "reviewer", task: "审查" },
          new AbortController().signal,
          () => undefined,
          { cwd: root, hasUI: false },
        );

        // 首次 + 2 次重试 = 3 次子进程。
        expect(await readFile(attemptsPath(cliDir), "utf8")).toBe("3");
        expect(result.isError).toBe(true);
        expect(String(result.content[0].text)).toContain("overloaded");
        expect(String(result.content[0].text)).toContain("已自动重试 2 次");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    /** 鉴权/配额类错误重试只是白烧 token，必须原样失败。 */
    it("does not retry a failure that is not an upstream problem", async () => {
      const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-no-retry-test-"));
      try {
        const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
        await mkdir(cliDir, { recursive: true });
        await writeCountingCli(
          cliDir,
          "{role:'assistant', content:[], stopReason:'error', errorMessage:'Invalid API key provided'}",
          overloadedMessage,
        );
        const agentDir = join(root, "agent");
        await mkdir(agentDir, { recursive: true });
        const factory = createHppSubagentExtension({ packageRoot: root, agentDir, retryDelaysMs: [20, 30] });
        const tools: Array<Record<string, any>> = [];
        factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

        const result = await tools[0].execute(
          "call-no-retry",
          { agent: "reviewer", task: "审查" },
          new AbortController().signal,
          () => undefined,
          { cwd: root, hasUI: false },
        );

        expect(await readFile(attemptsPath(cliDir), "utf8")).toBe("1");
        expect(result.isError).toBe(true);
        expect(String(result.content[0].text)).toContain("Invalid API key");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    /** 超时是「跑太久」，重试等于再等一遍，绝对不能重试。 */
    it("does not retry a child that timed out", async () => {
      const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-no-retry-timeout-test-"));
      try {
        const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
        await mkdir(cliDir, { recursive: true });
        await writeFile(join(cliDir, "cli.js"), [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "fs.writeFileSync(path.join(__dirname, 'attempts.txt'), '1');",
          "setInterval(() => {}, 1000);",
        ].join("\n"), "utf8");
        const agentDir = join(root, "agent");
        await mkdir(agentDir, { recursive: true });
        const factory = createHppSubagentExtension({ packageRoot: root, agentDir, retryDelaysMs: [20, 30] });
        const tools: Array<Record<string, any>> = [];
        factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

        const result = await tools[0].execute(
          "call-no-retry-timeout",
          { agent: "scout", task: "等待超时", timeoutMs: 800 },
          new AbortController().signal,
          () => undefined,
          { cwd: root, hasUI: false },
        );

        expect(await readFile(attemptsPath(cliDir), "utf8")).toBe("1");
        expect(result).toMatchObject({
          isError: true,
          details: { results: [expect.objectContaining({ stopReason: "timeout", retries: 0 })] },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
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
        "if (command.type === 'extension_ui_response') { const text = command.confirmed ? 'child approved' : 'child denied'; process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text}], stopReason:'stop', model:'test/rpc-child'}})+'\\n'); process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n'); process.stdout.write(JSON.stringify({type:'agent_settled', aborted:false})+'\\n'); } });",
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

  it("ignores RPC child UI commands that do not need an answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-rpc-commands-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      // 子进程在 rpc 模式下会把 setStatus / setWidget / setTitle / notify 这类单向 UI
      // 指令也写成 extension_ui_request。Hpp 若把它们当成「询问用户」，就会弹出一个
      // 没有题目、也没有选项的空问卷，用户既看不到问题也回答不了。
      await writeFile(join(cliDir, "cli.js"), [
        "import { createInterface } from 'node:readline';",
        "const rl = createInterface({input: process.stdin});",
        "rl.on('line', (line) => { const command = JSON.parse(line);",
        "if (command.type === 'prompt') {",
        "  process.stdout.write(JSON.stringify({type:'extension_ui_request', id:'status-1', method:'setStatus', statusKey:'phase', statusText:'reading'})+'\\n');",
        "  process.stdout.write(JSON.stringify({type:'extension_ui_request', id:'widget-1', method:'setWidget', widgetKey:'progress', widgetLines:['1/2']})+'\\n');",
        "  process.stdout.write(JSON.stringify({type:'extension_ui_request', id:'title-1', method:'setTitle', title:'reviewer'})+'\\n');",
        "  process.stdout.write(JSON.stringify({type:'extension_ui_request', id:'notify-1', method:'notify', message:'running'})+'\\n');",
        "  process.stdout.write(JSON.stringify({type:'extension_ui_request', id:'child-confirm-1', method:'confirm', title:'Child permission', message:'Allow edit?'})+'\\n');",
        "}",
        "if (command.type === 'extension_ui_response') { const text = command.confirmed ? 'child approved' : 'child denied'; process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text}], stopReason:'stop', model:'test/rpc-child'}})+'\\n'); process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n'); process.stdout.write(JSON.stringify({type:'agent_settled', aborted:false})+'\\n'); } });",
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
        "call-rpc-commands",
        { agent: "worker", task: "检查认证逻辑" },
        new AbortController().signal,
        () => undefined,
        {
          cwd: root,
          model: { provider: "test", id: "parent" },
          thinkingLevel: "low",
          hasUI: true,
        },
      );

      expect(requests.map((request) => request.method)).toEqual(["confirm"]);
      expect(result).toMatchObject({
        content: [{ type: "text", text: "child approved" }],
        details: { results: [expect.objectContaining({ exitCode: 0 })] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("auto-cancels child select dialogs so subagents never prompt the user", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-rpc-select-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "import { createInterface } from 'node:readline';",
        "const rl = createInterface({input: process.stdin});",
        "rl.on('line', (line) => { const command = JSON.parse(line);",
        "if (command.type === 'prompt') { process.stdout.write(JSON.stringify({type:'extension_ui_request', id:'child-select-1', method:'select', title:'Child question', options:['Yes','No']})+'\\n'); }",
        "if (command.type === 'extension_ui_response') { const text = command.cancelled ? 'cancelled' : 'selected:' + command.value; process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text}], stopReason:'stop', model:'test/rpc-child'}})+'\\n'); process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n'); process.stdout.write(JSON.stringify({type:'agent_settled', aborted:false})+'\\n'); } });",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const requests: Array<Record<string, unknown>> = [];
      const factory = createHppSubagentExtension({
        packageRoot: root,
        agentDir,
        requestUI: async (request: Record<string, unknown>) => {
          requests.push(request);
          return { value: "Yes" };
        },
      });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const result = await tools[0].execute(
        "call-rpc-select",
        { agent: "worker", task: "检查认证逻辑" },
        new AbortController().signal,
        () => undefined,
        { cwd: root, hasUI: true },
      );

      // select 不能冒泡成问卷：宿主直接回 cancelled，子 Agent 把结果写进输出。
      expect(requests).toEqual([]);
      expect(result).toMatchObject({
        content: [{ type: "text", text: "cancelled" }],
        details: { results: [expect.objectContaining({ exitCode: 0 })] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("denylists question tools for child sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-rpc-tools-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      const argvPath = join(root, "argv.json");
      await writeFile(join(cliDir, "cli.js"), [
        "import { writeFileSync } from 'node:fs';",
        "import { createInterface } from 'node:readline';",
        `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv));`,
        "const rl = createInterface({input: process.stdin});",
        "rl.on('line', (line) => { const command = JSON.parse(line);",
        "if (command.type === 'prompt') { process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n'); process.stdout.write(JSON.stringify({type:'agent_settled', aborted:false})+'\\n'); } });",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const factory = createHppSubagentExtension({
        packageRoot: root,
        agentDir,
        requestUI: async () => ({}),
      });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      await tools[0].execute(
        "call-rpc-tools",
        { agent: "worker", task: "检查认证逻辑" },
        new AbortController().signal,
        () => undefined,
        { cwd: root, hasUI: true },
      );

      const argv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
      const excludeIndex = argv.indexOf("--exclude-tools");
      expect(excludeIndex).toBeGreaterThan(-1);
      const denylist = String(argv[excludeIndex + 1] || "");
      expect(denylist).toContain("subagent");
      expect(denylist).toContain("ask_user_question");
      expect(denylist).toContain("questionnaire");
      expect(denylist).toContain("question");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("结束被 Pi 命令 handled 的 RPC prompt，不等待不存在的 agent_settled", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-handled-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "import { createInterface } from 'node:readline';",
        "const rl = createInterface({input: process.stdin});",
        "rl.on('line', (line) => { const command = JSON.parse(line); if (command.type === 'prompt') process.stdout.write(JSON.stringify({type:'response', command:'prompt', success:true, data:{disposition:'handled'}})+'\\n'); });",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const factory = createHppSubagentExtension({
        packageRoot: root,
        agentDir,
        requestUI: async () => ({ cancelled: true }),
      });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const result = await tools[0].execute(
        "call-handled",
        { agent: "scout", task: "/handled-command" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: true },
      );
      expect(result).toMatchObject({ details: { results: [expect.objectContaining({ stopReason: "completed", exitCode: 0 })] } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

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

    expect(tools.map((tool) => tool.name)).toEqual([
      "subagent",
      "subagent_apply",
      "subagent_wait",
      "subagent_stop",
      "subagent_send",
    ]);
    expect(tools[0]).toMatchObject({ name: "subagent", label: "Subagent" });
    expect(tools[0].parameters).toMatchObject({ type: "object" });
    // schema 里不能留 default，否则模型会照着填一个并不存在的「默认时限」。
    expect(tools[0].parameters.properties.timeoutMs.default).toBeUndefined();
  });
});

describe("Pi 后台子 Agent", () => {
  const createHarness = async (source: string, options: Record<string, unknown> = {}) => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-bg-"));
    const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, "cli.js"), source, "utf8");
    const events: Array<Record<string, any>> = [];
    const sendMessage = vi.fn();
    const factory = createHppSubagentExtension({
      packageRoot: root,
      agentDir: join(root, "agent"),
      subagentDataDir: join(root, "subs"),
      sessionKey: "parent-1",
      emitBackgroundEvent: (payload: Record<string, any>) => events.push(payload),
      ...options,
    });
    const tools: Array<Record<string, any>> = [];
    factory({
      registerTool: (tool: Record<string, any>) => tools.push(tool),
      sendMessage,
    });
    return { root, tools, events, factory, sendMessage };
  };

  const toolByName = (tools: Array<Record<string, any>>, name: string) =>
    tools.find((tool) => tool.name === name);

  it("background:true 立即返回任务 id，结果落盘并通过独立通道上报", async () => {
    const { root, tools, events } = await createHarness([
      "import { writeFileSync } from 'node:fs';",
      "const sessionIndex = process.argv.indexOf('--session');",
      "if (sessionIndex >= 0) { try { writeFileSync(process.argv[sessionIndex + 1], ''); } catch {} }",
      "setTimeout(() => process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'bg done'}], stopReason:'stop', model:'test/child'}})+'\\n'), 80);",
    ].join("\n"));
    try {
      const started = await toolByName(tools, "subagent").execute(
        "call-bg",
        { agent: "scout", task: "后台检查", title: "后台检查", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, model: { provider: "test", id: "parent" }, hasUI: false },
      );
      expect(started.details.background).toBe(true);
      const taskId = started.details.results[0].id as string;
      expect(taskId).toMatch(/^sa_/);

      const waited = await toolByName(tools, "subagent_wait").execute(
        "call-wait",
        { ids: [taskId], timeoutMs: 5000 },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(waited.details.results[0]).toMatchObject({
        id: taskId,
        status: "completed",
        output: "bg done",
        background: true,
      });
      // 完整结果写入文件，工具返回只带摘要。
      const resultFile = waited.details.results[0].resultFile as string;
      expect(await readFile(resultFile, "utf8")).toContain("bg done");
      // 独立事件通道不受主回合 activePromptId 约束。
      expect(events.some((event) => (
        event.type === "subagent_background"
        && event.background === true
        && event.result?.details?.results?.[0]?.id === taskId
      ))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("subagent_send 用同一个会话文件续聊，并沿用上一轮模型", async () => {
    const cliSource = [
      "import { writeFileSync } from 'node:fs';",
      "const sessionIndex = process.argv.indexOf('--session');",
      "if (sessionIndex >= 0) { try { writeFileSync(process.argv[sessionIndex + 1], ''); } catch {} }",
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:process.argv.join('|')}], stopReason:'stop', model:'pool/a'}})+'\\n');",
    ].join("\n");
    const { root, tools } = await createHarness(cliSource, {
      subagentConfig: { enabled: true, pool: [{ model: "pool/a" }, { model: "pool/b" }] },
    });
    try {
      const started = await toolByName(tools, "subagent").execute(
        "call-bg-send",
        { agent: "scout", task: "第一轮", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, model: { provider: "test", id: "parent" }, hasUI: false },
      );
      const taskId = started.details.results[0].id as string;
      const waited = await toolByName(tools, "subagent_wait").execute(
        "call-wait-send", { ids: [taskId], timeoutMs: 5000 }, new AbortController().signal, undefined, { cwd: root, hasUI: false },
      );
      const sessionFile = waited.details.results[0].sessionFile as string;
      expect(sessionFile).toContain(taskId);

      const sent = await toolByName(tools, "subagent_send").execute(
        "call-send",
        { id: taskId, message: "继续检查", background: false },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const argv = String(sent.content[0].text);
      expect(argv).toContain(`--session|${sessionFile}`);
      // 默认沿用上一轮实际使用的模型，而不是池首项或主 Agent 模型。
      expect(argv).toContain("--model|pool/a");
      expect(argv).toContain("继续检查");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("后台任务支持停止，停止后状态为 interrupted", async () => {
    const { root, tools } = await createHarness("setInterval(() => {}, 1000);\n");
    try {
      const started = await toolByName(tools, "subagent").execute(
        "call-bg-stop",
        { agent: "scout", task: "一直跑", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const taskId = started.details.results[0].id as string;
      // 等子进程真正启动（控制器 aborted 后再启动也会被 run 拦下）。
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stopped = await toolByName(tools, "subagent_stop").execute(
        "call-stop", { id: taskId }, new AbortController().signal, undefined, { cwd: root, hasUI: false },
      );
      expect(String(stopped.content[0].text)).toContain("已请求停止");

      const waited = await toolByName(tools, "subagent_wait").execute(
        "call-wait-stop", { ids: [taskId], timeoutMs: 8000 }, new AbortController().signal, undefined, { cwd: root, hasUI: false },
      );
      expect(waited.details.results[0].status).toBe("interrupted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("空闲时把窗口内完成的后台结果合并成一次宿主回合", async () => {
    const prepareHostTurn = vi.fn();
    const { root, tools, sendMessage } = await createHarness(
      ["process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop', model:'test/child'}})+'\\n');"].join("\n"),
      {
        subagentConfig: { enabled: true, autoWakeOnResult: true, autoWakeDebounceMs: 2000 },
        isSessionIdle: () => true,
        canAutoWake: () => true,
        prepareHostTurn,
      },
    );
    try {
      const started = await toolByName(tools, "subagent").execute(
        "call-autowake",
        {
          tasks: [
            { agent: "scout", task: "后台 A", title: "A" },
            { agent: "scout", task: "后台 B", title: "B" },
          ],
          background: true,
        },
        new AbortController().signal,
        undefined,
        { cwd: root, model: { provider: "test", id: "parent" }, hasUI: false },
      );
      const taskIds = started.details.results.map((item: Record<string, any>) => item.id);
      await vi.waitFor(() => expect(prepareHostTurn).toHaveBeenCalledTimes(1), { timeout: 10_000 });

      // 合并窗口内完成的两个任务只触发一次宿主回合。
      expect(prepareHostTurn).toHaveBeenCalledTimes(1);
      expect(prepareHostTurn).toHaveBeenCalledWith({ taskIds });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "hpp-subagent-result",
          details: expect.objectContaining({ autoWake: true, taskIds }),
        }),
        { triggerTurn: true },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("护栏不允许自动唤醒时退回 nextTurn", async () => {
    const prepareHostTurn = vi.fn();
    const { root, tools, sendMessage } = await createHarness(
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n');",
      {
        subagentConfig: { enabled: true, autoWakeOnResult: true, autoWakeDebounceMs: 50 },
        isSessionIdle: () => true,
        canAutoWake: () => false,
        prepareHostTurn,
      },
    );
    try {
      await toolByName(tools, "subagent").execute(
        "call-autowake-blocked",
        { agent: "scout", task: "后台任务", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(prepareHostTurn).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "hpp-subagent-result" }),
        { deliverAs: "nextTurn" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("结果已被 subagent_wait 取走时不再触发唤醒", async () => {
    const prepareHostTurn = vi.fn();
    const { root, tools, sendMessage } = await createHarness(
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n');",
      {
        subagentConfig: { enabled: true, autoWakeOnResult: true, autoWakeDebounceMs: 500 },
        isSessionIdle: () => true,
        canAutoWake: () => true,
        prepareHostTurn,
      },
    );
    try {
      const started = await toolByName(tools, "subagent").execute(
        "call-autowake-wait",
        { agent: "scout", task: "后台任务", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const taskId = started.details.results[0].id as string;
      // 结果完成并进入防抖窗口后立刻被 wait 取走。
      await new Promise((resolve) => setTimeout(resolve, 200));
      await toolByName(tools, "subagent_wait").execute(
        "call-autowake-wait-tool",
        { ids: [taskId], timeoutMs: 3000 },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(prepareHostTurn).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("isolation:worktree 在独立分支运行，并用 subagent_apply 合并", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-worktree-"));
    const worktreeBase = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-wt-base-"));
    const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, "cli.js"), [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('isolation.txt', 'from subagent\\n');",
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n');",
    ].join("\n"), "utf8");
    await writeFile(join(root, "app.txt"), "base\n", "utf8");
    await writeFile(join(root, ".gitignore"), "node_modules/\nsubs/\n", "utf8");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "app.txt", ".gitignore"]);
    git(["commit", "-q", "-m", "base"]);

    const factory = createHppSubagentExtension({
      packageRoot: root,
      agentDir: join(root, "agent"),
      subagentDataDir: join(root, "subs"),
      worktreeBaseDir: worktreeBase,
      sessionKey: "parent-1",
    });
    const tools: Array<Record<string, any>> = [];
    factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
    try {
      const result = await toolByName(tools, "subagent").execute(
        "call-isolation",
        { agent: "worker", task: "写一个文件", isolation: "worktree" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const worktree = result.details.results[0].worktree;
      expect(worktree).toMatchObject({ changed: true });
      expect(worktree.branch).toMatch(/^hpp-sub\//);
      // 主工作区在 apply 之前看不到子 Agent 的文件。
      expect(existsSync(join(root, "isolation.txt"))).toBe(false);
      expect(String(result.content[0].text)).toContain("subagent_apply");

      const applied = await toolByName(tools, "subagent_apply").execute(
        "call-apply",
        { id: worktree.id },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(applied.isError).toBeUndefined();
      expect(await readFile(join(root, "isolation.txt"), "utf8")).toContain("from subagent");
      expect(existsSync(worktree.path)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreeBase, { recursive: true, force: true });
    }
  }, 30_000);

  it("reviewer（带 bash）请求 worktree 时不会被静默降级", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-readonly-wt-"));
    const worktreeBase = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-readonly-wt-base-"));
    const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, "cli.js"), [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('review-note.txt', 'written inside worktree\\n');",
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n');",
    ].join("\n"), "utf8");
    await writeFile(join(root, "app.txt"), "base\n", "utf8");
    await writeFile(join(root, ".gitignore"), "node_modules/\nsubs/\n", "utf8");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "app.txt", ".gitignore"]);
    git(["commit", "-q", "-m", "base"]);

    const factory = createHppSubagentExtension({
      packageRoot: root,
      agentDir: join(root, "agent"),
      subagentDataDir: join(root, "subs"),
      worktreeBaseDir: worktreeBase,
      sessionKey: "parent-1",
    });
    const tools: Array<Record<string, any>> = [];
    factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
    try {
      // reviewer 的工具是 read,grep,find,ls,bash：bash 也能重定向写文件，
      // 所以它请求 worktree 时必须真的隔离，而不是被当成只读 agent 静默忽略。
      const result = await toolByName(tools, "subagent").execute(
        "call-reviewer-isolation",
        { agent: "reviewer", task: "审查并写个笔记", isolation: "worktree" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const worktree = result.details.results[0].worktree;
      expect(worktree).toMatchObject({ changed: true });
      expect(String(result.content[0].text)).not.toContain("只读的，已忽略");
      expect(existsSync(join(root, "review-note.txt"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreeBase, { recursive: true, force: true });
    }
  }, 30_000);

  it("chain 的 cwd 指向项目外时拒绝创建隔离工作区", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-chain-cwd-"));
    const outside = await mkdtemp(join(tmpdir(), "hpp-pi-chain-cwd-outside-"));
    const worktreeBase = await mkdtemp(join(tmpdir(), "hpp-pi-chain-cwd-base-"));
    const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, "cli.js"), "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n');", "utf8");
    await writeFile(join(root, "app.txt"), "base\n", "utf8");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "app.txt"]);
    git(["commit", "-q", "-m", "base"]);

    const factory = createHppSubagentExtension({
      packageRoot: root,
      agentDir: join(root, "agent"),
      subagentDataDir: join(root, "subs"),
      worktreeBaseDir: worktreeBase,
      sessionKey: "parent-1",
    });
    const tools: Array<Record<string, any>> = [];
    factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
    try {
      // 后台 chain 才会用 params.cwd 建隔离工作区；同步 chain 固定用 ctx.cwd。
      const started = await toolByName(tools, "subagent").execute(
        "call-chain-cwd",
        { chain: [{ agent: "worker", task: "改文件", isolation: "worktree" }], cwd: outside, background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const taskId = started.details.results[0].id as string;
      const waited = await toolByName(tools, "subagent_wait").execute(
        "wait-chain-cwd",
        { ids: [taskId], timeoutMs: 5000 },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      // 自定义 cwd 不能把隔离工作区建到项目外。
      expect(waited.details.results[0]).toMatchObject({ status: "error" });
      expect(String(waited.details.results[0].errorMessage)).toMatch(/工作目录/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      await rm(worktreeBase, { recursive: true, force: true });
    }
  }, 30_000);

  it("todoId 绑定任务：派发置 in_progress，成功置 completed", async () => {
    const tasks = [
      { id: "1", title: "主任务", status: "pending", blockedBy: ["2"] },
      { id: "2", title: "依赖", status: "pending" },
    ];
    const calls: Array<{ id: string; patch: Record<string, any> }> = [];
    const store = {
      getTasks: () => tasks.map((task) => ({ ...task })),
      findTask: (id: string) => tasks.find((task) => task.id === id),
      updateTask: (id: string, patch: Record<string, any>) => {
        calls.push({ id, patch });
        const task = tasks.find((item) => item.id === id);
        if (!task) return null;
        Object.assign(task, patch);
        if (patch.owner === "") delete task.owner;
        return { ...task };
      },
    };
    const emitPlanUpdate = vi.fn();
    const { root, tools } = await createHarness(
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n');",
      { getTodoStore: () => store, emitPlanUpdate },
    );
    try {
      const result = await toolByName(tools, "subagent").execute(
        "call-todo-bind",
        { agent: "worker", task: "执行任务", todoId: "1" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(calls[0]).toMatchObject({ id: "1", patch: { status: "in_progress", owner: expect.stringMatching(/^sa_/) } });
      expect(calls.at(-1)?.patch).toMatchObject({ status: "completed" });
      expect(tasks[0].status).toBe("completed");
      // blockedBy 只提示，不阻止派发。
      expect(String(result.content[0].text)).toContain("依赖任务尚未完成：2");
      expect(emitPlanUpdate).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("todoId 绑定任务失败时回到 pending 并附上原因", async () => {
    const tasks = [{ id: "1", title: "主任务", status: "pending" }];
    const calls: Array<{ id: string; patch: Record<string, any> }> = [];
    const store = {
      getTasks: () => tasks.map((task) => ({ ...task })),
      findTask: (id: string) => tasks.find((task) => task.id === id),
      updateTask: (id: string, patch: Record<string, any>) => {
        calls.push({ id, patch });
        Object.assign(tasks[0], patch);
        if (patch.owner === "") delete tasks[0].owner;
        return { ...tasks[0] };
      },
    };
    const { root, tools } = await createHarness(
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[], stopReason:'error', errorMessage:'boom'}})+'\\n');",
      { getTodoStore: () => store, emitPlanUpdate: vi.fn() },
    );
    try {
      await toolByName(tools, "subagent").execute(
        "call-todo-fail",
        { agent: "worker", task: "执行任务", todoId: "1" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(calls.at(-1)?.patch).toMatchObject({ status: "pending", lastError: expect.stringContaining("boom") });
      expect(tasks[0].owner).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("inheritContext 用分叉会话文件启动子 Agent", async () => {
    const cliSource = [
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:process.argv.join('|')}], stopReason:'stop'}})+'\\n');",
    ].join("\n");
    const { root, tools } = await createHarness(cliSource, {
      createInheritedSession: () => join(root, "forked-session.jsonl"),
    });
    try {
      const result = await toolByName(tools, "subagent").execute(
        "call-inherit",
        { agent: "scout", task: "基于上下文继续", inheritContext: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(String(result.content[0].text)).toContain(`--session|${join(root, "forked-session.jsonl")}`);
      expect(String(result.content[0].text)).not.toContain("--no-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("inheritContext 的后台任务续聊仍用同一个分叉会话", async () => {
    const cliSource = "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:process.argv.join('|')}], stopReason:'stop'}})+'\\n');";
    const { root, tools } = await createHarness(cliSource, {
      createInheritedSession: () => join(root, "forked-session.jsonl"),
      subagentConfig: { enabled: true },
      isSessionIdle: () => false,
    });
    // 真实 worker 的 createBranchedSession 会落盘成文件；续聊前会检查它存在。
    await writeFile(join(root, "forked-session.jsonl"), "", "utf8");
    try {
      const started = await toolByName(tools, "subagent").execute(
        "call-inherit-bg",
        { agent: "scout", task: "后台继承", inheritContext: true, background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const taskId = started.details.results[0].id as string;
      await toolByName(tools, "subagent_wait").execute(
        "wait-inherit-bg",
        { ids: [taskId], timeoutMs: 5000 },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );

      // 续聊必须复用第一轮的分叉文件，不能退回 --no-session 否则上下文全丢。
      const sent = await toolByName(tools, "subagent_send").execute(
        "send-inherit-bg",
        { id: taskId, message: "继续", background: false },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(String(sent.content[0].text)).toContain(`--session|${join(root, "forked-session.jsonl")}`);
      expect(String(sent.content[0].text)).not.toContain("--no-session");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("chain 中间步骤的超长输出也会落盘，不只是失败那一步", async () => {
    const cliSource = [
      "const task = process.argv[process.argv.length - 1] || '';",
      "const fail = task.includes('失败');",
      "const text = task.includes('长输出') ? 'x'.repeat(10000) : 'done';",
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text}], stopReason: fail ? 'error' : 'stop'}})+'\\n');",
    ].join("\n");
    const { root, tools } = await createHarness(cliSource);
    try {
      const result = await toolByName(tools, "subagent").execute(
        "call-chain-long",
        { chain: [
          { agent: "scout", task: "长输出" },
          { agent: "scout", task: "失败" },
        ] },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(result.isError).toBe(true);
      const text = String(result.content[0].text);
      // 第一步 10KB 的输出超过 8KB 内联预算，必须能从结果里拿到落盘路径。
      expect(text).toContain("[完整输出]");
      expect(text).toMatch(/\.result\.md/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("无法分叉时明确拒绝 inheritContext", async () => {
    const { root, tools } = await createHarness(
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n');",
      { createInheritedSession: () => "" },
    );
    try {
      const result = await toolByName(tools, "subagent").execute(
        "call-inherit-missing",
        { agent: "scout", task: "基于上下文继续", inheritContext: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(result.isError).toBe(true);
      expect(String(result.content[0].text)).toContain("inheritContext 不可用");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("stopAll 在 worker dispose 时回收全部后台任务", async () => {
    const { root, tools, factory } = await createHarness("setInterval(() => {}, 1000);\n");
    try {
      const started = await toolByName(tools, "subagent").execute(
        "call-stop-all",
        { agent: "scout", task: "长任务", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const taskId = started.details.results[0].id as string;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(factory.stopAll()).resolves.toBeGreaterThan(0);
      const waited = await toolByName(tools, "subagent_wait").execute(
        "call-wait-stop-all",
        { ids: [taskId], timeoutMs: 1000 },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(waited.details.results[0].status).toBe("interrupted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("同步续聊也能被 subagent_stop 终止", async () => {
    const cliSource = [
      "import { writeFileSync } from 'node:fs';",
      "const sessionIndex = process.argv.indexOf('--session');",
      "if (sessionIndex >= 0) { try { writeFileSync(process.argv[sessionIndex + 1], ''); } catch {} }",
      "if (process.argv.join(' ').includes('继续')) { setInterval(() => {}, 1000); }",
      "else process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n');",
    ].join("\n");
    const { root, tools } = await createHarness(cliSource);
    try {
      const started = await toolByName(tools, "subagent").execute(
        "call-sync-stop-bg",
        { agent: "scout", task: "第一轮", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const taskId = started.details.results[0].id as string;
      await toolByName(tools, "subagent_wait").execute(
        "call-sync-stop-wait", { ids: [taskId], timeoutMs: 5000 }, new AbortController().signal, undefined, { cwd: root, hasUI: false },
      );

      const toolController = new AbortController();
      const sending = toolByName(tools, "subagent_send").execute(
        "call-sync-send",
        { id: taskId, message: "继续", background: false },
        toolController.signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      // 工具自身的 signal 没有 abort，只停子任务；同步路径必须同时响应 controller。
      await toolByName(tools, "subagent_stop").execute(
        "call-sync-stop", { id: taskId }, new AbortController().signal, undefined, { cwd: root, hasUI: false },
      );
      const sent = await sending;
      expect(sent.isError).toBe(true);
      expect(String(sent.content[0].text)).toMatch(/中断|aborted/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it("权限桥缺失时 fail closed，剔除写工具", async () => {
    const { root, tools } = await createHarness(
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:process.argv.join('|')}], stopReason:'stop'}})+'\\n');",
      { bridgeExtensionPath: join(tmpdir(), "hpp-definitely-missing-bridge.mjs") },
    );
    try {
      const result = await toolByName(tools, "subagent").execute(
        "call-no-bridge",
        { agent: "worker", task: "写文件" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: true },
      );
      expect(String(result.content[0].text)).toContain("--exclude-tools|subagent,todo_write,");
      // bash 也能重定向写文件，缺桥时必须一并剔除，不能只排 edit/write。
      expect(String(result.content[0].text)).toContain(",edit,write,bash");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("自动唤醒投递失败时降级为 nextTurn，不丢结果", async () => {
    const { root, tools, sendMessage } = await createHarness(
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n');",
      {
        subagentConfig: { enabled: true, autoWakeOnResult: true, autoWakeDebounceMs: 500 },
        isSessionIdle: () => true,
        canAutoWake: () => true,
        prepareHostTurn: vi.fn(),
      },
    );
    sendMessage.mockImplementation((_message: unknown, options?: Record<string, unknown>) => {
      if (options?.triggerTurn) throw new Error("triggerTurn unavailable");
    });
    try {
      await toolByName(tools, "subagent").execute(
        "call-autowake-fallback",
        { agent: "scout", task: "后台任务", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: true });
      expect(sendMessage.mock.calls[1][1]).toEqual({ deliverAs: "nextTurn" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("triggerTurn 没有宿主回执时降级为 nextTurn", async () => {
    const { root, tools, sendMessage } = await createHarness(
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n');",
      {
        subagentConfig: { enabled: true, autoWakeOnResult: true, autoWakeDebounceMs: 30 },
        isSessionIdle: () => true,
        canAutoWake: () => true,
        prepareHostTurn: vi.fn(),
        // pi.sendMessage 没有返回值，只能靠回执确认；这里把超时缩短到 150ms。
        hostWakeConfirmTimeoutMs: 50,
      },
    );
    try {
      await toolByName(tools, "subagent").execute(
        "call-host-wake-timeout",
        { agent: "scout", task: "后台任务", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: true });
      expect(sendMessage.mock.calls.at(-1)?.[1]).toEqual({ deliverAs: "nextTurn" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("收到宿主回执后不再补发 nextTurn", async () => {
    const { root, tools, sendMessage, factory } = await createHarness(
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n');",
      {
        subagentConfig: { enabled: true, autoWakeOnResult: true, autoWakeDebounceMs: 30 },
        isSessionIdle: () => true,
        canAutoWake: () => true,
        prepareHostTurn: vi.fn(),
        hostWakeConfirmTimeoutMs: 150,
      },
    );
    try {
      const started = await toolByName(tools, "subagent").execute(
        "call-host-wake-confirm",
        { agent: "scout", task: "后台任务", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const taskId = started.details.results[0].id as string;
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      expect(factory.confirmHostTurn([taskId])).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("reload 后旧后台任务仍在任务表里，可以被停止", async () => {
    const { root, tools, factory } = await createHarness(
      "setTimeout(() => process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'late'}], stopReason:'stop'}})+'\\n'), 5000);",
      { subagentConfig: { enabled: true }, isSessionIdle: () => false },
    );
    try {
      const started = await toolByName(tools, "subagent").execute(
        "call-reload-task",
        { agent: "scout", task: "长任务", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const taskId = started.details.results[0].id as string;
      await vi.waitFor(() => {
        expect(factory.listTasks().some((entry: { id: string }) => entry.id === taskId)).toBe(true);
      });

      // 模拟 resourceLoader.reload()：同一个扩展函数对象再执行一次。
      // 任务表挂在函数对象上，新实例（新工具闭包）仍能看到旧任务。
      factory({ registerTool: () => {}, sendMessage: vi.fn() });

      expect(factory.listTasks().map((entry: { id: string }) => entry.id)).toContain(taskId);
      expect(factory.stopTask(taskId)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("stopAll 后完成任务不再向主会话投递", async () => {
    const { root, tools, factory, sendMessage } = await createHarness(
      "setTimeout(() => process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'late'}], stopReason:'stop'}})+'\\n'), 5000);",
      { subagentConfig: { enabled: true }, isSessionIdle: () => true, canAutoWake: () => true },
    );
    try {
      await toolByName(tools, "subagent").execute(
        "call-stop-all",
        { agent: "scout", task: "长任务", background: true },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      await factory.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 800));
      // disposed 之后即使任务在等待窗口内 finalize，也不能再推结果/计划事件。
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("worktree 任务重试时换新 id，不会撞上上次留下的目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-worktree-retry-"));
    const worktreeBase = await mkdtemp(join(tmpdir(), "hpp-pi-worktree-retry-base-"));
    const attemptFile = join(root, "attempt.txt");
    const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, "cli.js"), [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "const file = process.env.HPP_TEST_ATTEMPT_FILE;",
      "const attempt = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;",
      "writeFileSync(file, String(attempt + 1));",
      "if (attempt === 0) { process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[], stopReason:'error', errorMessage:'overloaded'}})+'\\n'); }",
      "else { writeFileSync('retry.txt', 'ok\\n'); process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'done'}], stopReason:'stop'}})+'\\n'); }",
    ].join("\n"), "utf8");
    await writeFile(join(root, "app.txt"), "base\n", "utf8");
    await writeFile(join(root, ".gitignore"), "node_modules/\nsubs/\n", "utf8");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "app.txt", ".gitignore"]);
    git(["commit", "-q", "-m", "base"]);

    process.env.HPP_TEST_ATTEMPT_FILE = attemptFile;
    try {
      const factory = createHppSubagentExtension({
        packageRoot: root,
        agentDir: join(root, "agent"),
        subagentDataDir: join(root, "subs"),
        worktreeBaseDir: worktreeBase,
        retryDelaysMs: [1],
      });
      const realTools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => realTools.push(tool) });
      const result = await toolByName(realTools, "subagent").execute(
        "call-retry-worktree",
        { agent: "worker", task: "写文件", isolation: "worktree" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      const worktree = result.details.results[0].worktree;
      expect(worktree).toMatchObject({ changed: true });
      expect(worktree.id).toMatch(/-r1$/);
      expect(String(result.content[0].text)).not.toContain("目录已存在");
    } finally {
      delete process.env.HPP_TEST_ATTEMPT_FILE;
      await rm(root, { recursive: true, force: true });
      await rm(worktreeBase, { recursive: true, force: true });
    }
  }, 30_000);

  it("inheritContext 失败时回收 worktree 并把 todo 回到 pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-inherit-fail-"));
    const worktreeBase = await mkdtemp(join(tmpdir(), "hpp-pi-inherit-fail-base-"));
    const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, "cli.js"), "process.exit(0);\n", "utf8");
    await writeFile(join(root, "app.txt"), "base\n", "utf8");
    await writeFile(join(root, ".gitignore"), "node_modules/\nsubs/\n", "utf8");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "app.txt", ".gitignore"]);
    git(["commit", "-q", "-m", "base"]);

    const tasks = [{ id: "1", title: "任务", status: "pending" as const, owner: undefined as string | undefined }];
    const store = {
      getTasks: () => tasks.map((task) => ({ ...task })),
      findTask: (id: string) => tasks.find((task) => task.id === id),
      updateTask: (id: string, patch: Record<string, any>) => {
        Object.assign(tasks[0], patch);
        if (patch.owner === "") delete tasks[0].owner;
        return { ...tasks[0] };
      },
    };
    const factory = createHppSubagentExtension({
      packageRoot: root,
      agentDir: join(root, "agent"),
      subagentDataDir: join(root, "subs"),
      worktreeBaseDir: worktreeBase,
      createInheritedSession: () => "",
      getTodoStore: () => store,
      emitPlanUpdate: vi.fn(),
    });
    const tools: Array<Record<string, any>> = [];
    factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
    try {
      const result = await toolByName(tools, "subagent").execute(
        "call-inherit-fail",
        { agent: "worker", task: "写文件", isolation: "worktree", inheritContext: true, todoId: "1" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );
      expect(result.isError).toBe(true);
      // worktree 不能残留，todo 不能永久停在 in_progress。
      const { readdir } = await import("node:fs/promises");
      const leftovers = await readdir(worktreeBase).catch(() => [] as string[]);
      expect(leftovers).toEqual([]);
      expect(tasks[0]).toMatchObject({ status: "pending" });
      expect(tasks[0].owner).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreeBase, { recursive: true, force: true });
    }
  }, 30_000);

  it("后台配置有默认值与范围钳制", () => {
    const defaults = normalizeHppSubagentConfig({});
    expect(defaults).toMatchObject({
      backgroundEnabled: true,
      maxConcurrency: 4,
      autoWakeOnResult: true,
      autoWakeDebounceMs: 3000,
      maxAutoWakeTurns: 3,
      backgroundTimeoutMs: 2 * 60 * 60 * 1000,
    });
    const clamped = normalizeHppSubagentConfig({
      backgroundEnabled: false,
      maxConcurrency: 99,
      autoWakeDebounceMs: 1,
      maxAutoWakeTurns: 0,
      backgroundTimeoutMs: 1,
    });
    expect(clamped).toMatchObject({
      backgroundEnabled: false,
      maxConcurrency: 8,
      autoWakeDebounceMs: 500,
      maxAutoWakeTurns: 1,
      backgroundTimeoutMs: 60_000,
    });
  });
});

/**
 * 回归：子 Agent 单条 JSONL 记录（例如带完整文件内容的 tool_execution_end）
 * 曾超过旧的 256KB 上限就被直接终止，用户看到「子 Agent 协议输出超过
 * 262144 字节限制」。合法的大事件必须能通过，只有真正失控（一直不换行）
 * 的输出才需要跳过。
 */
describe("SubAgent 协议输出上限", () => {
  it("跳过超大记录但不终止子 Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-oversize-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        // 一条 17MB 的记录（超过 16MB 上限），随后是正常收尾事件。
        "const huge = 'x'.repeat(17 * 1024 * 1024);",
        "process.stdout.write(JSON.stringify({type:'tool_execution_end', toolName:'read', toolCallId:'big', result:{content:[{type:'text', text:huge}]}})+'\\n');",
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'survived'}], stopReason:'stop', model:'test/child'}})+'\\n');",
        "process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');",
        "process.stdout.write(JSON.stringify({type:'tool_execution_end', toolName:'read', toolCallId:'big', result:{content:[{type:'text', text:huge}]}})+'\\n');",
        "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'survived'}], stopReason:'stop', model:'test/child'}})+'\\n');",
        "process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const result = await tools[0].execute(
        "call-oversize",
        { agent: "scout", task: "读取超大文件" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );

      // 任务必须继续完成，而不是被协议上限判为失败。
      expect(result).toMatchObject({
        details: { results: [expect.objectContaining({ output: "survived", exitCode: 0 })] },
      });
      expect(result.isError).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * 回归：pi 内部重试成功后，失败尝试的 errorMessage 不能继续挂着。
 * 之前 `result.errorMessage = message.errorMessage || result.errorMessage`
 * 只在成功消息缺字段时保留旧值，用户看到的是「Our servers are currently
 * overloaded」，任务输出其实是完整的。
 */
describe("SubAgent 重试成功后的文案", () => {
  it("清掉上一次失败尝试的 errorMessage，并把任务标成已完成", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-retry-test-"));
    try {
      const cliDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(cliDir, { recursive: true });
      await writeFile(join(cliDir, "cli.js"), [
        "const failed = { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'error', errorMessage: 'Our servers are currently overloaded. Please try again later.', model: 'test/child' } };",
        "const ok = { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '审查完成：未发现缺陷' }], stopReason: 'stop', model: 'test/child' } };",
        "process.stdout.write(JSON.stringify(failed) + '\\n');",
        "process.stdout.write(JSON.stringify(ok) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const result = await tools[0].execute(
        "call-retry",
        { agent: "reviewer", task: "只读审查" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );

      const task = result.details.results[0];
      expect(task).toMatchObject({
        exitCode: 0,
        stopReason: "stop",
        errorMessage: "",
        message: "已完成",
        output: "审查完成：未发现缺陷",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * 回归：子 Agent 必须走自包含的 bundle CLI。
 *
 * 模块树入口要经 node_modules 解析 @earendil-works/pi-ai；升级残留的嵌套旧副本
 * 会让它 ERR_MODULE_NOT_FOUND —— 主会话没事、只有 subagent 全挂。
 */
describe("SubAgent CLI 入口", () => {
  it("优先使用 bundle CLI，而不是模块树 cli.js", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-subagent-bundle-test-"));
    try {
      const packageDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
      await mkdir(join(packageDir, "bundle"), { recursive: true });
      // 模块树入口：一旦被选中就直接失败，方便区分实际用的是哪个。
      await writeFile(join(packageDir, "cli.js"),
        "process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'from-tree'}],stopReason:'stop'}})+'\\n');\n"
        + "process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');\n",
        "utf8");
      await writeFile(join(packageDir, "bundle", "cli-runtime.js"), "", "utf8");
      await writeFile(join(packageDir, "bundle", "cli.js"),
        "process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'from-bundle'}],stopReason:'stop'}})+'\\n');\n"
        + "process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');\n",
        "utf8");

      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const factory = createHppSubagentExtension({ packageRoot: root, agentDir });
      const tools: Array<Record<string, any>> = [];
      factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });

      const result = await tools[0].execute(
        "call-bundle",
        { agent: "scout", task: "看看走了哪个入口" },
        new AbortController().signal,
        undefined,
        { cwd: root, hasUI: false },
      );

      expect(result.details.results[0]).toMatchObject({ exitCode: 0, output: "from-bundle" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
