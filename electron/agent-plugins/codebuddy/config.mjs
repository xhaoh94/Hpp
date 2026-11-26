import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CodeBuddy / WorkBuddy 插件的渠道（= 账号）适配层。
 *
 * CLI 2.186 的登录态在桌面端数据目录（Windows 为
 * `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth`）。Windows 上通过给每个
 * 渠道注入不同的 LOCALAPPDATA 做账号隔离；token 型渠道则走
 * CODEBUDDY_AUTH_TOKEN / CODEBUDDY_BASE_URL，不覆盖用户的登录文件。
 */

const PUBLIC_COMMANDS = ["codebuddy", "cbc", "codebuddy-code"];
const CREDENTIAL_FILE_NAME = "credentials.json";
const DEFAULT_LOGIN_TIMEOUT_MS = 180_000;
const MAX_LOGIN_TIMEOUT_MS = 600_000;
const LOGIN_POLL_INTERVAL_MS = 1_500;
/**
 * 每个账号一个独立目录，隔离桌面端数据根。
 * Windows 上 CLI 的登录态存在
 * `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info`
 * （明文 JSON，含 uid / 昵称 / accessToken），换 LOCALAPPDATA 就能换账号——实测有效。
 * 之前试过隔离 HOME/USERPROFILE，无效：凭据不在用户目录里。
 * macOS / Linux 暂不支持目录隔离（见 accountEnv），只能复用系统默认账号。
 */
const ACCOUNTS_DIR_NAME = "codebuddy-accounts";
const AUTH_RELATIVE_DIR = join("CodeBuddyExtension", "Data", "Public", "auth");
const AUTH_FILE_NAME = "Tencent-Cloud.coding-copilot.info";

export function accountsRoot() {
  const dataDir = String(process.env.HPP_DATA_DIR || "").trim();
  return dataDir ? join(dataDir, ACCOUNTS_DIR_NAME) : "";
}

/** 渠道（账号）对应的独立目录；不存在时返回空串（回退到系统默认）。 */
export function accountDirFor(providerId) {
  const root = accountsRoot();
  const id = String(providerId || "").trim();
  if (!root || !id) return "";
  return join(root, id);
}

/** 兼容旧名字。 */
export const accountHomeFor = accountDirFor;

function createPendingAccountDir() {
  // 目录隔离依赖 LOCALAPPDATA，只在 Windows 上有效。
  if (process.platform !== "win32") return "";
  const root = accountsRoot();
  if (!root) return "";
  const dir = join(root, `pending-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** CLI 的账号数据跟着 LOCALAPPDATA 走（仅 Windows 能通过环境变量换账号）。 */
export function accountEnv(dir) {
  if (process.platform !== "win32") return {};
  return dir ? { LOCALAPPDATA: dir } : {};
}

/** 桌面端数据根：Windows 看 LOCALAPPDATA，macOS/Linux 用各自约定。 */
function defaultLocalAppData() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (process.platform === "linux") return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(homedir(), "AppData", "Local");
}

/**
 * 读某个 LOCALAPPDATA 下的登录账号（明文 JSON）。
 * 返回 null 表示未登录。
 */
export function readAuthInfo(localAppData = defaultLocalAppData()) {
  const file = join(localAppData, AUTH_RELATIVE_DIR, AUTH_FILE_NAME);
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    const account = raw?.account || {};
    const uid = asString(account.uid);
    if (!uid) return null;
    return {
      uid,
      nickname: asString(account.nickname),
      phone: asString(account.phoneNumber),
      accessToken: asString(raw?.auth?.accessToken),
      domain: asString(raw?.auth?.domain),
      enterpriseId: asString(account.oneidAccountId),
      expiresAt: Number(raw?.auth?.expiresAt) || 0,
      file,
    };
  } catch {
    return null;
  }
}

/** 渠道对应的凭据目录（没建过则回退系统默认账号）。 */
export function credentialDirFor(providerId) {
  const dir = accountDirFor(providerId);
  if (dir && existsSync(join(dir, AUTH_RELATIVE_DIR, AUTH_FILE_NAME))) return dir;
  return "";
}

const DEFAULT_CHECKIN_HOST = "www.codebuddy.cn";
const CHECKIN_PATH = "/v2/billing/meter/daily-checkin";
const CHECKIN_TIMEOUT_MS = 15_000;

/** 签到接口跟着账号所属站点走（国内 codebuddy.cn / 国际 codebuddy.ai / WorkBuddy）。 */
export function checkinUrlFor(auth) {
  const domain = asString(auth?.domain)
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  const host = domain || DEFAULT_CHECKIN_HOST;
  return `https://${host}${CHECKIN_PATH}`;
}

/**
 * 每日签到领取积分（WorkBuddy / CodeBuddy 国内版）。
 * 接口：POST /v2/billing/meter/daily-checkin，Bearer 鉴权；返回 code=0 表示领到，
 * msg 包含“已签到”表示今天已领过。
 */
export async function claimDailyCredit(providerId = "") {
  const dir = credentialDirFor(providerId);
  const auth = readAuthInfo(dir || defaultLocalAppData());
  if (!auth) return { success: false, error: "未找到登录凭据，请先导入或登录账号。" };
  if (!auth.accessToken) return { success: false, error: "凭据里没有 accessToken，请重新导入账号。" };
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-User-Id": auth.uid,
  };
  if (auth.domain) headers["X-Domain"] = auth.domain;
  if (auth.enterpriseId) {
    headers["X-Enterprise-Id"] = auth.enterpriseId;
    headers["X-Tenant-Id"] = auth.enterpriseId;
  }
  let response;
  const signal = AbortSignal.timeout(CHECKIN_TIMEOUT_MS);
  try {
    response = await fetch(checkinUrlFor(auth), {
      method: "POST",
      headers,
      body: "{}",
      signal,
    });
  } catch (error) {
    return {
      success: false,
      state: "failed",
      error: signal.aborted
        ? "签到请求超时，请稍后重试。"
        : `网络请求失败：${error instanceof Error ? error.message : String(error)}`,
      uid: auth.uid,
      nickname: auth.nickname,
    };
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (signal.aborted) {
      return {
        success: false,
        state: "failed",
        error: "签到请求超时，请稍后重试。",
        uid: auth.uid,
        nickname: auth.nickname,
      };
    }
    payload = null;
  }
  const msg = asString(payload?.msg) || asString(payload?.message);
  const credit = Number(payload?.data?.credit);
  const base = { uid: auth.uid, nickname: auth.nickname };
  if (/已签到|already/i.test(msg)) {
    return { success: true, state: "already", message: msg || "今天已经签到过了", ...base };
  }
  if (!response.ok || (typeof payload?.code === "number" && payload.code !== 0)) {
    return { success: false, state: "failed", error: msg || `签到失败（HTTP ${response.status}）`, ...base };
  }
  return {
    success: true,
    state: "signed",
    ...(Number.isFinite(credit) ? { credit } : {}),
    message: msg || "签到成功",
    ...base,
  };
}

