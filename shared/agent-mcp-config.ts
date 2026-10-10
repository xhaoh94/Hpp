/**
 * MCP 服务器配置（`mcp.json`）的读写与校验。
 *
 * 为什么不直接用 pi 的 API：`loadMcpConfig` / `addMcpServerConfig` /
 * `updateMcpServerConfig` / `removeMcpServerConfig` 全都只在
 * `dist/extensions/mcp/config.js` 里，**包根一个都没导出**（1.1.0 实测，
 * bundle 里也 grep 不到）。所以宿主自己按pi 的格式读写。
 *
 * 文件位置与 pi 一致（`dist/extensions/mcp/config.js:105`）：
 * - 全局：`<agentDir>/mcp.json`
 * - 项目：`<projectPath>/.pi/mcp.json`，仅在 projectTrusted 时读取。
 *   SettingsManager 构造时 `projectTrusted` 默认 **true**，所以 Hpp 不必额外开。
 *
 * 校验规则照抄 `validateMcpServerConfig`（`dist/core/mcp-servers.js:141`），
 * 保持与 pi 的报错口径一致 —— 不一致的校验会让 UI 显示"已保存"但 pi 拒绝加载。
 */
import type { McpServerConfig, McpServerEntry, McpConfigScope } from "../src/types/ipc";

/** pi 的 `MCP_EXPOSURES`（`core/mcp-servers.js:37`）。 */
export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;

export type McpExposure = (typeof MCP_EXPOSURES)[number];

/**
 * pi 的 `MCP_EXPOSURE_ALIASES`：旧曝光名在校验前先归一，不是错误
 * （`core/mcp-servers.js` 的 `resolveExposureAliases`）。不认它会让一条老写法
 * 把整个表单卡死 —— 弹窗的保存是「任一错误就不落盘」。
 */
const MCP_EXPOSURE_ALIASES = new Map<string, McpExposure>([["codemode-deferred", "codemode"]]);

/**
 * 一个 server 没写 exposure 时 pi 用的档位。
 *
 * 是 `codemode` 不是 `direct`：`getMcpToolExposure` / `exposureOf` 都收在
 * `config.exposure ?? "codemode"`（`core/mcp-servers.js:135`、`extensions/mcp/index.js:60`）。
 * session 层的 `_getToolExposure(name) ?? "direct"` 读的是**工具定义**的兜底，原生工具
 * 才走那条，MCP 工具注册时拿到的永远是上面那个具体值。
 */
export const DEFAULT_MCP_EXPOSURE: McpExposure = "codemode";

/** 归一旧曝光名；其他值原样返回。 */
export function resolveExposureAlias(value: unknown): unknown {
  return typeof value === "string" ? (MCP_EXPOSURE_ALIASES.get(value) ?? value) : value;
}

const isMcpExposure = (value: unknown): value is McpExposure =>
  typeof value === "string" && (MCP_EXPOSURES as readonly string[]).includes(value);

/** 校验用的错误文案，三个分支共用。 */
const exposureHint = () => MCP_EXPOSURES.map((e) => `"${e}"`).join("、");

/** pi 的 `SERVER_NAME`（`core/mcp-servers.js:48`）。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 项目级配置里唯一允许出现的键（其余全局的保留，`config.js:41`）。 */
export const MCP_OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isStringRecord = (value: unknown): boolean =>
  isRecord(value) && Object.values(value).every((item) => typeof item === "string");

/**
 * 一条项目级配置是"覆盖"还是"新定义"。
 * 只有 enabled/exposure/toolExposure 而没有连接信息，就是覆盖全局的同名 server。
 */
export function isOverrideEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.command === undefined && value.url === undefined && value.type === undefined;
}

/**
 * 校验一个 server 条目。返回错误文案，合法时返回 null。
 *
 * 判定顺序与 pi 一致（先名字、再 exposure、最后按传输方式分支），这样 UI 报出的
 * 第一条错误和 pi 拒绝加载的原因吻合，不会出现"界面说没问题、pi 报错"。
 */
