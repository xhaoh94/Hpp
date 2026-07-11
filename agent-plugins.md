# Agent 插件开发指南

Hpp 的 Agent 插件是一个本地目录或 ZIP 包。插件提供一个 manifest 和一个 JavaScript adapter，Hpp 安装后会把它加入 Agent catalog，并按插件声明的能力渲染项目卡片、Agent 设置和配置 UI。

## 插件目录结构

最小插件目录：

```text
my-agent/
  hpp-agent-plugin.json
  agent.mjs
```

ZIP 插件的根目录必须能找到 `hpp-agent-plugin.json` 和 entry 文件。安装时 Hpp 会校验 manifest、entry、插件 ID、ZIP 路径穿越，并复制到：

```text
userData/hpp-data/agent-plugins/<id>
```

## Manifest

manifest 文件固定命名为 `hpp-agent-plugin.json`：

```json
{
  "schemaVersion": 1,
  "id": "my-agent",
  "name": "My Agent",
  "version": "1.0.0",
  "description": "My custom programming agent",
  "entry": "agent.mjs",
  "runtime": "plugin",
  "command": "my-agent",
  "packageName": "optional-npm-package",
  "capabilities": {
    "planMode": "native",
    "guidance": false,
    "fork": false,
    "configuration": "openai-compatible",
    "providerActivation": "none"
  }
}
```

字段说明：

- `schemaVersion`：当前必须为 `1`。
- `id`：插件唯一 ID，只允许字母、数字、`.`、`_`、`:`、`-`。
- `name`：显示名称。
- `version`：插件版本。官方插件更新判断依赖这个字段。
- `description`：插件说明，可选。
- `entry`：相对插件根目录的 JS entry 路径。
- `runtime`：`cli`、`sdk` 或 `plugin`，可选，默认按 `plugin` 处理。
- `command`：底层 CLI 命令名，可选，用于状态检测和安装提示。
- `packageName`：npm 包名，可选，用于版本检测和更新。
- `capabilities`：插件能力声明，可选字段会使用默认值。

## Capabilities

```ts
type AgentCapabilities = {
  planMode: "native" | "prompt" | "none";
  guidance: boolean;
  fork: boolean;
  configuration: "openai-compatible" | "none" | false;
  providerActivation: "single-active" | "none";
};
```

- `planMode`
  - `native`：Agent 原生支持 Plan 模式。
  - `prompt`：Hpp 通过提示词约束模拟 Plan 模式。
  - `none`：不支持 Plan。
- `guidance`：是否支持在运行中追加用户引导。
- `fork`：是否支持原生 fork。即使不支持，Hpp 也可以使用兼容上下文方式创建分叉会话。
- `configuration`：首版支持 `openai-compatible` 表单；不需要配置则用 `none` 或 `false`。
- `providerActivation`
  - `none`：保存配置后按普通多 provider 行为处理。
  - `single-active`：切换模型 provider 前需要激活该 provider，插件必须提供 `configProvider.activateProvider`。

默认能力：

```json
{
  "planMode": "prompt",
  "guidance": false,
  "fork": false,
  "configuration": "none",
  "providerActivation": "none"
}
```

## Entry 导出

entry 文件必须导出 `createAgentBackend(context)`：

```js
export function createAgentBackend(context) {
  return {
    async init(projectPath, existingSessionFilePath) {},
    async sendMessage(message, images, options) {},
    async abort() {},
    async getModels() {
      return [];
    },
    async setModel(provider, modelId) {},
    async setThinkingLevel(level) {},
    sendUIResponse(response) {},
    dispose() {},
    get sessionFilePath() {
      return null;
    }
  };
}
```

可选导出：

```js
export function getStatus(context) {}
export function update(context) {}
export function getDefaultThinkingLevel(context) {}

export const configProvider = {
  async activateProvider(context, { providerId, provider, state }) {}
};
```

## Plugin Context

`createAgentBackend(context)` 收到：

```ts
type PluginAgentContext = {
  agentId: string;
  sessionId: string;
  pluginDir: string;
  dataDir: string;
  appVersion: string;
  host: AgentHostApi;
  sendEvent: (event: Record<string, unknown>) => void;
  getConfigState?: () => Promise<unknown>;
};
```

状态相关导出收到：

