import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error - 插件入口是纯 ESM，没有类型声明
import { activateProvider, buildLoginProvider, checkinUrlFor, readCredentials, readProviderConfig } from "./config.mjs";

// @ts-expect-error - 同上
import * as configModule from "./config.mjs";

const tempDirs: string[] = [];
const originalEnv = {
  CODEBUDDY_AUTH_TOKEN: process.env.CODEBUDDY_AUTH_TOKEN,
  CODEBUDDY_API_KEY: process.env.CODEBUDDY_API_KEY,
  CODEBUDDY_BASE_URL: process.env.CODEBUDDY_BASE_URL,
  CODEBUDDY_PATH: process.env.CODEBUDDY_PATH,
};

const createTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hpp-codebuddy-config-"));
  tempDirs.push(dir);
  return dir;
};

const clearEnv = () => {
  delete process.env.CODEBUDDY_AUTH_TOKEN;
  delete process.env.CODEBUDDY_API_KEY;
  delete process.env.CODEBUDDY_BASE_URL;
  delete process.env.CODEBUDDY_PATH;
};

/** 在临时 home 下写 CLI 的模型目录（.codebuddy/local_storage/*.info）。 */
const writeCatalog = (home: string, entries: Array<{ name: string; value: unknown }>) => {
  const dir = join(home, ".codebuddy", "local_storage");
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    writeFileSync(join(dir, entry.name), JSON.stringify(entry.value), "utf-8");
  }
};

const catalogModel = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  maxInputTokens: 200000,
  supportsReasoning: true,
  ...extra,
});

beforeEach(() => {
  clearEnv();
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("readCredentials", () => {
  it("读取 apiBaseUrl / token / accountId", () => {
    const home = createTempDir();
    writeFileSync(join(home, "credentials.json"), JSON.stringify({
      apiBaseUrl: "https://www.workbuddy.cn",
      token: "tok-123",
      accountId: "abc123def456",
    }), "utf8");
    expect(readCredentials(home)).toMatchObject({
      token: "tok-123",
      apiBaseUrl: "https://www.workbuddy.cn",
      accountId: "abc123def456",
    });
  });

  it("没有 token 或文件损坏时返回 null", () => {
    const home = createTempDir();
    expect(readCredentials(home)).toBeNull();
    writeFileSync(join(home, "credentials.json"), "{not json", "utf8");
    expect(readCredentials(home)).toBeNull();
  });
});

describe("buildLoginProvider", () => {
  it("用 accountId 前 12 位生成稳定的渠道 id", () => {
    const provider = buildLoginProvider({
      token: "tok",
      apiBaseUrl: "https://www.workbuddy.cn",
      accountId: "ABCDEF123456XYZ",
    });
    expect(provider.providerId).toBe("codebuddy-abcdef123456");
    expect(provider.displayName).toContain("CodeBuddy");
    expect(provider.baseUrl).toBe("https://www.workbuddy.cn");
    expect(provider.apiKey).toBe("tok");
    expect(provider.endpoint).toBe("codebuddy");
  });

  it("渠道模型只来自 CLI 目录，读不到时为空", () => {
    const home = createTempDir();
    writeCatalog(home, [{
      name: "entry-codebuddy.info",
      value: {
        productName: "CodeBuddy",
        models: [
          { id: "default", name: "Default", credits: "x0.50 credits", maxInputTokens: 200000 },
          { id: "hy4flash-free", name: "Hy4 flash", credits: "x0.00 credits", maxInputTokens: 192000 },
        ],
      },
    }]);

    const withCatalog = buildLoginProvider({ token: "tok", apiBaseUrl: "", accountId: "" }, home);
    expect(withCatalog.providerId).toBe("codebuddy-account");
    expect(withCatalog.models.map((model: { id: string }) => model.id)).toEqual(["default", "hy4flash-free"]);
    expect(withCatalog.baseUrl).toBeTruthy();

    // 没有 CLI 目录就是空列表：不再用内置候选填充。
    const emptyHome = createTempDir();
    const withoutCatalog = buildLoginProvider({ token: "tok", apiBaseUrl: "", accountId: "" }, emptyHome);
    expect(withoutCatalog.models).toEqual([]);
  });
});

describe("readProviderConfig", () => {
  it("环境变量里有 token 时直接生成渠道", async () => {
    process.env.CODEBUDDY_AUTH_TOKEN = "env-token";
    process.env.CODEBUDDY_BASE_URL = "https://www.workbuddy.cn";
    const state = await readProviderConfig();
    expect(state.providers).toHaveLength(1);
    expect(state.providers[0].apiKey).toBe("env-token");
    expect(state.providers[0].baseUrl).toBe("https://www.workbuddy.cn");
  });

  it("首次发现能读到桌面端 auth 里的已登录账号", async () => {
    const localAppData = createTempDir();
    const authDir = join(localAppData, "CodeBuddyExtension", "Data", "Public", "auth");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "Tencent-Cloud.coding-copilot.info"), JSON.stringify({
      account: { uid: "u-123", nickname: "测试账号" },
      auth: { accessToken: "tok", domain: "www.workbuddy.cn" },
    }), "utf8");
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = localAppData;
    try {
      const state = await readProviderConfig();
      expect(state.providers).toHaveLength(1);
      expect(state.providers[0].providerId).toBe("codebuddy-u123");
      expect(state.providers[0].displayName).toContain("测试账号");
      expect(state.providers[0].endpoint).toBe("codebuddy");
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
    }
  });
});