export function validateMcpServerEntry(
  name: string,
  raw: unknown,
  scope: McpConfigScope = "global",
): string | null {
  if (!SERVER_NAME_PATTERN.test(name)) {
    return `server 名"${name}" 非法（只能用字母、数字、"_" 和 "-"）`;
  }
  if (!isRecord(raw)) return `server "${name}" 必须是一个对象`;

  // 项目级的覆盖条目：只允许三个开关字段，且必须存在同名全局 server。
  // 全局是否存在由调用方校验（需要跨文件信息），这里只管字段本身。
  if (scope === "project" && isOverrideEntry(raw)) {
    const extra = Object.keys(raw).filter(
      (key) => !(MCP_OVERRIDE_KEYS as readonly string[]).includes(key),
    );
    if (extra.length > 0) {
      return `server "${name}" 的覆盖条目只能设置 ${MCP_OVERRIDE_KEYS.join("、")}`;
    }
    if (raw.exposure !== undefined && !isMcpExposure(resolveExposureAlias(raw.exposure))) {
      return `server "${name}" 的 exposure 必须是 ${exposureHint()} 之一`;
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      return `server "${name}" 的 enabled 必须是布尔值`;
    }
    if (raw.toolExposure !== undefined) {
      if (!isRecord(raw.toolExposure)) {
        return `server "${name}" 的 toolExposure 必须是「工具名 -> exposure」的对象`;
      }
      for (const [tool, value] of Object.entries(raw.toolExposure)) {
        if (!isMcpExposure(resolveExposureAlias(value))) {
          return `server "${name}" 的 toolExposure["${tool}"] 必须是 ${exposureHint()} 之一`;
        }
      }
    }
    return null;
  }

  const { type, exposure, enabled, timeout, toolExposure, description } = raw;

  if (exposure !== undefined && !isMcpExposure(resolveExposureAlias(exposure))) {
    return `server "${name}" 的 exposure 必须是 ${exposureHint()} 之一`;
  }
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) {
      return `server "${name}" 的 toolExposure 必须是「工具名 -> exposure」的对象`;
    }
    for (const [tool, value] of Object.entries(toolExposure)) {
      if (!isMcpExposure(resolveExposureAlias(value))) {
        return `server "${name}" 的 toolExposure["${tool}"] 必须是 ${exposureHint()} 之一`;
      }
    }
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return `server "${name}" 的 enabled 必须是布尔值`;
  }
  if (description !== undefined && typeof description !== "string") {
    return `server "${name}" 的 description 必须是字符串`;
  }
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
    return `server "${name}" 的 timeout 必须是大于 0 的秒数`;
  }
  if (type === "sse") {
    return `server "${name}": 不再支持旧的 SSE 传输，请改用 streamable HTTP URL`;
  }

  // HTTP 分支：有 url，且 type 缺省或为 http/streamable-http。
  if (typeof raw.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(raw.url);
    } catch {
      parsed = undefined;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      return `server "${name}" 的 url 必须是 http 或 https URL`;
    }
    if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
      return `server "${name}" 的 headers 必须是「名称 -> 字符串」的对象`;
    }
    if (raw.auth !== undefined) {
      if (!isRecord(raw.auth) || typeof raw.auth.provider !== "string" || !raw.auth.provider) {
        return `server "${name}" 的 auth.provider 必须是 provider 名称`;
      }
      const loopback = ["localhost", "127.0.0.1", "[::1]"];
      if (parsed.protocol !== "https:" && !loopback.includes(parsed.hostname)) {
        return `server "${name}" 的 auth 需要 https URL，或 localhost / 127.0.0.1 / [::1] 上的 http`;
      }
    }
    // pi 不允许项目级 http server 自带 auth（防止仓库决定凭据去向，config.js:92）。
    if (scope === "project" && raw.auth !== undefined) {
      return `server "${name}": auth 只能配在全局 mcp.json里`;
    }
    return null;
  }

  // stdio 分支：有 command，且 type 缺省或为 stdio。
  if (typeof raw.command === "string" && (type === undefined || type === "stdio")) {
    if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string"))) {
      return `server "${name}" 的 args 必须是字符串数组`;
    }
    if (raw.env !== undefined && !isStringRecord(raw.env)) {
      return `server "${name}" 的 env 必须是「名称 -> 字符串」的对象`;
    }
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
      return `server "${name}" 的 cwd 必须是字符串`;
    }
    return null;
  }

  return `server "${name}" 需要 command（stdio）或 url（http）`;
}