/** 把当前系统账号的凭据同步到独立账号目录（幂等，直接覆盖）。 */
function copyAuthInfoFiles(sourceRoot, targetRoot) {
  const source = join(sourceRoot, AUTH_RELATIVE_DIR);
  const target = join(targetRoot, AUTH_RELATIVE_DIR);
  let copied = 0;
  try {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
      if (!name.endsWith(".info")) continue;
      copyFileSync(join(source, name), join(target, name));
      copied += 1;
    }
  } catch {
    return 0;
  }
  return copied;
}

export function exportCurrentAccount(uid) {
  const providerId = `codebuddy-${slug(uid)}`;
  const root = accountsRoot();
  if (!root) return providerId;
  // 复制失败不影响渠道创建：backend 会回退到系统默认账号。
  copyAuthInfoFiles(defaultLocalAppData(), join(root, providerId));
  return providerId;
}

const asString = (value) => (typeof value === "string" ? value.trim() : "");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findOnPath(binName, env = process.env) {
  const pathValue = env.PATH || env.Path || "";
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const entry of pathValue.split(separator)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${binName}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function findBundledCli(env = process.env) {
  const candidates = [];
  if (process.platform === "win32") {
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (!root) continue;
      candidates.push(join(root, "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy");
  } else {
    candidates.push("/opt/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy");
  }
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export function resolveCli(env = process.env) {
  const explicit = asString(env.CODEBUDDY_PATH);
  if (explicit && existsSync(explicit)) {
    return { scriptPath: explicit, bundled: explicit.includes("app.asar.unpacked") };
  }
  for (const command of PUBLIC_COMMANDS) {
    const found = findOnPath(command, env);
    if (found) return { scriptPath: found, bundled: false };
  }
  const bundled = findBundledCli(env);
  return bundled ? { scriptPath: bundled, bundled: true } : null;
}

export function getCredentialPath(home = homedir()) {
  return join(home, CREDENTIAL_FILE_NAME);
}

/** 只认带 token 且字段形态正确的凭据，避免误读其它工具的同名文件。 */
export function readCredentials(home = homedir()) {
  const file = getCredentialPath(home);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    const token = asString(parsed?.token);
    if (!token) return null;
    const apiBaseUrl = asString(parsed?.apiBaseUrl);
    const accountId = asString(parsed?.accountId);
    return { token, apiBaseUrl, accountId, filePath: file };
  } catch {
    return null;
  }
}

export function readEnvCredentials(env = process.env) {
  const token = asString(env.CODEBUDDY_AUTH_TOKEN) || asString(env.CODEBUDDY_API_KEY);
  if (!token) return null;
  return {
    token,
    apiBaseUrl: asString(env.CODEBUDDY_BASE_URL) || "https://www.codebuddy.cn",
    accountId: asString(env.CODEBUDDY_ACCOUNT_ID),
    filePath: "",
  };
}

const slug = (value) => String(value || "")
  .slice(0, 12)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "")
  .slice(0, 12);

/** hpp 支持的思考档位（与 shared/models.ts 的 THINKING_LEVELS 一致）。 */
const THINKING_LEVEL_IDS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const mapCatalogModel = (model) => {
  const id = String(model?.id || "").trim();
  if (!id) return null;
  const contextWindow = Number(model.maxInputTokens);
  const reasoning = model.supportsReasoning === true;
  // 把服务端给的 credits 倍率拼在名字后面，跟 WorkBuddy 里看到的一致（如 `x0.51`）。
  const credits = typeof model.credits === "string" ? model.credits.replace(/\s*credits$/i, "").trim() : "";
  const baseName = String(model.name || id);
  // 思考档位只认服务端下发的 supportedEfforts：没下发就不提供档位选择，
  // 不再用 low/medium/high 这种硬编码候选猜。
  const thinkingLevels = Array.isArray(model?.reasoning?.supportedEfforts)
    ? model.reasoning.supportedEfforts
        .filter((level) => THINKING_LEVEL_IDS.has(String(level)))
        // CLI 只有 --effort minimal..max，没有真正的“关闭思考”档。
        .filter((level) => level !== "off")
    : [];
  return {
    id,
    name: credits ? `${baseName} · ${credits}` : baseName,
    reasoning,
    imageInput: model.supportsImages === true,
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    // 能力完全由 CLI 目录（内置）管理，配置弹窗不提供手改控件。
    isBuiltin: true,
    hasThinkingLevels: thinkingLevels.length > 0,
    ...(thinkingLevels.length > 0 ? { supportedThinkingLevels: thinkingLevels } : {}),
  };
};

/**
 * 读 CLI 自己缓存的模型目录（`<home>/.codebuddy/local_storage/*.info`，
 * 内容可能是 gzip+base64 的 product 配置）。这样 hpp 的模型列表与服务端下发保持同步。
 */
/**
 * CLI 目录里有 30+ 个模型，其中一部分是内部/下线/补全/图片专用（codewise-*、hunyuan-image-*、kling-video-* 等）。
 * 选配置见 pickCatalogModels；可用模型靠 `credits` 字段识别（免费模型是 `x0.00 credits`，不会被排除）。
 */
const NON_CHAT_MODEL_TAG = /text-to-image|image-to-image|text-to-video|image-to-video/i;

/**
 * 选产品配置。
 * CLI 缓存里同时存了两套：
 *  - productName=CodeBuddy  endpoint=copilot.tencent.com  → CLI / WorkBuddy 实际用的那套
 *  - productName=WorkBuddy  endpoint=www.workbuddy.cn     → 另一套（含 codewise-、hunyuan-3b 等内部模型）
 * 必须按产品名选，不能“取模型最多的”。
 */
function pickCatalogConfig(configs) {
  const usable = configs.filter((item) => Array.isArray(item.models) && item.models.length > 0);
  if (usable.length === 0) return null;
  const sameProduct = usable.filter((item) => String(item.productName || "").toLowerCase() === "codebuddy");
  const pool = sameProduct.length > 0 ? sameProduct : usable;
  return pool.reduce((best, item) => (item.models.length > best.models.length ? item : best), pool[0]);
}

/**
 * 真正决定“下拉里有哪些模型”的是 agent 白名单，不是 credits：
 * `agents[]` 里 modelTags 含 craft 的那个（name=cli）带一个 models 数组，
 * WorkBuddy / CLI 只展示这些 + default（自动档）。其余模型命中目录但不展示。
 */
function readAgentModelWhitelist(config) {
  const agents = Array.isArray(config?.agents) ? config.agents : [];
  const craft =
    agents.find((agent) => Array.isArray(agent?.modelTags) && agent.modelTags.includes("craft")) ??
    agents.find((agent) => Array.isArray(agent?.models) && agent.models.length > 0);
  return Array.isArray(craft?.models) ? craft.models.map((id) => String(id)) : [];
}

/**
 * 免费/付费同模型会下发两个 id（如 Hy4 flash 的 hy4flash-free / hy4flash，被 ModelRateLimitCap 绑定）。
 * WorkBuddy 只展示一条，这里同样合并：保留 freeId，丢掉 paidId。
 */
function readRateLimitPairs(config) {
  const lines = config?.productFeaturesConfig?.ModelRateLimitCap?.lines;
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((line) => line?.freeId && line?.paidId)
    .map((line) => ({ freeId: String(line.freeId), paidId: String(line.paidId) }));
}

/** 只排除“不是对话模型”的条目：图片/视频生成、补全/内部模型。 */
function isUsableCatalogModel(model) {
  const id = String(model?.id || "");
  const tags = Array.isArray(model?.tags) ? model.tags.join(",") : "";
  if (NON_CHAT_MODEL_TAG.test(tags)) return false;
  if (/^(completion-|codewise-)/.test(id)) return false;
  return true;
}

export function readCliModelCatalog(home = homedir()) {
  const dir = join(home, ".codebuddy", "local_storage");
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const configs = [];
  for (const name of names) {
    if (!name.endsWith(".info")) continue;
    let raw = "";
    try {
      raw = readFileSync(join(dir, name), "utf-8");
    } catch {
      continue;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    if (typeof value === "string" && value.startsWith("H4sI")) {
      try {
        value = JSON.parse(gunzipSync(Buffer.from(value, "base64")).toString("utf-8"));
      } catch {
        continue;
      }
    }
    if (value && typeof value === "object" && Array.isArray(value.models)) configs.push(value);
  }
  const config = pickCatalogConfig(configs);
  if (!config) return [];

  const whitelist = readAgentModelWhitelist(config);
  const allowed = new Set(whitelist);
  const paidToFree = new Map(readRateLimitPairs(config).map((pair) => [pair.paidId, pair.freeId]));

  // 白名单存在时严格按它筛（与 WorkBuddy 下拉一致）；否则退回“排除非对话模型”。
  // default 不在白名单里，但它是 WorkBuddy 的「快速/均衡/极致」三档自动模式，必须保留。
  let source = config.models.filter((model) => {
    const id = String(model?.id);
    if (allowed.size === 0) return isUsableCatalogModel(model);
    return allowed.has(id) || id === "default";
  });
  // 免费/付费同一模型只保留免费那条。
  source = source.filter((model) => {
    const id = String(model?.id || "");
    const freeId = paidToFree.get(id);
    return !freeId || !allowed.has(freeId);
  });

  const mapped = source.map(mapCatalogModel).filter(Boolean);
  // 还有重名变体时补 id 区分。
  const counts = new Map();
  for (const model of mapped) counts.set(model.name, (counts.get(model.name) || 0) + 1);
  for (const model of mapped) {
    if ((counts.get(model.name) || 0) > 1) model.name = `${model.name} (${model.id})`;
  }
  return mapped;
}

/**
 * 渠道的模型列表：只取 CLI 目录（与服务端下发同步）。
 * 读不到就是空列表，不用内置候选伪装成“模型已可用”。
 */
function resolveChannelModels(home = homedir()) {
  return readCliModelCatalog(home);
}

export function buildLoginProvider(credentials, home = homedir()) {
  const account = slug(credentials.accountId);
  return {
    providerId: account ? `codebuddy-${account}` : "codebuddy-account",
    displayName: account ? `CodeBuddy ${account}` : "CodeBuddy 账号",
    baseUrl: credentials.apiBaseUrl || "https://www.codebuddy.cn",
    apiKey: credentials.token,
    authMode: "bearer",
    endpoint: "codebuddy",
    models: resolveChannelModels(home),
  };
}

/**
 * 首次打开渠道配置时的账号发现：优先环境变量，其次 CLI 自己的登录态。
 * 返回空列表表示「还没登录过」，UI 会显示空态并引导点「登录账号」。
 */
export async function readProviderConfig() {
  const credentials = readEnvCredentials() || readCredentials();
  if (credentials) return { providers: [buildLoginProvider(credentials)] };
  // CLI 2.186 的登录态在桌面端数据目录里（credentials.json 已弃用），
  // 首次打开渠道配置时也要能发现它，否则已登录用户会看到空态。
  const auth = readAuthInfo();
  if (auth) {
    const providerId = auth.uid ? `codebuddy-${slug(auth.uid)}` : "codebuddy-account";
    return { providers: [buildCliSessionProvider(auth.uid, undefined, homedir(), providerId, auth.nickname)] };
  }
  return { providers: [] };
}

export async function activateProvider(provider) {
  const record = provider && typeof provider === "object" ? provider : {};
  const providerId = asString(record.providerId);
  if (!providerId) throw new Error("渠道 ID 为空。");
  if (!asString(record.baseUrl)) throw new Error("请填写渠道 URL（CodeBuddy / WorkBuddy 的服务地址）。");
  // 账号切换靠 backend 每轮注入 CODEBUDDY_AUTH_TOKEN / CODEBUDDY_BASE_URL，
  // 不需要改写 CLI 的原生配置文件，所以这里没有需要回滚的快照。
  return {};
}

function quoteCommand(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** 终端里要执行的命令行：内嵌 lite 包需要带 FORCE_LITE_WB_BUNDLE。 */
export function buildLoginCommandLine(cli, env = process.env) {
  if (cli.bundled) {
    const node = asString(env.CODEBUDDY_NODE_PATH) || process.execPath;
    const prefix = process.platform === "win32"
      ? "set CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 && "
      : "CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 ";
    return `${prefix}${quoteCommand(node)} ${quoteCommand(cli.scriptPath)}`;
  }
  if (/\.(cmd|bat|exe)$/i.test(cli.scriptPath)) return quoteCommand(cli.scriptPath);
  const node = asString(env.CODEBUDDY_NODE_PATH) || process.execPath;
  return `${quoteCommand(node)} ${quoteCommand(cli.scriptPath)}`;
}

/** 在当前桌面上弹出终端窗口并运行 CLI（TUI），失败返回 false。 */
function launchLoginTerminal(cli, extraEnv = {}) {
  const scriptPath = writeLoginScript(cli);
  if (!scriptPath) return false;
  const env = { ...process.env, ...extraEnv };
  try {
    if (process.platform === "win32") {
      const child = spawn(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", "start", "", "cmd.exe", "/k", scriptPath],
        { detached: true, stdio: "ignore", windowsHide: false, env },
      );
      child.unref();
      return true;
    }
    const launch = process.platform === "darwin"
      ? ["osascript", ["-e", `tell application "Terminal" to do script "${scriptPath}"`]]
      : ["x-terminal-emulator", ["-e", scriptPath]];
    const child = spawn(launch[0], launch[1], { detached: true, stdio: "ignore", env });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 登录方式（对应 CLI 首屏菜单的顺序）。 */
export const LOGIN_METHODS = ["chinese", "international", "enterprise", "ioa"];

export function normalizeLoginMethod(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "cn" || normalized === "china" || normalized === "zh") return "chinese";
  return LOGIN_METHODS.includes(normalized) ? normalized : "chinese";
}

/**
 * 定位 `@lydell/node-pty`。插件目录不在项目 node_modules 下，所以要手动找：
 * - dev：从插件目录向上找到项目根 node_modules；
 * - 打包：resources/app/node_modules（asar:false），或 asar 布局下的 app.asar[.unpacked]。
 */
export function loadNodePty() {
  const requireFrom = createRequire(import.meta.url);
  const candidates = [];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    candidates.push(join(dir, "node_modules", "@lydell", "node-pty"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const execDir = dirname(process.execPath);
  // Hpp 桌面端打包用 asar:false，实际目录是 resources/app/node_modules；
  // 另外两种保留给未来改成 asar 打包的情况。
  candidates.push(join(execDir, "resources", "app", "node_modules", "@lydell", "node-pty"));
  candidates.push(join(execDir, "resources", "app.asar.unpacked", "node_modules", "@lydell", "node-pty"));
  candidates.push(join(execDir, "resources", "app.asar", "node_modules", "@lydell", "node-pty"));
  for (const candidate of candidates) {
    try {
      return requireFrom(candidate);
    } catch {
      // 试下一个位置
    }
  }
  try {
    return requireFrom("@lydell/node-pty");
  } catch {
    return null;
  }
}

const stripAnsi = (value) => String(value || "")
  .replace(/\x1b\][^\x07]*\x07/g, "")
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/**
 * 后台 PTY 启动 CLI，自动选登录方式并回车 —— CLI 自己会拉起系统浏览器。
 * 用户全程只看到浏览器，不需要终端窗口。
 * 返回 `{ dispose }`；拿不到 PTY / 启动失败时返回 null（调用方回退到开终端）。
 */
export function startBackgroundLogin(cli, loginMethod = "chinese", onOutput, options = {}) {
  let pty;
  try {
    pty = loadNodePty();
  } catch {
    pty = null;
  }
  if (!pty) return null;

  const scriptPath = writeLoginScript(cli);
  if (!scriptPath) return null;
  const isWindows = process.platform === "win32";

  let child;
  try {
    child = pty.spawn(
      isWindows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh",
      isWindows ? ["/d", "/s", "/c", scriptPath] : [scriptPath],
      {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        // cwd 不能用账号 HOME：CLI 会把 cwd 当项目目录去问「是否信任这个文件夹」。
        cwd: options?.cwd || process.cwd(),
        env: { ...process.env, ...(options?.env || {}) },
      },
    );
  } catch {
    return null;
  }

  const index = Math.max(0, LOGIN_METHODS.indexOf(loginMethod));
  const sendLoginCommand = options?.sendLoginCommand === true;
  let buffer = "";
  let tailText = "";
  let loggedChunks = 0;
  let trustConfirmed = false;
  let submitted = false;
  const submit = () => {
    if (submitted) return;
    submitted = true;
    try {
      for (let i = 0; i < index; i += 1) child.write("\x1b[B");
      child.write("\r");
    } catch {
      // PTY 已退出。
    }
  };
  child.onData((chunk) => {
    const text = stripAnsi(chunk);
    tailText = `${tailText}${text}`.slice(-2000);
    // 只把前几段非空输出落日志，避免 TUI 重绘把日志撑爆。
    if (onOutput && text.trim() && loggedChunks < 40) {
      loggedChunks += 1;
      onOutput(`[pty] ${text.trim().slice(0, 300)}`);
    }
    buffer = `${buffer}${text}`.slice(-4000);
    if (!trustConfirmed && /Do you trust the files/i.test(buffer)) {
      trustConfirmed = true;
      try {
        child.write("\r");
      } catch {
        // PTY 已退出。
      }
      return;
    }
    if (!submitted && /Select login method/i.test(buffer)) submit();
  });
  // 兜底策略：
  //  - 新 HOME 首屏可能先问「是否信任这个文件夹」，先回车确认；
  //  - 登录菜单出现后回车选择登录方式；
  //  - 菜单文案没匹配上（本地化/版本差异）也在 12~16s 后回车一次。
  const timers = [];
  timers.push(setTimeout(submit, sendLoginCommand ? 16_000 : 12_000));

  return {
    tail() {
      return tailText;
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // 已退出
      }
    },
  };
}

function writeLoginScript(cli) {
  return writeTempScript(buildLoginCommandLine(cli), "login");
}

/** 写一份临时脚本（cmd / sh），供 PTY / 系统终端运行。 */
function writeTempScript(commandLine, tag = "login") {
  try {
    if (process.platform === "win32") {
      const scriptPath = join(tmpdir(), `hpp-codebuddy-${tag}-${process.pid}.cmd`);
      writeFileSync(scriptPath, `@echo off\r\n${commandLine}\r\n`, "utf-8");
      return scriptPath;
    }
    const scriptPath = join(tmpdir(), `hpp-codebuddy-${tag}-${process.pid}.sh`);
    writeFileSync(scriptPath, `#!/bin/sh\n${commandLine}\n`, "utf-8");
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  } catch {
    return "";
  }
}

/**
 * 登录一个（新）账号。
 *
 * - 环境变量里已有 token：直接采用；
 * - `force !== true` 且 CLI 已登录：直接返回现有账号；
 * - 否则后台用 PTY 启动 CLI（不弹窗口），自动回车选择登录方式，CLI 自己会拉起
 *   系统浏览器完成 OAuth；同时轮询凭据文件变化。拿不到 PTY 时回退到开终端窗口。
 */
export async function login(context, args = {}) {
  const timeoutMs = Math.min(
    MAX_LOGIN_TIMEOUT_MS,
    Math.max(10_000, Number(args?.timeoutMs) || DEFAULT_LOGIN_TIMEOUT_MS),
  );
  const log = createLoginLogger();
  const envCredentials = readEnvCredentials();
  if (envCredentials) {
    return {
      success: true,
      provider: buildLoginProvider(envCredentials),
      hint: "已使用环境变量 CODEBUDDY_AUTH_TOKEN / CODEBUDDY_API_KEY 中的账号。",
    };
  }

  const cli = resolveCli();
  if (!cli) {
    log.write("[start] CLI not found");
    return {
      success: false,
      error: "未找到 CodeBuddy CLI。请先安装 @tencent-ai/codebuddy-code，或在 WorkBuddy 桌面端登录后重试，也可以用 CODEBUDDY_PATH 指定路径。",
    };
  }

  // 默认行为：把系统里已登录的账号导出成一条独立渠道（秒回，不弹浏览器）。
  // args.newAccount = true 时才进「再登录一个账号」流程（隔离 LOCALAPPDATA）。
  const wantsNewAccount = args?.newAccount === true;
  const force = args?.force === true;
  if (wantsNewAccount && process.platform !== "win32") {
    return {
      success: false,
      error: "当前平台暂不支持隔离登录新账号（账号目录隔离依赖 Windows 的 LOCALAPPDATA）。",
    };
  }

  // 已配置的渠道（仅用于日志）。
  const configuredProviderIds = readConfiguredProviderIds(context);
  // 新账号 / 强制重登都不需要探测主账号，省掉一次模型请求。
  const mainAuthed = !wantsNewAccount && !force ? await probeCliAuth(cli, 20_000) : false;

  if (!wantsNewAccount) {
    const mainAuth = readAuthInfo();
    // 只有探测确认账号仍然有效时才复用；force 用于强制重新登录。
    if (mainAuth && mainAuthed && !force) {
      const providerId = exportCurrentAccount(mainAuth.uid);
      log.write(`[start] reuse main account uid=${mainAuth.uid} nickname=${mainAuth.nickname || "-"} provider=${providerId} mainAuthed=${mainAuthed} configured=${configuredProviderIds.length}`);
      return {
        success: true,
        provider: buildCliSessionProvider(mainAuth.uid, undefined, homedir(), providerId, mainAuth.nickname),
        hint: `已绑定当前账号${mainAuth.nickname ? `（${mainAuth.nickname}）` : ""}，确认后点保存即可使用。`,
      };
    }
  }

  // 新账号：独立 LOCALAPPDATA 下登录，凭据直接落在该目录 → 切渠道即切账号。
  // 非新账号（现有 token 失效 / force）走系统默认目录，刷新主账号登录态。
  const pendingDir = wantsNewAccount ? createPendingAccountDir() : "";
  const accountLogHome = homedir();
  const accountEnvVars = accountEnv(pendingDir);
  const startedAt = Date.now();
  const loginMethod = normalizeLoginMethod(args?.loginMethod);
  log.write(`[start] cli=${cli.scriptPath} bundled=${cli.bundled} method=${loginMethod} dir=${pendingDir || "(system)"} mainAuthed=${mainAuthed} newAccount=${wantsNewAccount}`);

  // 首选：后台 PTY 驱动 CLI（CLI 自己会拉浏览器）；拿不到 PTY 时回退到开终端窗口。
  const session = startBackgroundLogin(cli, loginMethod, (chunk) => log.write(chunk), {
    env: accountEnvVars,
  });
  log.write(`[start] pty=${session ? "on" : "off"}`);
  if (!session) {
    if (!launchLoginTerminal(cli, accountEnvVars)) {
      log.write("[start] terminal fallback failed");
      if (pendingDir) rmSync(pendingDir, { recursive: true, force: true });
      return {
        success: false,
        error: "无法启动登录流程，请手动运行 codebuddy 完成登录。",
      };
    }
  }

  const failCleanup = () => {
    session?.dispose();
    cleanupLoginScript();
    if (pendingDir) {
      // Windows 下 CLI 刚退出时目录句柄可能还占着，删不掉不能影响登录结果。
      try {
        rmSync(pendingDir, { recursive: true, force: true });
      } catch {
        // 忽略，下次登录会新建目录。
      }
    }
  };

  /** 登录成功：把临时目录改名成 codebuddy-<uid>，返回能直接落成渠道的账号。 */
  const finishSuccess = async (userId) => {
    // 先杀 CLI 再改目录：Windows 上进程占着目录时 rename 会 EPERM。
    session?.dispose();
    cleanupLoginScript();
    // 系统账号（pendingDir 为空）登录后凭据就在默认目录；新账号在 pendingDir。
    const info = readAuthInfo(pendingDir || defaultLocalAppData());
    const uid = info?.uid || userId;
    const accountId = slug(uid) ? `codebuddy-${slug(uid)}` : "codebuddy-account";
    let dir = pendingDir;
    let saved = true;
    if (pendingDir && slug(uid)) {
      const target = join(accountsRoot(), accountId);
      saved = false;
      const mergeInto = () => {
        const copied = copyAuthInfoFiles(pendingDir, target);
        if (copied <= 0) return false;
        try {
          rmSync(pendingDir, { recursive: true, force: true });
        } catch {
          // 临时目录删不掉不影响凭据已经写入目标目录。
        }
        return true;
      };

      // 同一账号重新登录时必须用新凭据覆盖旧目录，不能把 pendingDir 删掉。
      for (let attempt = 0; attempt < 4 && !saved; attempt += 1) {
        await sleep(250);
        if (existsSync(target)) {
          saved = mergeInto();
        } else {
          try {
            renameSync(pendingDir, target);
            saved = true;
          } catch {
            // Windows 上 CLI 刚退出时目录句柄可能还占着，稍后复制兜底。
          }
        }
      }
      if (!saved) saved = mergeInto();
      if (saved) dir = target;
    } else if (pendingDir) {
      // 拿不到 uid 时 providerId 和目录名对不上，backend 找不到这套凭据。
      saved = false;
    } else if (slug(uid)) {
      // 刷新的是系统默认账号：如果这个 uid 之前导出过独立渠道目录，
      // 也要同步过去，否则 backend 会继续读目录里的旧 token。
      const target = join(accountsRoot(), accountId);
      if (existsSync(target)) copyAuthInfoFiles(defaultLocalAppData(), target);
    }
    if (!saved) {
      log.write(`[result] credential save failed account=${accountId} uid=${uid || "(unknown)"} dir=${pendingDir || "(system)"}`);
      try {
        rmSync(pendingDir, { recursive: true, force: true });
      } catch {
        // 目录被占用时只能留给下次登录覆盖。
      }
      return {
        success: false,
        error: "登录成功，但保存账号凭据失败，请重试。",
      };
    }
    log.write(`[result] success account=${accountId} uid=${uid || "(unknown)"} nick=${info?.nickname || "-"} dir=${dir || "(system)"}`);
    const provider = buildCliSessionProvider(uid, undefined, homedir(), accountId, info?.nickname);
    return {
      success: true,
      provider,
      hint: `登录成功${info?.nickname ? `（${info.nickname}）` : ""}，已生成渠道草稿，确认后点保存即可使用。`,
    };
  };

  // CLI 自己会打开浏览器；但 CLI 在后台控制台里可能打不开，所以这里从它的日志里
  // 抓到授权 URL 之后，再用 Hpp 主进程的 shell.openExternal 打开一次——浏览器一定能起来。
  let openedUrl = "";
  let probedAt = 0;
  const deadline = startedAt + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(LOGIN_POLL_INTERVAL_MS);

    if (!openedUrl) {
      const authUrl = findRecentAuthUrl(startedAt, Date.now(), accountLogHome);
      if (authUrl) {
        openedUrl = authUrl;
        log.write(`[auth] ${authUrl}`);
        void openInBrowser(context, authUrl).then((opened) => log.write(`[auth] opened=${opened}`));
      }
    }

    // 新版 CLI：浏览器授权成功后只能靠“问 CLI”确认。先用 auth_success（零成本），
    // 40 秒内没命中再用真实探测兜底（每次会发一个极短的模型请求）。
    const now = Date.now();
    const authSuccess = findRecentAuthSuccess(startedAt, now, accountLogHome);
    const shouldProbe = authSuccess || (now - startedAt > 40_000 && now - probedAt >= 8000);
    if (shouldProbe && now - probedAt >= 3000) {
      probedAt = now;
      if (await probeCliAuth(cli, 20_000, accountEnvVars)) {
        log.write(`[result] success via cli probe (authSuccess=${authSuccess})`);
        return await finishSuccess(recentUserId(now, accountLogHome));
      }
    }
  }

  const tail = session?.tail?.() || "";
  log.write(`[result] timeout tail=${tail.slice(-600)}`);
  failCleanup();
  return {
    success: false,
    error: "等待登录超时，请确认浏览器里已经完成 CodeBuddy 账号授权；若已授权，再点一次「登录账号」。",
  };
}

/** 读 hpp settings 里已配置的 codebuddy 渠道 id（判断当前账号是否已经绑过）。 */
export function readConfiguredProviderIds(context) {
  const dataDir = String(context?.dataDir || process.env.HPP_DATA_DIR || "").trim();
  if (!dataDir) return [];
  try {
    const settings = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf-8"));
    const providers = settings?.agentConfigs?.codebuddy?.providers;
    if (!Array.isArray(providers)) return [];
    return providers.map((provider) => String(provider?.providerId || "")).filter(Boolean);
  } catch {
    return [];
  }
}

/** 登录过程日志：$HPP_DATA_DIR/logs/codebuddy-login.log，排查“浏览器没弹”这类问题用。 */
export function createLoginLogger() {
  const dataDir = String(process.env.HPP_DATA_DIR || "").trim();
  if (!dataDir) return { write() {} };
  const file = join(dataDir, "logs", "codebuddy-login.log");
  return {
    write(line) {
      const text = String(line || "").trim();
      if (!text) return;
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${new Date().toISOString()} ${text.slice(0, 4000)}\n`, "utf-8");
      } catch {
        // 日志失败不影响登录。
      }
    },
  };
}

function localDateStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const MAX_LOG_READ_CHARS = 8 * 1024 * 1024;
/** 登录流程每 1.5s 会查一次日志；按文件增量读取，避免反复读整份 8MB。 */
const logTextCache = new Map();

function readLogText(file, maxChars = MAX_LOG_READ_CHARS) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return logTextCache.get(file)?.text || "";
  }
  const cached = logTextCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.text;

  let text = "";
  if (cached && stat.size > cached.size) {
    let fd;
    try {
      fd = openSync(file, "r");
      const length = stat.size - cached.size;
      const buffer = Buffer.alloc(length);
      const bytes = readSync(fd, buffer, 0, length, cached.size);
      text = `${cached.text}${buffer.toString("utf-8", 0, bytes)}`;
    } catch {
      text = cached.text;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* 已关闭 */ }
      }
    }
  } else {
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      text = "";
    }
  }
  if (text.length > maxChars) text = text.slice(-maxChars);
  if (logTextCache.size > 24) logTextCache.clear();
  logTextCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, text });
  return text;
}

/**
 * 从 CLI 自己的日志里找登录期间产生的授权 URL。
 * CLI 打开浏览器时会写：`[CliExternalUriOpener] Opening auth URL: https://...`。
 */
export function findRecentAuthUrl(sinceMs, nowMs = Date.now(), home = homedir()) {
  const dir = join(home, ".codebuddy", "logs", localDateStamp(new Date(nowMs)));
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return "";
  }
  let found = "";
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs < sinceMs) continue;
    } catch {
      continue;
    }
    const text = readLogText(file);
    if (!text) continue;
    const matches = [...text.slice(-300_000).matchAll(/Opening auth URL:\s*(https:\/\/\S+)/g)];
    if (matches.length > 0) found = matches[matches.length - 1][1];
  }
  return found;
}

/** 优先让 Hpp 主进程用系统浏览器打开，失败再回退到平台命令。 */
async function openInBrowser(context, url) {
  try {
    const result = await context?.host?.openExternal?.(url);
    if (result?.success !== false) return true;
  } catch {
    // 主进程不可用时走回退。
  }
  try {
    if (process.platform === "win32") {
      const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "start", "", `"${url}"`], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return true;
    }
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function cleanupLoginScript() {
  const suffixes = process.platform === "win32" ? ["cmd"] : ["sh"];
  for (const suffix of suffixes) {
    for (const tag of ["login", "probe"]) {
      try {
        unlinkSync(join(tmpdir(), `hpp-codebuddy-${tag}-${process.pid}.${suffix}`));
      } catch {
        // 文件不存在就算了。
      }
    }
  }
}

/**
 * 直接问 CLI「现在是否已登录」：跑一次 `-p ping --output-format json`。
 * CodeBuddy 2.186 把登录态存在自己的私有存储里（不是 credentials.json），
 * 没有可读的 token 文件，所以这是唯一可靠的判定方式。
 */
export async function probeCliAuth(cli, timeoutMs = 20_000, extraEnv = {}) {
  const scriptPath = writeTempScript(`${buildLoginCommandLine(cli)} -p ping --output-format json`, "probe");
  if (!scriptPath) return false;
  const isWindows = process.platform === "win32";
  const env = { ...process.env, ...extraEnv };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        isWindows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh",
        isWindows ? ["/d", "/s", "/c", scriptPath] : [scriptPath],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env },
      );
    } catch {
      resolve(false);
      return;
    }
    let output = "";
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已退出
      }
      finish(false);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.on("error", () => finish(false));
    child.on("close", () => {
      try {
        unlinkSync(scriptPath);
      } catch {
        // 忽略
      }
      // 只把明确的认证失败当作未登录；额度/模型错误说明请求已经到达服务端，
      // 账号本身是有效的（否则会把“没额度”误判成“没登录”）。
      const authFailed = /401|Authentication required|Please use \/login|请先登录|未登录|unauthorized/i.test(output);
      finish(!authFailed && output.trim().length > 0);
    });
  });
}