describe("checkinUrlFor", () => {
  it("跟随账号 domain 选择签到站点", () => {
    expect(checkinUrlFor({ domain: "www.workbuddy.cn" }))
      .toBe("https://www.workbuddy.cn/v2/billing/meter/daily-checkin");
    expect(checkinUrlFor({ domain: "https://www.codebuddy.ai/" }))
      .toBe("https://www.codebuddy.ai/v2/billing/meter/daily-checkin");
  });

  it("没有 domain 时回退国内站点", () => {
    expect(checkinUrlFor({})).toBe("https://www.codebuddy.cn/v2/billing/meter/daily-checkin");
  });
});

describe("activateProvider", () => {
  it("缺少渠道 URL 时报错", async () => {
    await expect(activateProvider({ providerId: "a", baseUrl: "" })).rejects.toThrow(/渠道 URL/);
  });

  it("合法渠道不需要写任何原生配置", async () => {
    await expect(activateProvider({ providerId: "a", baseUrl: "https://www.codebuddy.ai" })).resolves.toEqual({});
  });
});

describe("buildLoginCommandLine", () => {
  it("内嵌包的命令行带 FORCE_LITE_WB_BUNDLE", () => {
    const { buildLoginCommandLine } = configModule;
    const line = buildLoginCommandLine({ scriptPath: "C:\\wb\\bin\\codebuddy", bundled: true });
    expect(line).toContain("CODEBUDDY_FORCE_LITE_WB_BUNDLE=1");
    expect(line).toContain("codebuddy");
  });
});

describe("登录方式与 PTY", () => {
  it("默认中文站，支持国际站/企业域名/iOA 等写法", () => {
    const { normalizeLoginMethod } = configModule;
    expect(normalizeLoginMethod()).toBe("chinese");
    expect(normalizeLoginMethod(undefined)).toBe("chinese");
    expect(normalizeLoginMethod("cn")).toBe("chinese");
    expect(normalizeLoginMethod("international")).toBe("international");
    expect(normalizeLoginMethod("enterprise")).toBe("enterprise");
    expect(normalizeLoginMethod("ioa")).toBe("ioa");
    expect(normalizeLoginMethod("whatever")).toBe("chinese");
  });

  it("能定位到 @lydell/node-pty（浏览器登录靠它后台驱动 CLI）", () => {
    const { loadNodePty } = configModule;
    const pty = loadNodePty();
    expect(pty).toBeTruthy();
    expect(typeof pty.spawn).toBe("function");
  });
});