/**
 * 校验整份 mcp.json 解析出来的结构。
 * 项目级还要额外校验覆盖条目是否真有同名全局 server（pi 的报错原文，
 * `config.js:74`）：「needs "command" or "url", or a global server to override」。
 */
export function validateMcpServers(
  raw: unknown,
  scope: McpConfigScope,
  globalServerNames?: readonly string[],
  options: { reportOverrideMissing?: boolean } = {},
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!isRecord(raw)) return ["mcp.json 的顶层必须是一个对象"];
  const servers = raw.mcpServers;
  if (servers !== undefined && !isRecord(servers)) {
    return ['mcp.json 需要一个 "mcpServers" 对象'];
  }
  const errors: string[] = [];
  const globalNames = new Set(globalServerNames || []);
  for (const [name, value] of Object.entries((servers as Record<string, unknown>) || {})) {
    if (scope === "project" && isOverrideEntry(value) && !globalNames.has(name)) {
      // 条目上的 overrideMissing 已经标了同一件事，调用方要求时不再重复报。
      if (options.reportOverrideMissing !== false) {
        errors.push(`server "${name}" 需要 command 或 url，或者有一个同名全局 server 可以被覆盖`);
      }
      // pi 在这里也是直接 continue：缺基项的覆盖条目不做字段校验
      // （`extensions/mcp/config.js` 的 if/else-if 链），保持同口径。
      continue;
    }
    const error = validateMcpServerEntry(name, value, scope);
    if (error) errors.push(error);
  }
  // 名字只差 - 与 _ 的server 会共用命名空间（config.js:85），必须报错。
  const seen = new Map<string, string>();
  for (const name of Object.keys((servers as Record<string, unknown>) || {})) {
    const namespace = name.replace(/-/g, "_");
    const previous = seen.get(namespace);
    if (previous && previous !== name) {
      errors.push(`server "${name}" 与 "${previous}" 冲突（名字只差 - 和 _ 会共用命名空间）`);
    }
    seen.set(namespace, name);
  }
  return errors;
}

/** 从解析结果里取出 server 列表，并标注每条的来源与是否为覆盖条目。 */
export function readMcpServerEntries(
  parsed: unknown,
  scope: McpConfigScope,
  globalServerNames: readonly string[] = [],
): McpServerEntry[] {
  if (!isRecord(parsed)) return [];
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  const globalNames = new Set(globalServerNames);
  return Object.entries(servers).map(([name, value]) => ({
    name,
    config: (isRecord(value) ? value : {}) as McpServerConfig,
    scope,
    isOverride: scope === "project" && isOverrideEntry(value),
    // 覆盖条目依赖同名全局 server；没有的话这条配置是死的。
    overrideMissing: scope === "project" && isOverrideEntry(value) && !globalNames.has(name),
  }));
}

/**
 * 一条 server 的**生效 exposure**：自己的值优先，覆盖条目缺省时继承全局同名 server。
 * 两边都缺省时是 `codemode`（见 `DEFAULT_MCP_EXPOSURE`），不是 `direct`。
 *
 * 覆盖条目只含 enabled/exposure/toolExposure，exposure 常常是 undefined ——
 * 此时真正生效的是全局那个值。所以判断"有没有 server 走 codemode"不能只看条目的
 * 自己的 exposure，必须先合并。
 *
 * @param globalServers 全局作用域的条目列表，仅在 scope === "project" 时需要。
 */
export function resolveEffectiveExposure(
  entry: Pick<McpServerEntry, "name" | "config" | "isOverride">,
  globalServers: readonly Pick<McpServerEntry, "name" | "config">[] = [],
): McpExposure {
  const own = resolveExposureAlias(entry.config.exposure);
  if (isMcpExposure(own)) return own;
  if (!entry.isOverride) return DEFAULT_MCP_EXPOSURE;
  const base = globalServers.find((item) => item.name === entry.name);
  const inherited = resolveExposureAlias(base?.config.exposure);
  return isMcpExposure(inherited) ? inherited : DEFAULT_MCP_EXPOSURE;
}

/** 某个 server 是否被禁用。覆盖条目也可能是 `enabled: false`（项目里关掉全局 server）。 */
export function isServerEnabled(entry: Pick<McpServerEntry, "config" | "isOverride">): boolean {
  return entry.config.enabled !== false;
}
