import { activateProvider, claimDailyCredit, login, readProviderConfig } from "./config.mjs";

export async function createAgentBackend(context) {
  return context.createBuiltinBackend("codebuddy");
}

export function getStatus(context) {
  return context.host.getCliAgentStatus({
    id: context.agentId,
    name: "CodeBuddy",
    source: "plugin",
    removable: true,
    command: "codebuddy",
    packageName: "@tencent-ai/codebuddy-code",
    installedPath: context.pluginDir,
  });
}

export function update(context, options = {}) {
  return context.host.updateCliAgent({
    id: context.agentId,
    name: "CodeBuddy",
    source: "plugin",
    removable: true,
    command: "codebuddy",
    packageName: "@tencent-ai/codebuddy-code",
    installedPath: context.pluginDir,
  }, options.versionSpec);
}

/** CLI 的 --effort 档位；Hpp 侧默认 medium。 */
export function getDefaultThinkingLevel() {
  return "medium";
}

export const configProvider = {
  read() {
    return readProviderConfig();
  },
  activateProvider(_context, { provider }) {
    return activateProvider(provider);
  },
  /**
   * 登录一个 CodeBuddy / WorkBuddy 账号。
   *
   * CLI 没有非交互登录命令（--help 里没有 login 子命令），登录只能在 TUI 里
   * 用 /login 完成。所以这里打开一个终端窗口让用户完成 OAuth，然后轮询
   * LOCALAPPDATA 下的 auth 文件（或 CLI 探测）确认登录，把新账号落成渠道。
   * 已有 CODEBUDDY_AUTH_TOKEN / CODEBUDDY_API_KEY 时直接采用环境变量。
   */
  login(context, args = {}) {
    return login(context, args);
  },
  /** 每日签到领积分（按渠道账号）。 */
  claimDailyCredit(_context, args = {}) {
    return claimDailyCredit(args?.providerId || "");
  },
  lookupModel() {
    return undefined;
  },
};