```ts
type PluginStatusContext = {
  agentId: string;
  pluginDir?: string;
  dataDir: string;
  appVersion: string;
  host: AgentHostApi;
};
```

`sendEvent` 会自动补上 `sessionId` 和 `agentId`。插件可以用它向 UI 发送流式输出、状态、工具事件、问题请求等 Agent event。

## Backend Contract

必需方法：

- `init(projectPath, existingSessionFilePath)`：初始化或恢复会话。
- `sendMessage(message, images, options)`：发送用户消息。
- `abort()`：中断当前任务。
- `getModels()`：返回模型列表，形如 `{ id, name, provider, reasoning, supportsImages? }`。
- `setModel(provider, modelId)`：切换模型。
- `setThinkingLevel(level)`：设置思考等级。
- `sendUIResponse(response)`：接收 UI 问卷或确认响应。
- `dispose()`：释放进程、连接、临时资源。
- `sessionFilePath`：返回可持久化的会话标识，没有则返回 `null`。

可选方法：

- `sendGuidance(message, images, options)`：运行中追加引导。
- `forkSession(target)`：原生 fork 会话。
- `isIdle()`：返回是否空闲，未提供时按空闲处理。

`forkSession(target)` 会收到：

```ts
type AgentForkTarget = {
  newSessionId: string;
  sourceSessionFilePath?: string;
  sourceUserMessageIndex: number;
  rollbackUserMessageCount?: number;
  targetTurnId?: string;
  sourceMessageContent?: string;
  throughMessageId?: string;
};
```

## 官方 Backend

官方插件在独立插件宿主进程中直接创建内置 backend：

```js
export async function createAgentBackend(context) {
  return context.createBuiltinBackend("codex");
}
```

`createBuiltinBackend` 仅供 Hpp 官方插件使用。真实 backend 和它启动的 CLI/worker 都运行在对应插件宿主进程中，不进入 Electron 主进程。

第三方插件应直接实现并返回自己的 backend。可用 host helper 包括：

- `getCliAgentStatus(descriptor)`
- `updateCliAgent(descriptor)`
- `getPiSDKStatus(pluginDir)`
- `updatePiSDK()`
- `getCodexDefaultThinkingLevel()`
- `writeCodexNativeProviderConfig(args)`，仅用于 Codex 风格 single-active provider 写入。

插件代码和 backend 必须使用可 JSON 序列化的数据与主进程通信。

## 配置与 Provider 激活

如果插件声明：

```json
{
  "configuration": "openai-compatible",
  "providerActivation": "single-active"
}
```

则用户切换模型 provider 时，Hpp 会调用：

```js
export const configProvider = {
  async activateProvider(context, { providerId, provider, state }) {
    // 写入该 agent 的原生配置，并按需返回 snapshots
  }
};
```

如果声明 `single-active` 但没有实现该 hook，激活会失败并显示错误。

## 安装、升级与卸载

本地安装：

- 打开 `Agent 设置`。
- 点 `本地安装`。
- 选择 ZIP 或插件目录。

官方安装/更新：

- 打开 `Agent 设置`。
- 点 `官方插件`。
- Hpp 从 GitHub Release latest 下载 `agent-plugins.json`。
- 未安装插件显示 `安装`；本地版本低于官方版本时显示 `更新`。

卸载：

- 已安装插件在 Agent 设置里显示 `卸载`。
- 如果该 Agent 仍有打开会话，Hpp 会阻止卸载或更新。先关闭相关会话后再操作。

## 官方插件开发与打包

官方插件源码放在：

```text
electron/agent-plugins/<id>
```

每个目录都是一个普通插件目录。运行：

```bash
npm run build
```

会生成：

```text
release/agent-plugins/<id>.zip
release/agent-plugins/agent-plugins.json
```

发布到 GitHub Release 后，Hpp 会通过以下地址读取官方索引：

```text
https://github.com/xhaoh94/Hpp/releases/latest/download/agent-plugins.json
```

ZIP 下载地址使用：

```text
https://github.com/xhaoh94/Hpp/releases/latest/download/<id>.zip
```

## 安全边界

首版本地插件视为受信任 JavaScript，不做沙箱隔离。插件 entry 会在主进程环境中执行。安装前应确认插件来源可信。

插件依赖需要随插件目录自带，或依赖宿主提供的 host API。Hpp 首版不会为外部插件自动执行 `npm install`。
