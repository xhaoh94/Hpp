# Hpp

Android 和 Web 远程访问说明见 [docs/android-remote.md](./docs/android-remote.md)。

Hpp 是一个基于 Electron、React 和 TypeScript 的本地 Agent 项目管理器。它通过 Agent 插件统一管理不同编程 Agent，并按项目组织会话、模型、历史记录、分叉和运行状态。

## 功能

- 项目与多会话管理，支持历史恢复、会话引用和分叉。
- Agent 插件安装、更新、排序、卸载和状态检测。
- 命令行 Agent 使用系统全局安装；在终端更新后，Hpp 重新检查即可同步版本。
- 每个 Agent 插件运行在独立的插件宿主进程中，同一插件可管理多个会话后端。
- 应用退出或插件重载时会等待后端清理工作进程和命令行子进程，超时后结束对应进程树。
- 插件通过清单文件声明 Plan、guidance、fork、Provider 配置和模型列表策略。
- Provider 配置支持插件自定义 Endpoint 列表、默认模型能力和原生配置存储方式。
- 官方插件构建后输出独立 ZIP 文件和插件目录索引。
- 插件清单声明最低 Hpp 版本，官方更新、本地 ZIP 和目录安装都会在主进程中校验兼容性。
- 聊天框提供“请求权限、自动权限、完全访问权限”三档通用策略，并将所选档位固化到每条消息和队列项。
- 内置编辑器桥接：VSCode 系扩展、Zed 任务和通用 CLI 可以把选区、文件或文件夹直接送进当前会话的输入框。
- 提供子 Agent 运行监视、本轮产物清单、HTML/SVG 预览和粘贴文本折叠。
- 会话可选独立 Git worktree，支持并行任务隔离、检查点和合并回主工作区。
- 内置独立 Git 工作台弹窗：查看状态、暂存/取消暂存、diff、提交和 stash。

## 独立 Git 工作区

点击项目卡片里的 Agent 后，会弹出新建会话窗口；在其中勾选「在独立 Git worktree 中运行」，Hpp 会为这个会话创建一个独立的 Git worktree，Agent 的 cwd、文件树和 diff 都指向该工作区。默认工作区不显示这个选项；普通项目要求主工作区干净，否则会拒绝创建，避免 Agent 看不到你未提交的改动。

- worktree 默认放在 Hpp 数据目录的 `worktrees/` 下，分支名为 `hpp/<session-id>`；
- 会话头部的工作区徽章可以复制路径、创建检查点或合并回主工作区；
- 合并要求主工作区干净，使用 `git merge --no-ff`；发生冲突时保留冲突状态，可在 Git 工作台解决或中止；
- 合并后 worktree 不会自动删除，可用 `git worktree remove` 清理；
- 独立工作区目前不支持 fork，避免两个会话同时写同一个目录。


## Git 工作台

项目卡片右上角的 Git 图标会打开独立的 Git 工作台弹窗，不占用右侧窄栏。当前支持：

- 当前分支、upstream、ahead/behind 和工作区状态；
- 已暂存 / 未暂存 / 未跟踪文件；
- 文件级和 hunk 级暂存、取消暂存；文件级和 hunk 级丢弃（丢弃前确认）；
- diff 查看；
- 提交已暂存改动，支持 amend；
- 创建、列出和恢复 stash；
- 提交历史、提交详情；
- 本地分支列表、创建、切换、合并、删除和发起 rebase；
- worktree 列表和安全删除；
- fetch / pull --ff-only / push；
- 文件级冲突解决：使用当前版本、对方版本、打开文件、标记已解决，以及继续/中止 merge、rebase、cherry-pick、revert。

创建独立 worktree 时，如果主工作区有未提交改动，新建会话弹窗会提供「打开 Git 工作台」入口；提交或 stash 后关闭弹窗，Hpp 会自动重新检测，worktree 勾选随即可用。

pull 只执行 `--ff-only`，不会自动创建 merge commit；push 使用系统 Git 凭据助手，不把 token 存进 Hpp。PR 和 interactive rebase 仍未包含；冲突解决是文件级操作，不提供 inline 三方合并编辑器。


## 开发

```bash
npm install
npm run dev
```

常用命令：

```bash
npm test
npm run build
npm run dist
```

