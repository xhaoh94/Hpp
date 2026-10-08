import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pi SDK 的内置模型目录位置取决于 npm 怎么排依赖树：
 * - pi <= 1.0.0 随包发布 npm-shrinkwrap.json，把 pi-ai 嵌在 pi-coding-agent/node_modules 下；
 * - pi >= 1.0.1 删掉 shrinkwrap，npm 按默认规则把 @earendil-works/* 提升到顶层。
 *
 * 读不到目录时不会抛错，只会让所有内置模型被当成自定义模型（能力控件全露出来），
 * 所以两种布局都必须能命中，且必须有测试钉住。
 */
describe("pi builtin catalog resolution", () => {
  let tempRoot = "";
  const originalEnv = {
    HPP_DATA_DIR: process.env.HPP_DATA_DIR,
    PI_CONFIG_PATH: process.env.PI_CONFIG_PATH,
  };

  const CATALOG_FILES = {
    // 残缺声明在前、完整声明在后：验证按 id 兜底时保留声明更完整的那条。
    "opencode.json": {
      "openai-completions": {
        "catalog-model": {
          id: "catalog-model",
          name: "Catalog Model",
          provider: "opencode",
          reasoning: true,
          input: ["text"],
          contextWindow: 400000,
          thinkingLevelMap: { off: null, minimal: null, low: "low", high: "high", xhigh: null, max: "max" },
        },
      },
    },
  };

  const layoutPaths = {
    // pi >= 1.0.1：提升到 pi-sdk-runtime/node_modules 顶层。
    hoisted: ["pi-sdk-runtime", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"],
    // pi <= 1.0.0：shrinkwrap 强制嵌套。
    nested: [
      "pi-sdk-runtime", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules",
      "@earendil-works", "pi-ai", "dist", "providers", "data",
    ],
  };

  const seedCatalog = async (segments: string[]) => {
    const dir = join(tempRoot, ...segments);
    await mkdir(dir, { recursive: true });
    for (const [file, content] of Object.entries(CATALOG_FILES)) {
      await writeFile(join(dir, file), JSON.stringify(content), "utf8");
    }
  };

  // config.mjs 在模块级缓存目录读取结果，换布局必须重新加载模块。
  const loadFreshConfig = async () => {
    vi.resetModules();
    return import("./config.mjs");
  };

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hpp-pi-catalog-"));
    process.env.HPP_DATA_DIR = tempRoot;
    process.env.PI_CONFIG_PATH = join(tempRoot, "models.json");
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    await rm(tempRoot, { recursive: true, force: true });
  });

  for (const [layout, segments] of Object.entries(layoutPaths)) {
    it(`resolves builtin models with the ${layout} dependency layout`, async () => {
      await seedCatalog(segments);
      const pi = await loadFreshConfig();

      // 目录命中 → 模型被判为内置，并带出目录里的能力声明。
      // medium 在目录里缺键，按 pi 语义「缺键 = 支持」也算可用档位。
      await expect(pi.lookupModel("catalog-model")).resolves.toMatchObject({
        isBuiltin: true,
        name: "Catalog Model",
        reasoning: true,
        supportedThinkingLevels: ["low", "medium", "high", "max"],
      });
      // 目录里没有的模型仍然是非内置，交给用户自定义能力。
      expect(await pi.lookupModel("not-in-catalog")).toBeNull();
    });
  }

  it("prefers the hoisted layout when both are present", async () => {
    await seedCatalog(layoutPaths.hoisted);
    await seedCatalog(layoutPaths.nested);
    const pi = await loadFreshConfig();

    await expect(pi.lookupModel("catalog-model")).resolves.toMatchObject({ isBuiltin: true });
  });

  it("reports unknown models as non-builtin instead of throwing when no catalog exists", async () => {
    const pi = await loadFreshConfig();

    // 目录完全缺失属于可容忍状态：返回 null（判为自定义模型），不抛异常。
    await expect(pi.lookupModel("catalog-model")).resolves.toBeNull();
  });
});