describe("从 CLI 日志抓授权 URL", () => {
  const localDateStamp = (date: Date) => {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };

  it("抓到最近一次 Opening auth URL", () => {
    const { findRecentAuthUrl } = configModule;
    const home = createTempDir();
    const now = new Date();
    const dir = join(home, ".codebuddy", "logs", localDateStamp(now));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hpp.log"), [
      "[2026/11/25 10:51:34.202] [Info] [CliExternalUriOpener] Attempting to open external URI",
      "[2026/11/25 10:51:34.202] [Info] [CliExternalUriOpener] UrlUtils.openUrl result: true",
      "[2026/11/25 10:51:34.202] [Info] [ExternalLinkAuthenticationProvider]  Opening auth URL: https://copilot.tencent.com/login?platform=CLI&state=abc123&version=2.186.0",
    ].join("\n"), "utf8");

    const url = findRecentAuthUrl(Date.now() - 60_000, Date.now(), home);
    expect(url).toBe("https://copilot.tencent.com/login?platform=CLI&state=abc123&version=2.186.0");
  });

  it("日志目录不存在时返回空串", () => {
    const { findRecentAuthUrl } = configModule;
    expect(findRecentAuthUrl(Date.now() - 60_000, Date.now(), createTempDir())).toBe("");
  });

  it("从日志里识别 auth_success（新版 CLI 登录态不在 credentials.json）", () => {
    const { findRecentAuthSuccess } = configModule;
    const home = createTempDir();
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const dir = join(home, ".codebuddy", "logs", localDateStamp(now));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hpp.log"), `[${stamp}.000] [Info] [pid=1] [AuthenticationSessionListener] [auth_success: H]  认证成功\n`, "utf8");

    expect(findRecentAuthSuccess(Date.now() - 60_000, Date.now(), home)).toBe(true);
    // 早于打开登录窗口的 auth_success 不算本次登录。
    expect(findRecentAuthSuccess(Date.now() + 60_000, Date.now(), home)).toBe(false);
  });
});

describe("用 CLI 登录态建渠道", () => {
  it("拿不到 token 时渠道 apiKey 为空，模型列表来自 CLI 目录", () => {
    const { buildCliSessionProvider } = configModule;
    const home = createTempDir();
    writeCatalog(home, [{
      name: "entry-codebuddy.info",
      value: { productName: "CodeBuddy", models: [catalogModel("hy4flash-free")] },
    }]);
    const provider = buildCliSessionProvider("4e95431b-4486-4e44-a818-d993e0cf4a3c", undefined, home);
    expect(provider.providerId).toBe("codebuddy-4e95431b448");
    expect(provider.apiKey).toBe("");
    expect(provider.baseUrl).toBeTruthy();
    expect(provider.endpoint).toBe("codebuddy");
    expect(provider.models.map((model: { id: string }) => model.id)).toEqual(["hy4flash-free"]);
  });

  it("CLI 目录不存在时模型列表为空", () => {
    const { buildCliSessionProvider } = configModule;
    const provider = buildCliSessionProvider("4e95431b-4486-4e44-a818-d993e0cf4a3c", undefined, createTempDir());
    expect(provider.models).toEqual([]);
  });
});