- `npm test`：运行 Vitest 测试。
- `npm run editors:build`：把 `editors/vscode/` 打包成 `resources/editors/hpp-bridge.vsix`。
- `npm run build`：构建桌面端和移动端 Web 资源，打包官方 Agent 插件和编辑器扩展。
- `npm run dist`：生成桌面安装包。
- `npm run dist:linux`：在 Linux 上生成 AppImage。

## 编辑器集成

Hpp 启动后在本机回环地址提供桥接服务，默认监听 `127.0.0.1:47832`；端口被占用时会自动换用系统分配的端口。端口和一次性令牌写在：

```text
<userData>/hpp-data/editor-bridge.json
```

默认位置：

- Windows `%APPDATA%\hpp\hpp-data\editor-bridge.json`
- macOS `~/Library/Application Support/hpp/hpp-data/editor-bridge.json`
- Linux `$XDG_CONFIG_HOME/hpp/hpp-data/editor-bridge.json`（默认 `~/.config`）

客户端读取这个文件后直接 POST 到回环地址，因此 **Hpp 必须先启动**；端口变化不需要改配置。桥接只监听本机，不会对局域网开放。

### VSCode / VSCodium / Cursor / Windsurf

在 Hpp 设置的“编辑器集成”里点击安装，会装入随 Hpp 打包的 `hpp-bridge` 扩展。安装后：

- 编辑器右键：发送选中代码、当前行或当前文件。
- 资源管理器右键：文件发送引用；未保存或远程开发（SSH/WSL）的文件会连同内容一起发送；文件夹只发送路径。支持多选，选中的文件和文件夹会按顺序逐个插入。
- `Ctrl+Alt+H`（macOS `Cmd+Alt+H`）发送选区；没有选区时发送当前行。
- 命令面板里的“Hpp: 查看连接状态”用于确认端口和令牌是否可达。

已保存的本地文件只发送路径（编辑器内发送时附带行号），由 Hpp 自己读盘；未保存的缓冲区和非本地文件会携带字面内容，避免 Hpp 读到磁盘上的旧版本。

### Zed、Vim、Emacs 等

`bin/hpp-send.cjs` 是只依赖 Node 内置模块的通用发送端。Zed 由 Hpp 写入 `tasks.json` 和键位，使用与 VSCode 相同的 `Ctrl+Alt+H`；其他编辑器只要能在键位里启动进程，也可以直接调用：

```bash
node bin/hpp-send.cjs \
  --file "$ZED_FILE" \
  --start "$ZED_ROW" --end "$ZED_ROW" \
  --text-env ZED_SELECTED_TEXT \
  --language "$ZED_LANGUAGE"
```

常用参数：

- `--folder`：把 `--file` 当作文件夹引用发送，不读内容。
- `--text`、`--text-env`、`--text-stdin`：分别从参数、环境变量或标准输入提供未保存内容。
- `--session <id>`：插入到指定会话。
- `--no-focus`：插入后保留编辑器焦点，适合批量发送。

运行 `node bin/hpp-send.cjs --help` 查看完整参数。

## Agent 插件

Hpp 不在核心代码中按 Agent ID 判断配置格式或功能行为。插件通过 `hpp-agent-plugin.json` 描述自身能力：

- 展示顺序、安装提示和更新命令。
- Plan、guidance 和原生 fork 功能。
- Provider Endpoint 列表和默认 Endpoint。
- Provider 配置保存在 Hpp 中，或由插件读写原生配置文件。
- 模型列表使用后端列表、配置列表，或合并两者。
- 插件可声明是否允许用户隐藏后端或官方模型，只保留自定义渠道模型。
- 单渠道激活时由插件写入对应 Agent 的原生配置。

因此新增 Gemini CLI 等 Agent 时，不需要在 Hpp 中增加 `if (agentId === "gemini")`。插件只需声明能力，并在插件内实现后端与可选的 `configProvider`。

完整开发规范见 [agent-plugins.md](./agent-plugins.md)。

## 官方插件

官方插件源代码位于：

```text
electron/agent-plugins/
```

构建产物位于：

```text
release/v<version>/agent-plugins/<plugin-id>.zip
release/v<version>/agent-plugins/agent-plugins.json
```

打包和发布脚本会根据插件目录及清单文件自动发现插件，不维护固定的 Agent ID 名单。

官方插件目录使用独立的架构版本。发布需要更高 Hpp 版本的插件时，旧版 Hpp 会拒绝新目录；新版 Hpp 会显示最低版本要求，并禁止安装或更新不兼容的插件。

## 项目结构

