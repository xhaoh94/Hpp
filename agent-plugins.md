# Agent 插件开发指南

Hpp Agent 插件是一个本地目录或 ZIP。插件由 manifest、JavaScript entry 和可选的其它模块组成。Hpp 核心不识别具体 Agent ID，所有 Agent 专属行为都应由插件声明或实现。

## 目录结构

最小插件：

```text
my-agent/
  hpp-agent-plugin.json
  agent.mjs
```

包含原生 Provider 配置适配器的插件：

```text
my-agent/
  hpp-agent-plugin.json
  agent.mjs
  config.mjs
```

ZIP 根目录必须包含 manifest 和 entry。安装后插件位于：

```text
userData/hpp-data/agent-plugins/<id>
```

CLI Agent 使用系统全局安装，Hpp 内更新等同执行插件声明的全局 npm 更新命令。用户在 Hpp 外更新 CLI 后，重新检查版本即可同步；Codex 显式配置的 `CODEX_PATH` 优先级最高，否则从系统 `PATH` 查找。

## Manifest

```json
{
  "schemaVersion": 3,
  "id": "my-agent",
  "name": "My Agent",
  "version": "1.0.0",
  "minHppVersion": "0.0.1",
  "description": "My programming agent",
  "entry": "agent.mjs",
  "runtime": "cli",
  "command": "my-agent",
  "packageName": "my-agent-package",
  "order": 100,
  "installHint": "npm install -g my-agent-package",
  "updateCommand": "npm install -g my-agent-package@latest",
  "shortName": "MA",
  "capabilities": {
    "planMode": "native",
    "guidance": false,
    "fork": false,
    "configuration": "none",
    "providerActivation": "none"
  }
}
```

基础字段：

- `schemaVersion`：新安装包当前必须为 `3`。schema 3 强制声明最低 Hpp 版本；已安装的 schema 2 插件仍可加载，避免升级 Hpp 后丢失现有插件。
- `id`：插件唯一 ID，只允许字母、数字、点、下划线、冒号和短横线。
- `name`、`description`：UI 展示信息。
- `version`：插件版本，用于更新判断。
- `minHppVersion`：运行插件所需的最低 Hpp 版本。安装本地 ZIP、目录或官方插件时都会在主进程强制校验。
- `entry`：相对插件根目录的 ESM entry。
- `runtime`：`cli`、`sdk` 或 `plugin`。
- `command`、`packageName`：可选的 CLI 状态检测和 npm 更新信息。
- `order`：默认展示顺序，数值越小越靠前；用户自定义排序仍优先。
- `installHint`、`updateCommand`、`shortName`：由插件提供的 UI 元数据。

## 通用能力

```ts
type AgentCapabilities = {
  planMode: "native" | "prompt" | "none";
  guidance: boolean;
  fork: boolean;
  configuration: AgentProviderConfiguration | "none";
  providerActivation: "single-active" | "none";
};
```

- `planMode: native`：backend 原生处理 Plan 模式。
- `planMode: prompt`：Hpp 在消息中追加通用 Plan 约束。
- `guidance`：backend 是否实现运行中引导。
- `fork`：backend 是否实现原生同步分叉；未声明时使用上下文兼容分叉。
- `providerActivation: single-active`：切换渠道前调用插件 `configProvider.activateProvider`。

## Provider 配置声明

需要渠道配置弹窗时，将 `configuration` 声明为对象：

```json
{
  "configuration": {
    "type": "provider",
    "storage": "plugin",
    "endpoints": [
      { "id": "chat-completions", "label": "Chat Completions (/chat/completions)" },
      { "id": "responses", "label": "Responses (/responses)" },
      { "id": "anthropic-messages", "label": "Anthropic Messages (/v1/messages)" },
      { "id": "gemini", "label": "Gemini generateContent" }
    ],
    "defaultEndpoint": "gemini",
    "pathLabel": "~/.my-agent/settings.json",
    "hint": "渠道由插件写入原生配置。",
    "modelDefaults": {
      "reasoning": false,
      "imageInput": true
    },
    "fixedModelCapabilities": false,
    "modelListMode": "merge",
    "backendModelVisibility": {
      "userConfigurable": true,
      "defaultVisible": false,
      "label": "显示 Agent 官方模型",
      "description": "关闭后只显示渠道配置中的自定义模型。"
    }
  }
}
```

字段说明：

- `storage: hpp`：渠道列表保存在 Hpp `settings.json`。插件可提供 `configProvider.read`，用于首次发现已有原生配置。
- `storage: plugin`：插件拥有配置存储，必须实现 `configProvider.read` 和 `configProvider.write`。
- `endpoints`：插件支持的 Endpoint ID 和标签。ID 可以是插件自定义协议，不需要 Hpp 预先认识。
- `defaultEndpoint`：新增渠道默认选择。
- `pathLabel`、`hint`：配置弹窗展示文本。
- `modelDefaults`：新增或远程获取模型时的默认能力。
- `fixedModelCapabilities`：为 `true` 时，模型能力固定为 `modelDefaults`。
- `modelListMode`：`configured`、`backend` 或 `merge`。
- `backendModelVisibility`：仅用于 `merge`。插件可声明一个通用开关，让用户决定是否把 backend/官方模型合并进渠道配置模型。Hpp 按 Agent 保存偏好，不需要按插件 ID 硬编码。
- `backendModelVisibility.defaultVisible`：未保存过偏好时是否显示 backend 模型。
- `backendModelVisibility.label`、`description`：配置弹窗中的开关文本和悬停说明。

`modelListMode` 行为：

