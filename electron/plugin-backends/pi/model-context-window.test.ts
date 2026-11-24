import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveModelContextWindow as hostResolve,
  type ModelContextCatalogData,
} from "../../../shared/model-context-catalog";
import {
  createHppContextWindowIndex,
  loadHppContextWindowIndex,
  resolveHppContextWindow,
} from "./model-context-window.mjs";

/**
 * worker 侧有一份主进程目录解析的副本（.mjs 没法 import .ts）。
 *
 * 两份一旦漂了，症状是「界面显示一个上下文上限、pi 内部按另一个上限触发压缩」：
 * 分母偏大就是压缩偏晚（可能真撞上游硬上限），偏小就是压得过勤。都不会报错，
 * 所以这里用真实目录把两边逐条钉住。
 */
const catalogPath = join(process.cwd(), "resources", "model-context-catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as ModelContextCatalogData;
const index = createHppContextWindowIndex(catalog);

const hostWindow = (provider: string, modelId: string) =>
  hostResolve(catalog, { provider, modelId })?.window ?? 0;

describe("worker 侧的窗口解析与主进程保持一致", () => {
  it("目录里的每一条 provider+model 都解析出同一个窗口", () => {
    expect(index).not.toBeNull();
    let checked = 0;
    for (const [provider, models] of Object.entries(catalog.providers)) {
      for (const modelId of Object.keys(models)) {
        const expected = hostWindow(provider, modelId);
        const actual = resolveHppContextWindow(index, provider, modelId);
        expect(actual, `${provider}/${modelId}`).toBe(expected);
        if (expected > 0) checked += 1;
      }
    }
    // 真实目录上万条，确认不是空跑。
    expect(checked).toBeGreaterThan(1000);
  });

  it("自定义渠道（目录里没有这个 provider）走家族/聚合，结果同样一致", () => {
    const cases: Array<[string, string]> = [
      ["tanwan", "deepseek-v4.1-flash"],
      ["tanwan", "gpt-6.2-astra"],
      ["tanwan", "claude-opus-5-5"],
      ["tanwan", "claude-sonnet-5-5"],
      ["tanwan", "gpt-6.2-sol"],
      ["pixel", "gpt-5.4"],
      ["edgefn", "GLM-5.1"],
      ["codex", "gpt-5.3-codex"],
      ["claude", "claude-opus-5-5"],
      ["opencode", "deepseek-v4-flash-free"],
      ["opencode", "big-pickle"],
      // 聚合渠道常见的 `vendor/model` 写法与 `:free` 后缀。
      ["tanwan", "deepseek/deepseek-v4.1-flash"],
      ["tanwan", "GLM-5.1:free"],
      // 目录里根本没有的模型：两边都必须给「未命中」。
      ["tanwan", "hpp-private-model-v1"],
    ];
    for (const [provider, modelId] of cases) {
      expect(resolveHppContextWindow(index, provider, modelId), `${provider}/${modelId}`)
        .toBe(hostWindow(provider, modelId));
    }
    // 确认这些用例真的命中了，不是两边一起返回 0。
    expect(resolveHppContextWindow(index, "tanwan", "deepseek-v4.1-flash")).toBeGreaterThan(0);
    expect(resolveHppContextWindow(index, "codex", "gpt-5.3-codex")).toBeGreaterThan(0);
    expect(resolveHppContextWindow(index, "tanwan", "hpp-private-model-v1")).toBe(0);
  });

  it("口径是输入上限（Hpp 统计的 token），不是总窗口", () => {
    // gpt-5.3-codex 在目录里 context=400000 / input=272000：分母必须是后者。
    expect(resolveHppContextWindow(index, "openai", "gpt-5.3-codex")).toBe(272000);
  });

  it("目录损坏或缺失时返回 null，worker 继续用 pi 自己的 catalogue", () => {
    const missing = () => { throw new Error("ENOENT"); };
    expect(loadHppContextWindowIndex({ dataDir: "/nope", bundledPath: "/nope", readFile: missing })).toBeNull();
    expect(loadHppContextWindowIndex({ readFile: () => "{not json" })).toBeNull();
    expect(loadHppContextWindowIndex({ readFile: () => JSON.stringify({ providers: {} }) })).toBeNull();
  });

  it("优先读数据目录里的刷新缓存", () => {
    const reads: string[] = [];
    const loaded = loadHppContextWindowIndex({
      dataDir: "/data",
      bundledPath: "/bundle/catalog.json",
      readFile: (path: string) => {
        reads.push(path);
        return readFileSync(catalogPath, "utf8");
      },
    });
    expect(loaded).not.toBeNull();
    expect(reads[0]).toBe(join("/data", "model-context-catalog.json"));
  });
});

describe("pi 内部压缩分母的接线", () => {
  const workerSource = readFileSync(
    join(process.cwd(), "electron", "plugin-backends", "pi", "worker.mjs"),
    "utf8",
  );
  const backendSource = readFileSync(
    join(process.cwd(), "electron", "plugin-backends", "pi", "backend.ts"),
    "utf8",
  );

  it("worker 启动时读 Hpp 目录，并把它的窗口排在 pi catalogue 之前", () => {
    expect(workerSource).toContain("loadHppContextWindowIndex");
    expect(workerSource).toContain("resolveHppContextWindow");
    // 顺序反了就会退回「界面一个数、内部另一个数」。
    const resolveBlock = workerSource.slice(workerSource.indexOf("const resolveCatalogueWindow"));
    expect(resolveBlock.indexOf("resolveHppContextWindow")).toBeLessThan(
      resolveBlock.indexOf("catalogue.windows.get"),
    );
  });

  it("主进程把内置目录路径传给 worker", () => {
    expect(backendSource).toContain("HPP_MODEL_CONTEXT_CATALOG");
    expect(backendSource).toContain("getBundledModelContextCatalogPath()");
  });

  // 插件后端包是 ESM（没有 __dirname），宿主进程只注入 HPP_AGENT_BACKEND_DIR。
  it("目录路径解析不裸用 __dirname（ESM 后端包会 ReferenceError）", () => {
    const catalogSource = readFileSync(
      join(process.cwd(), "electron", "agents", "model-context-catalog.ts"),
      "utf8",
    );
    expect(catalogSource).not.toContain("join(__dirname");
    const pathBlock = catalogSource.slice(catalogSource.indexOf("function getModuleDir"));
    expect(pathBlock).toContain("typeof __dirname");
    expect(pathBlock).toContain("HPP_AGENT_BACKEND_DIR");
  });

  // SDK catalogue 建不起来时（版本差异 / 初始化异常），不能连带丢掉 Hpp 目录。
  it("SDK catalogue 不可用时仍按 Hpp 目录压缩", () => {
    const loadBlock = workerSource.slice(workerSource.indexOf("const getBuiltinContextWindows"));
    const body = loadBlock.slice(0, loadBlock.indexOf("const resolveCatalogueWindow"));
    expect(body.indexOf("loadHppContextWindowIndex")).toBeLessThan(body.indexOf("ModelRuntime.create"));
    expect(body.match(/builtinContextWindows = hppIndex/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("会话模型登记时把目录窗口交给压缩判定", () => {
    const managerSource = readFileSync(
      join(process.cwd(), "electron", "agents", "agent-manager.ts"),
      "utf8",
    );
    const block = managerSource.slice(managerSource.indexOf("private applySessionModel"));
    // 少了这一步，Hpp 的阈值判定会退回插件上报的窗口，与界面显示的分母脱节。
    expect(block).toContain("resolveModelContextWindowFor");
    expect(block).toContain("setSessionContextWindow");
  });
});
