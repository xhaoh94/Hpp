# Codex CLI + Pi SDK/CLI 离线打包说明

## 1. 目标与适用范围

本文记录 Windows x64 无网络环境下打包和安装 Codex CLI、Pi SDK/CLI 的完整方法。
离线包自带 Node.js、npm 依赖和 Windows x64 原生文件，目标机器不需要再访问 npm，也不需要单独安装 Node.js。

本文只覆盖 CLI/SDK 软件安装。模型 API 地址、API Key、账号登录和内网模型网关不包含在包内，运行模型请求时仍需配置可达的服务。

## 2. 当前打包版本（2026-08-26）

| 组件 | 包名 | 版本 |
| --- | --- | --- |
| Codex CLI | `@openai/codex` | `0.149.1` |
| Pi SDK/CLI | `@earendil-works/pi-coding-agent` | `0.84.3` |
| Node.js | 便携运行时 | `24.12.0` |

Pi 包既提供 SDK 导出，也提供 `pi` 命令。当前版本的 npm `bin` 入口是 `dist/bundle/cli.js`；Hpp 集成使用同一个包的 SDK 导出，不依赖全局 `pi` 命令。

## 3. 为什么必须按 Hpp 目录部署 Pi SDK

Hpp Pi 插件不会通过 PATH 查找全局 `pi` 命令，而是固定读取：

```text
%APPDATA%\hpp\hpp-data\pi-sdk-runtime\node_modules\@earendil-works\pi-coding-agent
```

因此只把包安装到 `%LOCALAPPDATA%\Programs\CodexPiCLI`，虽然便携 `pi.cmd` 可以运行，但 Hpp Agent 面板仍可能显示“未安装”。安装脚本会同时完成两件事：

1. 把 Node、Codex、Pi CLI 安装到 `%LOCALAPPDATA%\Programs\CodexPiCLI`。
2. 把完整的 `app` 依赖树复制到 Hpp 的 `pi-sdk-runtime` 目录。

## 4. 离线包目录结构

```text
codex-pi-offline-win-x64-latest-2026-08-26/
├─ app/
│  ├─ package.json
│  └─ node_modules/
├─ runtime/
│  └─ node.exe                 # Node.js 24.12.0
├─ codex.cmd                   # 便携 Codex 入口
├─ pi.cmd                      # 便携 Pi CLI 入口
├─ install.ps1                 # 安装和 Hpp SDK 部署脚本
├─ README.txt
└─ VERSIONS.txt
```

`app/package.json` 固定精确版本，不使用 `latest`：

```json
{
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.84.3",
    "@openai/codex": "0.149.1"
  }
}
```

## 5. 构建流程

以下命令在联网的 Windows x64 打包机执行。示例目录为 `release/codex-pi-offline-win-x64-latest-2026-08-26`。

### 5.1 查询最新版本

```powershell
npm view @openai/codex version dist-tags --json
npm view @earendil-works/pi-coding-agent version engines dist-tags --json
```

确认 Pi 的 Node 要求，例如：

```text
node >=22.19.0
```

### 5.2 准备固定版本的 app 目录

创建 `app/package.json`，填入本次确认的精确版本，然后安装生产依赖：

```powershell
cd release\codex-pi-offline-win-x64-latest-2026-08-26\app
npm install --omit=dev --no-audit --no-fund
```

不要使用 `--ignore-scripts`。Codex 的 Windows 原生包通过 npm 的可选依赖安装，跳过脚本或平台依赖处理可能造成缺少可执行文件。

安装后检查：

```powershell
npm ls @openai/codex @earendil-works/pi-coding-agent --depth=0
Test-Path node_modules\@openai\codex-win32-x64
Test-Path node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js
```

### 5.3 下载便携 Node.js

下载 Windows x64 ZIP 并解压到包内的 `runtime` 目录。当前包使用：

```text
https://nodejs.org/dist/v24.12.0/node-v24.12.0-win-x64.zip
```

解压后应存在：

```text
runtime\node.exe
```

### 5.4 设置命令入口

`codex.cmd` 使用：

```text
runtime\node.exe app\node_modules\@openai\codex\bin\codex.js
```

`pi.cmd` 使用当前 Pi 包的官方 `bin` 入口：

```text
runtime\node.exe app\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js
```

入口脚本使用 `%~dp0`，所以从任意工作目录启动都能找到包内 Node 和依赖。

### 5.5 安装脚本的部署逻辑

`install.ps1` 默认参数：

```powershell
$InstallDir = "$env:LOCALAPPDATA\Programs\CodexPiCLI"
$HppDataDir = "$env:APPDATA\hpp\hpp-data"
```

脚本执行顺序：

1. 检查 `runtime\node.exe`、Codex 入口和 Pi `dist\bundle\cli.js` 是否存在。
2. 使用 `robocopy /E` 复制 `runtime` 和 `app` 到 CLI 安装目录。
3. 使用 `robocopy /E` 将完整 `app` 目录复制到 `$HppDataDir\pi-sdk-runtime`。
4. 检查 Hpp 目录下 Pi 的 `package.json` 并输出版本。
5. 默认把 CLI 安装目录加入用户级 PATH。
6. 调用两个入口输出版本，作为安装结果校验。

