const assert = require("node:assert/strict");
const { access, mkdtemp, mkdir, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = resolve(__dirname, "..");
const mainDir = join(projectRoot, "out", "main");
const supportedBackends = ["pi", "claude", "droid", "opencode"];
const initTimeoutMs = Math.max(10_000, Number(process.env.HPP_SUBAGENT_PREFLIGHT_TIMEOUT_MS) || 120_000);

const requestedBackends = (() => {
  const argument = process.argv.find((value) => value.startsWith("--backends="));
  const raw = argument?.slice("--backends=".length) || process.env.HPP_SUBAGENT_PREFLIGHT_BACKENDS || supportedBackends.join(",");
  const values = [...new Set(raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
  for (const value of values) {
    if (!supportedBackends.includes(value)) throw new Error(`不支持的 backend：${value}`);
  }
  return values;
})();

const withTimeout = (promise, timeoutMs, label) => new Promise((resolvePromise, rejectPromise) => {
  const timeout = setTimeout(() => rejectPromise(new Error(`${label} 超过 ${timeoutMs}ms`)), timeoutMs);
  Promise.resolve(promise).then(
    (value) => {
      clearTimeout(timeout);
      resolvePromise(value);
    },
    (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    },
  );
});

const summarizeError = (error) => String(error?.stack || error?.message || error)
  .replaceAll(process.env.HPP_DATA_DIR || "\u0000", "<HPP_DATA_DIR>")
  .slice(0, 4000);

const loadAgentConfigState = async (backendId) => {
  const dataDir = process.env.HPP_DATA_DIR;
  if (!dataDir) return undefined;
  try {
    const settings = JSON.parse((await readFile(join(dataDir, "settings.json"), "utf8")).replace(/^\uFEFF/, ""));
    const configs = settings && typeof settings === "object" ? settings.agentConfigs : undefined;
    const config = configs && typeof configs === "object" ? configs[backendId] : undefined;
    return config && typeof config === "object" ? config : undefined;
  } catch {
    return undefined;
  }
};

const runBackend = async (backendId, workspaceDir) => {
  const bundlePath = join(mainDir, `plugin-backend-${backendId}.mjs`);
  await access(bundlePath);
  const module = await import(`${pathToFileURL(bundlePath).href}?preflight=${Date.now()}-${backendId}`);
  assert.equal(typeof module.createBackend, "function", `${backendId} 生产 bundle 未导出 createBackend`);

  const events = [];
  const configState = await loadAgentConfigState(backendId);
  const context = backendId === "claude" && process.env.HPP_DATA_DIR
    ? { dataDir: process.env.HPP_DATA_DIR, getConfigState: async () => configState }
    : undefined;
  const backend = module.createBackend(`live-preflight-${backendId}`, (event) => events.push(event), context);
  const startedAt = Date.now();
  try {
    await withTimeout(
      backend.init(workspaceDir, undefined, {
        hostSystemPrompt: "HPP 发布前只读 preflight：不要执行模型请求或修改文件。",
      }),
      initTimeoutMs,
      `${backendId} 初始化`,
    );
    assert.equal(typeof backend.isIdle, "function", `${backendId} backend 缺少 isIdle()`);
    assert.equal(backend.isIdle(), true, `${backendId} 初始化后不是 idle`);
    assert.ok(
      events.some((event) => event?.type === "agent_ready"),
      `${backendId} 未发出 agent_ready`,
    );
    assert.ok(
      !events.some((event) => event?.type === "process_event" && event?.state === "error"),
      `${backendId} 初始化期间发出了 error process_event`,
    );

    const models = typeof backend.getModels === "function"
      ? await withTimeout(backend.getModels(), 30_000, `${backendId} 模型读取`)
      : [];
    assert.ok(Array.isArray(models), `${backendId} getModels() 未返回数组`);

    let actionCount = 0;
    if (typeof backend.listActions === "function") {
      const actions = await withTimeout(backend.listActions({ reload: true }), 30_000, `${backendId} action 读取`);
      assert.ok(Array.isArray(actions), `${backendId} listActions() 未返回数组`);
      actionCount = actions.length;
      if (backendId === "pi") {
        const names = new Set(actions.map((action) => action?.name));
        for (const workflow of ["implement", "scout-and-plan", "implement-and-review"]) {
          assert.ok(names.has(workflow), `Pi 生产 runtime 缺少内置 workflow：${workflow}`);
        }
      }
    }

    return {
      backendId,
      elapsedMs: Date.now() - startedAt,
      modelCount: models.length,
      actionCount,
      eventCount: events.length,
    };
  } finally {
    if (typeof backend.dispose === "function") {
      await withTimeout(backend.dispose(), 15_000, `${backendId} dispose`).catch(() => undefined);
    }
  }
};

const run = async () => {
  await access(mainDir);
  const tempRoot = await mkdtemp(join(tmpdir(), "hpp-subagent-live-preflight-"));
  const workspaceDir = join(tempRoot, "Workspace With Spaces");
  await mkdir(workspaceDir, { recursive: true });
  const results = [];
  const failures = [];
  try {
    for (const backendId of requestedBackends) {
      try {
        const result = await runBackend(backendId, workspaceDir);
        results.push(result);
        process.stdout.write(
          `[Subagent live preflight] ${backendId}: ready/idle/dispose 通过，models=${result.modelCount}，actions=${result.actionCount}，${result.elapsedMs}ms\n`,
        );
      } catch (error) {
        failures.push({ backendId, error: summarizeError(error) });
        process.stderr.write(`[Subagent live preflight] ${backendId}: 失败\n${summarizeError(error)}\n`);
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  if (failures.length > 0) {
    const failedNames = failures.map((failure) => failure.backendId).join(", ");
    throw new Error(`真实 backend preflight 未全部通过：${failedNames}`);
  }
  process.stdout.write(`[Subagent live preflight] ${results.length} 个真实 backend 生产 bundle 全部通过。\n`);
};

run().catch((error) => {
  process.stderr.write(`${summarizeError(error)}\n`);
  process.exitCode = 1;
});
