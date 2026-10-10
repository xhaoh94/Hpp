import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
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

  it("uses confirm dialogs to preserve multi-select questionnaire answers", async () => {
    const tools: Array<Record<string, any>> = [];
    createHppSubagentBridgeExtension({ registerTool: (tool: Record<string, any>) => tools.push(tool), on: () => {} });
    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const select = vi.fn().mockResolvedValue("提交选择");
    const questionnaire = tools.find((tool) => tool.name === "questionnaire");
    const result = await questionnaire!.execute(
      "questionnaire-multi",
      { questions: [{ question: "选择功能", multiSelect: true, options: ["A", "B", "C"] }] },
      new AbortController().signal,
      undefined,
      { hasUI: true, mode: "rpc", ui: { select, confirm } },
    );

    expect(select).toHaveBeenCalledWith("确认选择：选择功能", ["提交选择", "取消"]);
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(result.details.answers[0]).toMatchObject({ selected: ["A", "C"], values: ["A", "C"], multiSelect: true });
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
        defaultModelMode: "custom",
        defaultModel: "provider/first",
        profiles: {},
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

      current = { ...current, defaultModel: "provider/second" };
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

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "subagent", label: "Subagent" });
    expect(tools[0].parameters).toMatchObject({
      type: "object",
      properties: { timeoutMs: { default: 30 * 60 * 1000 } },
    });
  });
});
