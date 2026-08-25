const assert = require("node:assert/strict");
const { access, mkdtemp, mkdir, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = resolve(__dirname, "..");
const mainDir = join(projectRoot, "out", "main");
const supportedBackends = new Set(["pi", "claude", "droid", "opencode"]);
const timeoutMs = Math.max(30_000, Number(process.env.HPP_SUBAGENT_LIVE_TIMEOUT_MS) || 5 * 60_000);
const marker = "HPP_SUBAGENT_LIVE_OK";

const readArgument = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim();
};

const backendId = (readArgument("backend") || process.env.HPP_SUBAGENT_LIVE_BACKEND || "").toLowerCase();
const requestedModel = readArgument("model") || process.env.HPP_SUBAGENT_LIVE_MODEL || "";
const configAgentId = (readArgument("config-agent") || backendId).toLowerCase();
const configProviderId = readArgument("config-provider") || "";
const configEndpoint = readArgument("config-endpoint") || "";
if (!supportedBackends.has(backendId)) {
  throw new Error("请通过 --backend=pi|claude|droid|opencode 指定真实 backend。");
}
if (!requestedModel) {
  throw new Error("请通过 --model=<provider/model 或 model id> 显式指定测试模型，避免意外使用付费默认模型。");
}

const prompts = {
  pi: `必须调用 subagent 工具，agent 使用 scout。子 Agent 任务：不要读取或修改任何文件，只返回精确文本 ${marker}。主 Agent 在工具完成后只报告成功或失败。`,
  claude: `必须使用原生 Task/subagent 委派工具启动一个只读子 Agent。子 Agent 不要读取或修改文件，只返回精确文本 ${marker}。工具完成后只报告成功或失败。`,
  droid: `必须使用原生 Task/task 或 delegate_task 委派工具启动一个只读子 Agent。子 Agent 不要读取或修改文件，只返回精确文本 ${marker}。工具完成后只报告成功或失败。`,
  opencode: `必须使用原生 task 或 delegate_task 工具启动一个只读子 Agent。子 Agent 不要读取或修改文件，只返回精确文本 ${marker}。工具完成后只报告成功或失败。`,
};

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const withTimeout = (promise, limitMs, label) => new Promise((resolvePromise, rejectPromise) => {
  const timeout = setTimeout(() => rejectPromise(new Error(`${label} 超过 ${limitMs}ms`)), limitMs);
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
const isTerminalState = (value) => value === "completed" || value === "error" || value === "interrupted";
const getEventState = (event) => event?.state || event?.status;
const eventText = (event) => {
  try { return JSON.stringify(event); } catch { return String(event); }
};
const summarizeEvents = (events) => events.slice(-30).map(eventText).join("\n").slice(-12_000);
const isPromptEcho = (value, prompt) => {
  if (!prompt || typeof value !== "string") return false;
  let parsed;
  try { parsed = JSON.parse(value); } catch { return value.trim() === prompt.trim(); }
  return parsed && typeof parsed === "object"
    && parsed.prompt === prompt
    && parsed.result == null
    && parsed.output == null
    && parsed.content == null
    && parsed.message == null
    && parsed.summary == null;
};
const getSubagentResultText = (event) => [
  event?.message,
  event?.result,
  event?.output,
  event?.summary,
  ...(Array.isArray(event?.subagents)
    ? event.subagents.flatMap((subagent) => [subagent?.message, subagent?.result, subagent?.output, subagent?.summary])
    : []),
].filter((value) => value && !isPromptEcho(value, event?.prompt)).map(eventText).join("\n");

const findModel = (models) => models.find((model) => {
  const candidates = [
    model?.id,
    model?.name,
    `${model?.provider}/${model?.id}`,
    `${model?.provider}:${model?.id}`,
  ];
  return candidates.some((candidate) => String(candidate || "").toLowerCase() === requestedModel.toLowerCase());
});

const loadAgentConfigState = async (agentId) => {
  const dataDir = process.env.HPP_DATA_DIR;
  if (!dataDir) return undefined;
  try {
    const settings = JSON.parse((await readFile(join(dataDir, "settings.json"), "utf8")).replace(/^\uFEFF/, ""));
    const configs = settings && typeof settings === "object" ? settings.agentConfigs : undefined;
    const source = configs && typeof configs === "object" ? configs[agentId] : undefined;
    if (!source || typeof source !== "object") return undefined;
    const sourceProviders = Array.isArray(source.providers) ? source.providers : [];
    const providers = sourceProviders
      .filter((provider) => !configProviderId || provider?.providerId === configProviderId)
      .map((provider) => configEndpoint ? { ...provider, endpoint: configEndpoint } : provider);
    return {
      ...source,
      activeProviderId: configProviderId || source.activeProviderId,
      providers,
    };
  } catch {
    return undefined;
  }
};

const run = async () => {
  const bundlePath = join(mainDir, `plugin-backend-${backendId}.mjs`);
  await access(bundlePath);
  const module = await import(`${pathToFileURL(bundlePath).href}?live=${Date.now()}`);
  assert.equal(typeof module.createBackend, "function");

  const tempRoot = await mkdtemp(join(tmpdir(), `hpp-${backendId}-subagent-live-`));
  const workspaceDir = join(tempRoot, "Read Only Workspace With Spaces");
  await mkdir(workspaceDir, { recursive: true });
  const events = [];
  const configState = await loadAgentConfigState(configAgentId);
  const context = backendId === "claude" && process.env.HPP_DATA_DIR
    ? { dataDir: process.env.HPP_DATA_DIR, getConfigState: async () => configState }
    : undefined;
  const backend = module.createBackend(`subagent-live-${backendId}`, (event) => events.push(event), context);

  try {
    await withTimeout(backend.init(workspaceDir, undefined, {
      hostSystemPrompt: "这是发布前只读 subagent 生命周期验证。不要修改文件。",
    }), Math.min(timeoutMs, 120_000), `${backendId} 初始化`);
    const models = await withTimeout(backend.getModels(), 30_000, `${backendId} 模型读取`);
    const selectedModel = findModel(models);
    if (!selectedModel) {
      const available = models.slice(0, 30).map((model) => `${model.provider}/${model.id}`).join(", ");
      throw new Error(`找不到模型 ${requestedModel}。可用模型示例：${available}`);
    }
    await withTimeout(
      backend.setModel(selectedModel.provider, selectedModel.id),
      30_000,
      `${backendId} 模型切换`,
    );

    const startedAt = Date.now();
    await withTimeout(backend.sendMessage(prompts[backendId], undefined, {
      permissionMode: "full-access",
      planModeEnabled: false,
      clientMessageId: `subagent-live-${Date.now()}`,
    }), 45_000, `${backendId} 消息提交`);

    while (Date.now() - startedAt < timeoutMs) {
      const subagentEvents = events.filter((event) => event?.type === "subagent_event");
      const terminal = [...subagentEvents].reverse().find((event) => isTerminalState(getEventState(event)));
      if (terminal && backend.isIdle() && new RegExp(marker).test(getSubagentResultText(terminal))) break;
      const fatalMessage = [...events].reverse().find((event) =>
        (event?.type === "message_end" && event?.stopReason === "error")
        || (event?.type === "stream_delta" && /(?:错误|error|rate limit|unavailable)/i.test(String(event.delta || "")))
      );
      const turnEnded = events.some((event) => event?.type === "agent_end");
      if (backend.isIdle() && subagentEvents.length === 0 && (fatalMessage || turnEnded)) break;
      await delay(250);
    }

    const subagentEvents = events.filter((event) => event?.type === "subagent_event");
    if (subagentEvents.length === 0) {
      const providerFailure = [...events].reverse().find((event) =>
        (event?.type === "message_end" && event?.stopReason === "error")
        || (event?.type === "stream_delta" && /(?:错误|error|rate limit|unavailable)/i.test(String(event.delta || "")))
      );
      if (providerFailure) {
        throw new Error(`模型请求在 subagent 委派前失败：${eventText(providerFailure)}`);
      }
    }
    const started = subagentEvents.find((event) => event?.phase === "started" || getEventState(event) === "running");
    const terminal = [...subagentEvents].reverse().find((event) => isTerminalState(getEventState(event)));
    assert.ok(started, `没有收到 subagent started 生命周期。\n${summarizeEvents(events)}`);
    assert.ok(terminal, `没有收到 subagent terminal 生命周期。\n${summarizeEvents(events)}`);
    assert.equal(getEventState(terminal), "completed", `subagent 未成功完成。\n${eventText(terminal)}`);
    assert.match(getSubagentResultText(terminal), new RegExp(marker), `subagent 结果中缺少 ${marker}；prompt 中的标记不计为结果。`);
    assert.equal(backend.isIdle(), true, `subagent 已完成，但父会话在 ${timeoutMs}ms 内未回到 idle`);

    const duplicatedTools = events.filter((event) => {
      if (event?.type !== "tool_start" && event?.type !== "tool_end") return false;
      const tool = String(event.toolName || event.name || event.tool || "").toLowerCase();
      return tool === "task" || tool === "taskoutput" || tool === "task_output" || tool === "delegate_task" || tool === "subagent";
    });
    assert.equal(duplicatedTools.length, 0, "subagent 被重复发送为普通 tool_start/tool_end");

    process.stdout.write(
      `[Subagent live execution] ${backendId} ${selectedModel.provider}/${selectedModel.id}: started/completed/idle/正文标记/无重复工具事件全部通过，${Date.now() - startedAt}ms。\n`,
    );
  } catch (error) {
    process.stderr.write(`[Subagent live execution] 最近事件：\n${summarizeEvents(events)}\n`);
    throw error;
  } finally {
    if (typeof backend.dispose === "function") await backend.dispose().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
};

run().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
