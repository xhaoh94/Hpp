# Hpp 发布构建手册

本文是 Hpp Windows、Linux AppImage、Android APK 和 Agent 插件的标准发布流程。发布目录按版本隔离，GitHub Release 资产统一由 Node 流脚本上传。

## 1. 发布前检查

在 `C:\Project\Hpp` 执行：

```powershell
git status --short
npm test
npm run build
```

修改 `package.json` 的 `version`（例如 `0.1.8`）。Android 的 `mobile/android/app/build.gradle` 中 `versionName` 必须相同，`versionCode` 每个版本递增。确认签名目录 `%USERPROFILE%\.hpp\android-signing` 不要更换。

## 2. Windows 和 Android 构建

```powershell
npm run dist
npm run mobile:release
```

构建完成后，将 Windows 安装包、更新清单、APK 和 Android 清单归档到版本目录：

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$versionDir = "release\v$version"
New-Item -ItemType Directory -Force $versionDir | Out-Null
Copy-Item "release\hpp-Setup-$version.exe", "release\hpp-Setup-$version.exe.blockmap", "release\latest.yml" $versionDir -Force
Copy-Item "release\Hpp-Android.apk", "release\android-latest.json" $versionDir -Force
```

## 3. Linux AppImage（Windows 发布时的正确流程）

不要在 Windows 发布流程中直接依赖 `npm run dist:linux`。Linux AppImage 应由 GitHub Actions 在 Ubuntu runner 上构建，否则可能因 Docker、Wine、FUSE 或原生依赖导致卡住。

1. 先提交并推送当前代码，让 workflow 使用正确的提交：

   ```powershell
   git add -A
   git commit -m "release: v<version>"
   git push origin HEAD
   ```

2. 打开 GitHub 仓库的 **Actions → Build Linux AppImage**，等待刚才提交对应的 workflow 完成并显示绿色。不要在 workflow 运行中执行上传脚本。
3. 下载该次运行的 artifact `hpp-linux-appimage`，解压得到 `Hpp-Linux-<version>-x86_64.AppImage` 和 `latest-linux.yml`。
4. 将两个文件复制到版本目录：

   ```powershell
   $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
   $versionDir = "release\v$version"
   New-Item -ItemType Directory -Force $versionDir | Out-Null
   Copy-Item "<artifact解压目录>\Hpp-Linux-$version-x86_64.AppImage" $versionDir -Force
   Copy-Item "<artifact解压目录>\latest-linux.yml" $versionDir -Force
   ```

5. 检查 AppImage 是 Linux ELF 文件，而不是下载错误页：

   ```powershell
   Format-Hex "$versionDir\Hpp-Linux-$version-x86_64.AppImage" -Count 4
   Get-Item "$versionDir\Hpp-Linux-$version-x86_64.AppImage" | Select-Object Length
   Get-Content "$versionDir\latest-linux.yml"
   ```

文件前 4 个字节必须是 `7F 45 4C 46`（`ELF`）。`latest-linux.yml` 的版本、文件名、size 和 sha512 必须与 AppImage 一致。

只有在 Ubuntu/Linux 本机上，才可使用下面的本地构建替代 Actions：

```bash
npm ci
npm test
npm run dist:linux
```

## 4. 最终目录和资产

`release\v<version>\` 至少应包含：

```text
hpp-Setup-<version>.exe
hpp-Setup-<version>.exe.blockmap
latest.yml
Hpp-Linux-<version>-x86_64.AppImage
latest-linux.yml
Hpp-Android.apk
android-latest.json
agent-plugins/agent-plugins.json
agent-plugins/<plugin-id>.zip   # 当前发布的 5 个插件
```

检查：

```powershell
Get-ChildItem "release\v$version" -Recurse
```

## 5. 上传 GitHub Release

设置 token 后执行：

```powershell
$env:GH_TOKEN = "<GitHub token>"
npm run release:github
```

`scripts/reset-github-release.cjs` 会读取 `package.json.version`，使用 `v<version>` tag，删除并重建同名 Release，然后使用 `fs.createReadStream(filePath).pipe(request)` 逐个以 Node 流上传资产。不要用浏览器手工上传，也不要把 APK、EXE 或 AppImage 用 `readFileSync` 一次性读入内存。

重复发布同一版本前，必须重新构建并覆盖 `release\v<version>\` 中的全部资产，避免旧文件混入。

## 6. 发布后检查

- Release tag 为 `v<version>`，且不是 draft/prerelease。
- Windows、Linux、Android 安装包和各自更新清单均已上传。
- `latest.yml`、`latest-linux.yml` 和 `android-latest.json` 的版本与校验值正确。
- Release 中包含 `agent-plugins` 清单及插件 zip。
- 用实际客户端检查更新和下载链接。

## 常见问题

### Linux 构建卡住或没有 AppImage

确认使用的是 GitHub Actions 的 Ubuntu workflow，并等待 artifact 完成下载；Windows 本地不要把 `npm run dist:linux` 当作标准流程。

### `GH_TOKEN is required`

在当前 PowerShell 会话重新设置 `$env:GH_TOKEN`，不要将 token 写入仓库。

### Android 构建失败或无法更新

检查 `JAVA_HOME`、`ANDROID_HOME`、签名目录以及 `versionName/versionCode`。APK 更新必须使用同一签名密钥。

### Actions 产物校验失败

重新下载同一次成功运行的 artifact，确认 AppImage 前 4 字节为 ELF，并让 `latest-linux.yml` 与文件重新生成后再上传。
