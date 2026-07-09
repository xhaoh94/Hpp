# Hpp

Hpp 是一个基于 Electron、React 和 TypeScript 的本地 Agent 项目管理器。它把多个编程 Agent 统一放进同一个桌面应用里，按项目组织会话，支持插件化安装、模型配置、Plan 模式、运行中引导和会话 fork。

## 功能概览

- 项目卡片：为每个本地项目管理多个 Agent 会话。
- 多 Agent 插件：通过安装插件添加 Codex、Pi、OpenCode、Droid 或第三方 Agent。
- 插件安装：支持本地 ZIP、插件目录，以及官方插件列表一键安装/更新。
- 会话管理：支持打开、关闭、恢复历史会话，并保留会话消息。
- 模型与 Provider 配置：支持 OpenAI-compatible provider 表单和 per-agent 模型列表。
- Agent 能力：插件可声明 Plan、guidance、fork、configuration、providerActivation 等能力。
- 官方插件包：构建后输出到 `release/agent-plugins`，可直接用于安装测试或发布。

## 快速开始

```bash
npm install
npm run dev
```

常用脚本：

```bash
npm test
npm run build
npm run dist
```

- `npm run dev`：启动 Electron 开发环境。
- `npm test`：运行 Vitest 测试。
- `npm run build`：构建主进程、预加载脚本、渲染端，并打包官方 Agent 插件。
- `npm run dist`：构建并生成安装包。

## Agent 插件使用

Hpp 不再默认内置安装 Agent。Agent 通过插件目录或 ZIP 安装。

在应用中打开 `Agent 设置`：

- 点 `本地安装`，选择插件 ZIP 或已解压的插件目录。
- 点 `官方插件`，从 GitHub Release 的官方插件列表下载并安装。
- 已安装插件可在 Agent 设置中启用、排序、刷新状态、更新或卸载。

如果某个 Agent 仍有打开的会话，Hpp 会阻止更新或卸载该插件。先关闭相关会话后再操作。

## 官方插件包

官方插件源码位于：

```text
electron/agent-plugins/
```

运行构建后会生成：

```text
release/agent-plugins/codex.zip
release/agent-plugins/pi.zip
release/agent-plugins/opencode.zip
release/agent-plugins/droid.zip
release/agent-plugins/agent-plugins.json
```

`agent-plugins.json` 是官方插件索引，发布到 GitHub Release 后，Hpp 的官方插件弹窗会从 latest release 下载并展示。

## 项目结构

```text
src/                     Renderer UI、状态管理和前端类型
electron/                Electron 主进程、IPC、Agent backend 适配
electron/agent-plugins/  官方 Agent 插件源码
scripts/                 构建辅助脚本，例如官方插件打包
release/                 构建产物和发布产物
```

## 插件开发

开发第三方 Agent 插件请参考 [agent-plugins.md](./agent-plugins.md)。

## 安全说明

首版插件按受信任本地代码处理，插件 entry 会在主进程环境中执行 JavaScript。只安装你信任来源的插件。插件依赖需要随插件目录提供，Hpp 不会自动执行 `npm install`。