const LOG_TIME_PATTERN = /^\[(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/;

function logLineTimestamp(line) {
  const match = LOG_TIME_PATTERN.exec(line);
  if (!match) return 0;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ).getTime();
}

function readTodayLogs(sinceMs, nowMs = Date.now(), home = homedir()) {
  const dir = join(home, ".codebuddy", "logs", localDateStamp(new Date(nowMs)));
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const texts = [];
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs < sinceMs) continue;
      // 不能只读尾部：`x-user-id` / `auth_success` 可能早已被 TUI 输出挤出最后几百 KB。
      // 日志本身有轮转，这里最多读 8 MB 就够；同一文件复用增量缓存。
      const text = readLogText(file);
      if (text) texts.push(text);
    } catch {
      // 跳过不可读文件
    }
  }
  return texts;
}

/** CLI 在浏览器授权成功时会写 `auth_success`，用它判断“用户刚刚完成登录”。 */
export function findRecentAuthSuccess(sinceMs, nowMs = Date.now(), home = homedir()) {
  for (const text of readTodayLogs(sinceMs, nowMs, home)) {
    for (const line of text.split("\n")) {
      if (!line.includes("auth_success")) continue;
      if (logLineTimestamp(line) >= sinceMs) return true;
    }
  }
  return false;
}