describe("CLI 缓存里的模型目录", () => {
  const writeCatalog = (home: string, entries: Array<{ name: string; value: unknown }>) => {
    const dir = join(home, ".codebuddy", "local_storage");
    mkdirSync(dir, { recursive: true });
    for (const entry of entries) {
      writeFileSync(join(dir, entry.name), JSON.stringify(entry.value), "utf-8");
    }
  };

  it("优先取 CodeBuddy 产品线的配置，而不是模型更多的 WorkBuddy 那份", () => {
    const home = createTempDir();
    writeCatalog(home, [
      {
        name: "entry-workbuddy.info",
        value: {
          productName: "WorkBuddy",
          endpoint: "https://www.workbuddy.cn",
          models: [
            { id: "default", name: "Default", credits: "x1.00 credits", maxInputTokens: 200000 },
            { id: "codewise-completions", name: "Completion" },
            { id: "hunyuan-3b", name: "Hunyuan 3B" },
          ],
        },
      },
      {
        name: "entry-codebuddy.info",
        value: {
          productName: "CodeBuddy",
          endpoint: "https://copilot.tencent.com",
          models: [
            { id: "default", name: "Default", credits: "x0.50 credits", maxInputTokens: 200000 },
            { id: "hy4flash-free", name: "Hy4 flash", credits: "x0.00 credits", maxInputTokens: 192000 },
          ],
        },
      },
    ]);

    const models = configModule.readCliModelCatalog(home);
    const ids = models.map((model: { id: string }) => model.id);
    expect(ids).toEqual(["default", "hy4flash-free"]);
  });

  it("按 agent 的 models 白名单裁剪（与 CLI --model 支持列表一致），并合并免费/付费同名模型", () => {
    const home = createTempDir();
    writeCatalog(home, [
      {
        name: "entry-codebuddy.info",
        value: {
          productName: "CodeBuddy",
          agents: [{ name: "cli", modelTags: ["craft"], models: ["glm-5.3", "hy4flash-free", "hy4flash"] }],
          productFeaturesConfig: {
            ModelRateLimitCap: { lines: [{ displayName: "Hy4 flash", freeId: "hy4flash-free", paidId: "hy4flash" }] },
          },
          models: [
            { id: "default", name: "Default", credits: "x2.00 credits", maxInputTokens: 200000 },
            { id: "glm-5.3", name: "GLM-5.3", credits: "x0.69 credits", maxInputTokens: 1000000 },
            { id: "glm-4.6", name: "GLM-4.6", credits: "x0.23 credits", maxInputTokens: 200000 },
            { id: "hy4flash-free", name: "Hy4 flash", credits: "x0.00 credits", maxInputTokens: 192000 },
            { id: "hy4flash", name: "Hy4 flash", credits: "x0.03 credits", maxInputTokens: 192000 },
          ],
        },
      },
    ]);

    const models = configModule.readCliModelCatalog(home);
    const ids = models.map((model: { id: string }) => model.id);
    expect(ids).toEqual(["default", "glm-5.3", "hy4flash-free"]);
    expect(ids).not.toContain("glm-4.6");
    expect(ids).not.toContain("hy4flash");
  });

  it("保留免费模型，只排除图片/视频生成与补全模型", () => {
    const home = createTempDir();
    writeCatalog(home, [
      {
        name: "entry-codebuddy.info",
        value: {
          productName: "CodeBuddy",
          models: [
            { id: "hy4flash-free", name: "Hy4 flash", credits: "x0.00 credits", maxInputTokens: 192000 },
            { id: "hy4flash", name: "Hy4 flash", credits: "x0.03 credentials", maxInputTokens: 192000 },
            { id: "hunyuan-image-alpha", name: "Hunyuan Image", tags: ["text-to-image"] },
            { id: "kling-video-v3", name: "Kling", tags: ["text-to-video"] },
            { id: "codewise-jump", name: "Jump", credits: "x0.01 credits" },
          ],
        },
      },
    ]);

    const models = configModule.readCliModelCatalog(home);
    const ids = models.map((model: { id: string }) => model.id);
    expect(ids).toContain("hy4flash-free");
    expect(ids).not.toContain("hunyuan-image-alpha");
    expect(ids).not.toContain("kling-video-v3");
    expect(ids).not.toContain("codewise-jump");
    // 重名模型补 id 区分
    expect(models.filter((model: { name: string }) => model.name.includes("Hy4 flash")).length).toBe(2);
  });
});