使用 `robocopy` 而不是深层 `Copy-Item` 是为了避免 Pi 的 AWS SDK 等依赖路径较深时触发 Windows PowerShell 5.1 路径复制错误。`robocopy` 返回码小于 8 视为成功。

## 6. 打包成 ZIP

从 `release` 目录执行：

```powershell
tar.exe -a -cf codex-pi-offline-win-x64-0.149.1-0.84.3.zip `
  -C . codex-pi-offline-win-x64-latest-2026-08-26
```

Windows PowerShell 自带的 `Compress-Archive` 在大量 `node_modules` 文件上可能耗时很长；`tar.exe -a` 通常更适合本包。

生成 SHA-256：

```powershell
Get-FileHash -Algorithm SHA256 .\codex-pi-offline-win-x64-0.149.1-0.84.3.zip
```

当前包的校验值：

```text
51B82861AE09FDA0CBC6C2D04DF1CAFE93C948088CAD63B3770DEF6CB842074B
```

## 7. 内网机器安装

1. 复制完整 ZIP 到 Windows x64 内网机器并解压。
2. 在解压目录打开 PowerShell。
3. 执行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

4. 看到类似输出后，完全退出并重新打开 Hpp：

   ```text
   Hpp Pi SDK installed: 0.84.3
   codex-cli 0.149.1
   0.84.3
   ```

5. 打开 Hpp Agent 面板并点击“刷新”（必要时重启 Hpp）。

可选参数：

```powershell
# 指定 CLI 安装目录
powershell -ExecutionPolicy Bypass -File .\install.ps1 -InstallDir D:\Tools\CodexPiCLI

# 指定 Hpp 数据目录
powershell -ExecutionPolicy Bypass -File .\install.ps1 -HppDataDir D:\HppData

# 不修改用户 PATH
powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoPath

# 只安装便携 CLI，不部署 Hpp Pi SDK
powershell -ExecutionPolicy Bypass -File .\install.ps1 -SkipHppSDK
```

也可以不安装，直接在解压目录便携运行：

```powershell
.\codex.cmd --version
.\pi.cmd --version
```

## 8. 发布前验证清单

在打包机上完成以下检查：

```powershell
# 精确版本
npm ls @openai/codex @earendil-works/pi-coding-agent --depth=0

# 关键文件
Test-Path .\runtime\node.exe
Test-Path .\app\node_modules\@openai\codex\bin\codex.js
Test-Path .\app\node_modules\@openai\codex-win32-x64
Test-Path .\app\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js

# 不依赖系统 Node 的启动验证
$oldPath = $env:Path
$env:Path = "$env:SystemRoot\System32;$env:SystemRoot"
try {
  .\codex.cmd --version
  .\pi.cmd --version
} finally {
  $env:Path = $oldPath
}
```

然后把 ZIP 解压到新的临时目录，再执行一次 `install.ps1`，确认 Hpp SDK 目录中的：

```text
pi-sdk-runtime\node_modules\@earendil-works\pi-coding-agent\package.json
```

存在且版本正确。

## 9. 常见问题

### 9.1 命令可以运行，但 Hpp 显示 Pi 未安装

通常是只把包放到了 CLI PATH 目录，没有部署到 Hpp 的 `pi-sdk-runtime`。使用完整 `install.ps1`，不要只运行 npm 全局安装。

### 9.2 PowerShell 报解析错误或中文乱码

旧版脚本含中文且以无 BOM UTF-8 保存，Windows PowerShell 5.1 可能按本地 ANSI 解码。当前 `install.ps1` 使用 ASCII 文本，兼容 PowerShell 5.1。

### 9.3 复制依赖时报路径太长

使用当前脚本中的 `robocopy` 复制逻辑。不要改回对整个 `app` 目录执行深层 `Copy-Item`。

### 9.4 Codex 启动时报 Electron 或原生文件错误

这属于 Hpp 项目自身 Electron 依赖问题，不是 Codex/Pi 离线包问题。项目开发环境应运行正常的 `npm install`，不要使用 `--ignore-scripts`；Electron 的安装脚本需要下载其平台二进制。

### 9.5 完全隔离网络环境能安装但不能调用模型

离线包只包含软件和依赖，不包含模型服务。还需要为 Codex/Pi 配置内网可访问的 API endpoint、认证信息和必要的代理设置。

## 10. 更新新版本的建议流程

1. 重新执行第 5.1 节的 npm 版本查询。
2. 更新 `app/package.json` 的两个精确版本。
3. 删除旧的 `app/node_modules` 和锁文件后重新执行生产依赖安装，避免残留旧包。
4. 如果新 Pi 版本的 `bin` 路径变化，按 `npm view ... bin --json` 的结果更新 `pi.cmd` 和安装脚本检查项。
5. 更新 `VERSIONS.txt`、`README.txt` 和 ZIP 文件名。
6. 通过第 8 节清单，尤其是“无系统 Node 启动”和“临时目录安装”验证。
7. 重新生成 SHA-256，并将校验文件与 ZIP 一起发布。
