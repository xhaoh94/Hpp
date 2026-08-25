const assert = require("node:assert/strict");
const { copyFile, mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = resolve(__dirname, "..");
const mainDir = process.env.HPP_PI_PACKAGE_MAIN_DIR
  ? resolve(process.env.HPP_PI_PACKAGE_MAIN_DIR)
  : join(projectRoot, "out", "main");
const requiredFiles = [
  "pi-sdk-worker.mjs",
  "pi-fork-utils.mjs",
  "shell-environment.mjs",
  "plan-mode-policy.mjs",
  "subagent-extension.mjs",
  "subagent-bridge-extension.mjs",
  "subagent-prompts/implement.md",
  "subagent-prompts/scout-and-plan.md",
  "subagent-prompts/implement-and-review.md",
];

const fail = (message) => {
  throw new Error(`[Pi package smoke test] ${message}`);
};

const run = async () => {
  for (const relativePath of requiredFiles) {
    const filePath = join(mainDir, relativePath);
    try {
      require("node:fs").accessSync(filePath);
    } catch {
      fail(`缺少生产文件：${join(mainDir, relativePath)}`);
    }
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "hpp-pi-package-smoke-"));
  try {
    // 模拟 electron-builder 的安装布局，并刻意使用带空格路径，确保扩展和 prompt
    // 不会意外依赖源码工作区或未经转义的 Windows 安装路径。
    const installedMainDir = join(tempRoot, "Hpp Installed Runtime", "resources", "app", "out", "main");
    for (const relativePath of requiredFiles) {
      const installedPath = join(installedMainDir, relativePath);
      await mkdir(dirname(installedPath), { recursive: true });
      await copyFile(join(mainDir, relativePath), installedPath);
    }

    const workerText = require("node:fs").readFileSync(join(installedMainDir, "pi-sdk-worker.mjs"), "utf8");
    assert.match(workerText, /additionalPromptTemplatePaths/);
    assert.match(workerText, /subagent-prompts/);
    for (const promptName of ["implement", "scout-and-plan", "implement-and-review"]) {
      const promptText = require("node:fs").readFileSync(
        join(installedMainDir, "subagent-prompts", `${promptName}.md`),
        "utf8",
      );
      assert.ok(promptText.trim().length > 0, `内置 prompt 不能为空：${promptName}`);
    }

    const extensionModule = await import(pathToFileURL(join(installedMainDir, "subagent-extension.mjs")).href);
    const bridgeModule = await import(pathToFileURL(join(installedMainDir, "subagent-bridge-extension.mjs")).href);
    assert.equal(typeof extensionModule.createHppSubagentExtension, "function");
    assert.equal(typeof bridgeModule.default, "function");

    const packageRoot = join(tempRoot, "Pi Package Root With Spaces");
    const cliDir = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.0.0-package-smoke",
      type: "module",
    }), "utf8");
    await writeFile(join(cliDir, "cli.js"), [
      "process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'production child summary'}], stopReason:'stop', model:'test/production-child'}})+'\\n');",
    ].join("\n"), "utf8");

    const workspaceDir = join(tempRoot, "Workspace With Spaces");
    await mkdir(workspaceDir, { recursive: true });

    const tools = [];
    const factory = extensionModule.createHppSubagentExtension({
      packageRoot,
      agentDir: join(tempRoot, "agent"),
    });
    factory({ registerTool: (tool) => tools.push(tool) });
    const subagentTool = tools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "生产扩展没有注册 subagent 工具");

    const result = await subagentTool.execute(
      "package-smoke-call",
      { agent: "scout", task: "验证安装后的 Pi 扩展" },
      new AbortController().signal,
      undefined,
      { cwd: workspaceDir, hasUI: false },
    );
    assert.deepEqual(result.details.mode, "single");
    assert.equal(result.details.results[0].exitCode, 0);
    assert.equal(result.details.results[0].output, "production child summary");
    assert.equal(result.details.results[0].model, "test/production-child");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write("[Pi package smoke test] 模拟安装目录中的生产扩展、桥接扩展、worker 依赖和内置 prompts 验证通过。\n");
};

run().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
