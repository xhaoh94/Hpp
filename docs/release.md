# Hpp 发布手册

本文是 Hpp 发布新版本的唯一操作说明。发布 Windows、Linux 和 Android 三个平台，并将全部产物上传到 GitHub Release。

## 发布前检查

1. 确认当前分支包含要发布的代码，并且工作区没有未提交的发布相关改动。
2. 修改根目录 `package.json` 中的 `version`，例如 `0.1.7`。版本号必须是新的 semver 版本。
3. 确认 `mobile/android/app/build.gradle` 的 `versionName` 与 `package.json.version` 完全一致；如需发布 Android，还要递增 `versionCode`。
4. 准备 GitHub Personal Access Token，并在当前 PowerShell 会话设置：

```powershell
$env:GH_TOKEN = "<GitHub token>"
```

Token 至少需要目标仓库的 Release/Contents 写权限。不要把 Token 写入文件或提交到 Git。

## 标准发布流程

以下命令均在项目根目录 `C:\Project\Hpp` 执行。

```powershell
npm test
npm run build
npm run dist
npm run dist:linux
npm run mobile:release
```

`npm run build` 会构建 Electron、移动端 Web 资源和官方 Agent 插件；`npm run dist` 会生成 Windows NSIS 安装包；`npm run dist:linux` 会生成 Linux x64 AppImage；`npm run mobile:release` 会生成已签名 Android APK，并写入 Android 更新元数据。

Linux 构建默认输出到 `release\` 根目录，需要在上传前归档到当前版本目录：

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$versionDir = "release\v$version"
New-Item -ItemType Directory -Force $versionDir | Out-Null
Copy-Item "release\Hpp-Linux-$version-x86_64.AppImage" $versionDir -Force
Copy-Item "release\latest-linux.yml" $versionDir -Force
```

检查版本目录：

```powershell
Get-ChildItem "release\v$version" -Recurse
```

应至少包含以下产物：

```text
release/v<version>/
  hpp-Setup-<version>.exe
  hpp-Setup-<version>.exe.blockmap
  latest.yml
  Hpp-Linux-<version>-x86_64.AppImage
  latest-linux.yml
  Hpp-Android.apk
  android-latest.json
  agent-plugins/
    agent-plugins.json
    <plugin-id>.zip
```

## 上传 GitHub Release

确认上面的文件全部存在后执行：

```powershell
npm run release:github
```

`scripts/reset-github-release.cjs` 会：

- 从 `package.json` 读取版本号，并使用 `v<version>` 作为 tag；
- 检查 Windows、Linux、Android 和 Agent 插件产物；
- 如果同名 Release/tag 已存在，先删除后重新创建；
- 创建正式的 GitHub Release；
- 使用 Node.js `fs.createReadStream()` 配合 HTTPS 请求，以文件流方式逐个上传资产。

上传脚本必须保持流式上传。不要把 APK、EXE 或 AppImage 通过 `readFileSync` 一次性读入内存，也不要改用手工网页上传替代脚本流程。

## 发布完成检查

1. 打开脚本输出的 GitHub Release 地址。
2. 确认 Release tag 为 `v<version>`，且不是 draft/prerelease。
3. 确认三个平台的安装包和各自更新清单都已上传。
4. 确认 Windows/Linux 的更新清单引用的版本与当前版本一致。
5. 确认 `updates/android-latest.json` 已随代码提交；其中 Android `sha256` 应与发布页上的 APK 校验值一致。

## 常见问题

### `GH_TOKEN is required`

当前 PowerShell 没有设置 Token。重新执行：

```powershell
$env:GH_TOKEN = "<GitHub token>"
```

### 找不到 Android 工具链

安装 Android Studio，或设置 `JAVA_HOME` 和 `ANDROID_HOME` 后重试：

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
```

### 重新发布同一版本

上传脚本会删除同 tag 的旧 Release 和 tag 后重建。仍应先重新执行全部构建步骤，确保 `release\v<version>` 中没有上一轮遗留或错误产物。