- `configured`：展示渠道配置中的模型；`single-active` 插件只展示当前启用渠道。尚未配置模型时回退到 backend 的 `getModels()`，保证原生登录模式仍可选择模型。
- `backend`：只使用 backend 的 `getModels()` 结果。
- `merge`：按 `provider:id` 合并 backend 与渠道配置模型。

当 `backendModelVisibility.userConfigurable` 为 `true` 时，配置弹窗顶部会显示插件提供的开关。修改只刷新模型列表，不重载 Agent 会话。

## Entry 导出

插件必须导出：

```js
export function createAgentBackend(context) {
  return {
    async init(projectPath, existingSessionFilePath) {},
    async sendMessage(message, images, options) {},
    async abort() {},
    async getModels() { return []; },
    async setModel(provider, modelId) {},
    async setThinkingLevel(level) {},
    sendUIResponse(response) {},
    dispose() {},
    get sessionFilePath() { return null; }
  };
}
```

可选导出：

```js
export function getStatus(context) {}
export function update(context) {}
export function uninstall(context) {}
export function getDefaultThinkingLevel(context) {}
```

可选 backend 方法：

- `sendGuidance(message, images, options)`
- `forkSession(target)`
- `isIdle()`

manifest 中声明的 `guidance` 和 `fork` 应与 backend 实现一致。

## configProvider

```js
export const configProvider = {
  async read(context) {
    return { activeProviderId: undefined, providers: [] };
  },

  async write(context, { state }) {
    return { snapshots: [] };
  },

  async activateProvider(context, { providerId, provider, state }) {
    return { snapshots: [] };
  }
};
```

- `read`：读取插件原生配置，返回统一 `AgentConfigState`。
- `write`：将完整渠道状态写回原生配置。
- `activateProvider`：激活 single-active 渠道，例如写入当前 Provider、模型和认证信息。
- `snapshots`：写入前的文件快照。激活后如果会话重载失败，Hpp 会恢复快照。

统一配置结构：

```ts
type AgentConfigState = {
  activeProviderId?: string;
  providers: Array<{
    providerId: string;
    displayName: string;
    baseUrl: string;
    apiKey: string;
    endpoint: string;
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      imageInput: boolean;
    }>;
  }>;
};
```

快照结构：

```ts
type FileSnapshot = {
  filePath: string;
  existed: boolean;
  content: string;
};
```

## Plugin Context

```ts
type PluginAgentContext = {
  agentId: string;
  sessionId: string;
  pluginDir: string;
  dataDir: string;
  appVersion: string;
  host: AgentHostApi;
  sendEvent: (event: Record<string, unknown>) => void;
  getConfigState: () => Promise<AgentConfigState>;
  createBuiltinBackend: (name: string) => Promise<AgentBackend>;
};
```

`sendEvent` 会自动补充 `agentId` 和 `sessionId`。插件应向 Hpp 发送通用事件，例如 `stream_delta`、`process_event`、`ask_user`，不要要求 UI 识别插件专属事件名。

原生协议 backend 应优先使用 Agent 初始化或会话加载响应中的模型与历史数据，不要维护容易过期的内置模型表。恢复历史时发送 `history_snapshot`；手动中断完成后发送 `aborted`，进程异常退出时发送 `agent_disconnected`。

`dispose()` 可以返回 Promise。backend 启动了 worker、CLI 或服务进程时，应在 Promise 完成前关闭对应进程及其子进程；插件宿主会在重载、卸载和应用退出时等待所有 backend 完成清理。

`getConfigState()` 返回当前插件的统一渠道状态。第三方插件可以直接读取并转换为 CLI 环境变量、启动参数或 SDK 配置。

`createBuiltinBackend()` 仅供随 Hpp 构建的官方插件使用。第三方插件应实现自己的 backend。

## 运行模型

- 每个已加载 Agent 插件对应一个独立插件宿主进程。
- 同一插件的多个会话 backend 运行在该插件宿主进程内。
- 插件崩溃不会直接终止 Electron 主进程，但会影响该插件内的会话。
- 插件宿主异常退出时，Hpp 会向该插件的全部会话发送 `agent_disconnected`，不会为旧 backend 静默创建空宿主。
- 应用退出、插件重载或卸载时，Hpp 会先等待 backend 清理，再关闭插件宿主；超时后才强制结束进程树。
- 插件更新或卸载前，Hpp 会阻止仍有活动会话的操作。

## 安装与打包

本地安装支持 ZIP 和插件目录。官方插件放在：

```text
electron/agent-plugins/<id>
```

运行：

```bash
npm run build
```

生成：

```text
release/v<version>/agent-plugins/<id>.zip
release/v<version>/agent-plugins/agent-plugins.json
```

插件目录、官方目录顺序和发布 ZIP 均由 manifest 与目录扫描生成，不维护固定 Agent ID 列表。

官方 `agent-plugins.json` 使用 schema 2，并包含每个插件的 `minHppVersion`。Hpp 只有在插件版本更高且当前应用满足最低版本时才显示“可更新”；不兼容版本会显示“需要 Hpp vX+”并禁用安装。旧 Hpp 只识别目录 schema 1，因此读取新目录时会失败关闭，不会下载不兼容插件。

## 安全边界

插件是受信任的本机程序。插件宿主进程提供崩溃隔离，但不是系统权限沙箱。插件拥有完整 Node.js 权限，可以读取环境变量和文件、访问网络、修改本机内容或执行命令。

安装本地插件 ZIP 等同于运行本机程序，只应安装可信来源的插件。Hpp 不会自动为第三方插件执行 `npm install`。
