/**
 * Agent 上游可选内置扩展的启用配置。
 *
 * 这些扩展由agent 自己（pi）实现，宿主不自动加载 —— 加载它们要走 agent CLI 的
 * 启动路径，而 Hpp 是自己构造 SDK 会话。所以只能由用户在设置里显式开启。
 *
 * id 必须与 agent 侧的扩展名一致（pi 用的是 `codemode` / `tool_search`）。
 */
export type AgentBuiltinExtensionId = string;

export type AgentBuiltinExtensionConfig = Record<AgentBuiltinExtensionId, boolean>;

/**
 * 归一化开关集合。
 *
 * 只保留值为 `true` 的 id：后端用 `config[id] === true` 判定，
 * 残留的 false 键会让「配置是否变化」的比较误判，导致热更新被跳过。
 */
export function normalizeAgentBuiltinExtensionConfig(value: unknown): AgentBuiltinExtensionConfig {
  if (!isRecord(value)) return {};
  const config: AgentBuiltinExtensionConfig = {};
  for (const [id, enabled] of Object.entries(value)) {
    if (!id.trim() || enabled !== true) continue;
    config[id] = true;
  }
  return config;
}

/** 把启用 id 列表转成后端配置对象；未知 id 由调用方按插件声明过滤。 */
export function builtinExtensionConfigFromIds(
  enabledIds: readonly string[] | undefined,
  knownIds: readonly string[],
): AgentBuiltinExtensionConfig {
  const enabled = new Set((enabledIds || []).map((id) => String(id)));
  return normalizeAgentBuiltinExtensionConfig(
    Object.fromEntries(knownIds.map((id) => [id, enabled.has(id)])),
  );
}

export function areBuiltinExtensionConfigsEqual(
  left: AgentBuiltinExtensionConfig,
  right: AgentBuiltinExtensionConfig,
): boolean {
  const leftKeys = Object.keys(left).filter((id) => left[id]);
  const rightKeys = Object.keys(right).filter((id) => right[id]);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((id) => right[id] === true);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);