```text
src/                       渲染界面、状态管理和共享类型
shared/                    渲染端与主进程共用的协议、常量和纯函数
electron/agents/           通用插件注册、配置编排和会话管理
electron/agent-plugins/    官方插件清单、入口和原生配置适配器
electron/plugin-backends/  官方后端实现
electron/plugin-runtime/   插件宿主和后端运行时
electron/editor-bridge/    编辑器桥接服务、安装器和 Zed 配置
electron/worktree/         会话级 Git worktree 管理
electron/git/              Git 工作台主进程服务
editors/vscode/            VSCode 系编辑器扩展源码
bin/hpp-send.cjs           通用编辑器发送 CLI
mobile/                    Android / Web 远程访问客户端
scripts/                   构建、打包和发布辅助脚本
```

## 安全边界

Agent 插件是受信任的本机代码。插件不在 Electron 主进程中执行，而是在独立的插件宿主进程中运行，因此插件崩溃不会直接终止主进程。

独立进程不是权限沙箱。插件仍拥有完整的 Node.js 权限，可以访问用户文件、环境变量、网络和本机命令。安装本地 ZIP 等同于运行本机程序，只应安装可信来源的插件。

聊天框中的权限档位会映射到官方 Agent 的原生审批与沙箱机制。Pi 通过 SDK 的 `tool_call` 执行前钩子接入 Hpp 审批，并与用户本地安装的 Pi 扩展共同加载。第三方 Hpp Agent 插件只有在清单中声明并实现审批能力时才会显示权限入口；Hpp 不会把插件宿主进程包装成不可绕过的系统级安全边界。

编辑器桥接同样不是额外的信任边界。它只绑定回环地址，用一次性令牌校验请求，且不返回 CORS 头；能读到 `editor-bridge.json` 的本机程序就可以调用它。发送内容由编辑器客户端决定，Hpp 只负责把引用插入当前会话。

## Linux、Wayland 与 niri

Linux 默认自动选择 Ozone 后端，并且不会强制关闭 Wayland 输入法、覆盖显示缩放或开启 VA-API。需要排查特定驱动或输入法问题时，可在启动 AppImage 前设置以下环境变量：

- `HPP_OZONE_PLATFORM=wayland|x11`：明确选择原生 Wayland 或 XWayland。
- `HPP_DISABLE_WAYLAND_IME=1`：仅在输入法兼容性排查时禁用 Wayland 输入法支持。
- `HPP_ENABLE_VAAPI=1`：显式启用 VA-API 视频编解码特性。
- `HPP_FORCE_DEVICE_SCALE_FACTOR=1.25`：显式覆盖设备缩放比例。

Linux 默认关闭窗口时退出，避免在没有系统托盘宿主的 niri 等桌面中隐藏后无法恢复。需要驻留托盘时，可在通用设置中手动启用；niri 下窗口尺寸由合成器快捷键管理。

### 全局唤起（Wayland / niri）

Wayland 没有给普通客户端的全局按键协议，`globalShortcut` 在原生 Wayland 会话下注册不上（X11 或 `HPP_OZONE_PLATFORM=x11` 时可以正常用）。Wayland 下改用合成器 keybind：再启动一次同一份 Hpp 并带上 `--quick-ask`，第二个进程会通过单实例锁退出，由已在运行的 Hpp 弹出输入条。

Hpp 会把设置里的「全局唤起」同步到 niri 的 include 文件，并在保存后让 niri 重载配置。`~/.config/niri/config.kdl` 只需要包含一次：

```kdl
include "hpp-quick-ask.kdl"

window-rule {
    match app-id=r#"hpp"# title=r#"^Hpp Quick Ask$"#
    open-floating true
    open-focused true
}
```

之后在 Hpp 设置里修改快捷键，Hpp 会更新 `~/.config/niri/hpp-quick-ask.kdl`，不需要再手动改主配置。生成文件由 Hpp 维护，不要手改；主配置缺少 include 时 Hpp 会在设置页提示。

- 窗口规则必须加，否则 760×150 的输入条会被当成平铺窗口塞进滚动列；`open-focused` 保证从其他窗口触发时输入条能拿到焦点。`app-id` 用 `niri msg windows` 确认，Electron 下通常是 `hpp`。
- Hpp 没在运行时按这个键会正常启动并直接弹出输入条；托盘隐藏状态下也能唤出。
- `npm run dev` 时生成文件会指向当前的 Electron 开发命令；切换回打包版后 Hpp 会自动改写。