/** 从 CLI 日志里抓最近一次请求头里的 x-user-id，作为账号标识。 */
/** 从 CLI 的 local_storage 里读当前账号 userId（最稳，不依赖日志）。 */
export function readUserIdFromLocalStorage(home = homedir()) {
  const dir = join(home, ".codebuddy", "local_storage");
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return "";
  }
  for (const name of names) {
    if (!name.endsWith(".info")) continue;
    let raw = "";
    try {
      raw = readFileSync(join(dir, name), "utf-8");
    } catch {
      continue;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    if (typeof value === "string" && value.startsWith("H4sI")) {
      try {
        value = JSON.parse(gunzipSync(Buffer.from(value, "base64")).toString("utf-8"));
      } catch {
        continue;
      }
    }
    const userId = Array.isArray(value) ? value[0]?.userId : value?.userId;
    if (typeof userId === "string" && userId.trim()) return userId.trim();
  }
  return "";
}

export function recentUserId(nowMs = Date.now(), home = homedir()) {
  // local_storage 里的 userId 最可靠；日志作为回退。
  const stored = readUserIdFromLocalStorage(home);
  if (stored) return stored;
  let userId = "";
  for (const text of readTodayLogs(nowMs - 24 * 60 * 60 * 1000, nowMs, home)) {
    for (const match of text.matchAll(/"x-user-id"\s*:\s*"([^"]+)"/g)) {
      userId = match[1];
    }
  }
  return userId;
}

/**
 * 用 CLI 已有登录态建一条渠道。
 * 不存 token（拿不到）：backend 不注入 CODEBUDDY_AUTH_TOKEN，直接使用 CLI 的登录账号。
 */
export function buildCliSessionProvider(userId, baseUrl = "https://www.codebuddy.cn", home = homedir(), providerIdOverride = "", nickname = "") {
  const account = slug(userId);
  const providerId = providerIdOverride || (account ? `codebuddy-${account}` : "codebuddy-account");
  const label = nickname ? `CodeBuddy ${nickname}` : account ? `CodeBuddy ${account}` : "CodeBuddy 账号";
  return {
    providerId,
    displayName: label,
    baseUrl,
    apiKey: "",
    authMode: "bearer",
    endpoint: "codebuddy",
    models: resolveChannelModels(home),
  };
}