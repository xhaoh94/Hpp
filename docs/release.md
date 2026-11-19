# Hpp 发布构建手册

> **全平台产物一律由 GitHub Actions 在云端构建并上传**，本机只负责创建 Release 和触发 workflow。
> 一键发布：`npm run release`（= `node scripts/release-all.cjs`）。

## 0. 快速发布

```powershell
# 1. 版本号：package.json / mobile/package.json 的 version 一致；
#    mobile/android/app/build.gradle 的 versionName = 同版本，versionCode 递增。

# 2. 编写发布说明（必须基于本次实际改动，禁止复用旧版）
编辑 docs/release-notes/v<version>.md

# 3. 提交并推送 main（workflow 都从 main checkout 源码）
git add -A
git commit -m "release: v<version>"
git push origin main

# 4. 一键发布
$env:GH_TOKEN = "<GitHub token>"
npm run release
```

`npm run release` 做的事：

1. 创建/更新 GitHub Release，写入 `docs/release-notes/v<version>.md`（**只写说明，不上传本地文件**）
2. 触发三个云端构建 workflow：`build-windows-release.yml` / `build-android-apk.yml` / `build-linux-appimage.yml`
3. 等待每个 workflow 结束
4. 验收 Release 资产齐全（Windows exe / Android APK / Linux AppImage / latest.yml / agent-plugins.json）

可选参数：`npm run release -- --skip-trigger` —— 只创建 Release + 写说明，不触发构建（用于先把 Release 建好、稍后手动逐个触发 workflow）。

## 1. 发布前检查

```powershell
git status --short
npm run typecheck:release
npm test
```

- 版本号三处对齐：`package.json` 和 `mobile/package.json` 的 `version`、`mobile/android/app/build.gradle` 的 `versionName` 必须相同；`versionCode` 每次发布 +1。
- **插件有改动时必须升插件版本号**（见「插件版本」一节），否则客户端按版本号比对，不会重新拉取 zip。
- 所有改动必须已提交并 push 到 `main`——workflow 从 main checkout 源码，没推上去的代码不会进包。

## 2. 编写发布说明（强制）

每次发布**必须**根据本次实际改动重新编写 `docs/release-notes/v<version>.md`，禁止复用旧版本说明。`reset-github-release.cjs` 会检查三道：文件不存在 / 为空 / 含 `TODO / TBD / 待填写` 占位符，任一命中都会中止发布。

## 3. 云端构建架构

三个 workflow 都在 `.github/workflows/`，**全部只保留 `workflow_dispatch`**，由 `npm run release` 显式触发：

| Workflow | 产物 | 关键点 |
|---|---|---|
| `build-windows-release.yml` | `hpp-Setup-<version>.exe`、`.blockmap`、`latest.yml`、**全部插件 zip** | Windows runner；无本机 signtool 签名；插件包由它统一上传（避免三处同时 clobber） |
| `build-android-apk.yml` | `Hpp-Android.apk`、`android-latest.json` | 从 Secrets 还原签名密钥；JDK **21**；`bash ./gradlew`（gradlew 无执行位） |
| `build-linux-appimage.yml` | `Hpp-Linux-<version>-x86_64.AppImage`、`latest-linux.yml` | Ubuntu runner，`npx electron-builder --linux AppImage` |

**为什么本机不构建大文件**：本机上传到 `uploads.github.com` 常被代理/链路中断（408 / EOF / TLS timeout），99MB 的 exe 多次重试仍失败；GitHub Actions 在 GitHub 内网上传不受影响。APK（29MB）本机虽能传，但为统一流程也走云端。

**为什么不加 `release: published` 自动触发**：新建 Release 时会「自动 + 脚本手动」双跑，两次构建的 exe 哈希不同、互相覆盖 `latest.yml`，导致自动更新校验失败。统一由脚本一个入口触发。

**自动更新元数据**：Windows 的 `latest.yml`（含 exe 的 sha512/size）和 Android 的 `android-latest.json`（含 APK sha256）必须由构建它的同一个 workflow 上传，否则哈希对不上、自动更新会失败。已分别内置在对应 workflow 里。

## 4. Android 签名 Secrets（一次性配置）

APK 必须用**同一把发布密钥**，否则老用户无法覆盖升级。密钥只存 GitHub Secrets，不进仓库、不进对话。

在仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加四个：

| Secret | 取值 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `hpp-release.jks` 的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | `release.properties` 里的 `storePassword` |
| `ANDROID_KEY_ALIAS` | `hpp-release` |
| `ANDROID_KEY_PASSWORD` | `release.properties` 里的 `keyPassword` |

生成 base64（Windows PowerShell）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\.hpp\android-signing\hpp-release.jks")) | Set-Clipboard
```

CI 会还原到 `$RUNNER_TEMP/hpp-android-signing/`，写 `release.properties`（storeFile 绝对路径），并设 `HPP_ANDROID_SIGNING_PROPERTIES` 指向它（`mobile/android/app/build.gradle:3` 读这个环境变量）。**绝不能让 `ensure-android-signing.cjs` 在 CI 随机生成密钥**——签名变了老用户升不了级。

更换密钥时只需更新这四个 Secret，不用改 workflow。

## 5. 插件版本

插件源码在 `electron/agent-plugins/*`，打包产物是 `release/v<version>/agent-plugins/*.zip`，由 Windows workflow 随 exe 一起上传。

**规则**：插件有改动时必须升该插件 `hpp-agent-plugin.json` 里的 `version` 并提交（客户端只按版本号判断更新，版本相同就不会重新下载）。打包脚本 `package-agent-plugins.cjs` 按内容 hash 校验，改了插件代码却没升版本会直接中止构建；CI 里设 `HPP_SKIP_PLUGIN_DRIFT_CHECK=1` 是因为 Windows 提交 CRLF、Linux checkout LF 会产生误判。

## 6. 手动补发（仅当需要时）

先看哪个 workflow 失败了：

```powershell
gh run list --workflow=build-windows-release.yml --limit 3
gh run view <run-id> --log-failed
```

单独重跑某个平台：

```powershell
gh workflow run build-windows-release.yml --ref main -f release_tag=v0.1.11
gh workflow run build-android-apk.yml    --ref main -f release_tag=v0.1.11
gh workflow run build-linux-appimage.yml --ref main -f release_tag=v0.1.11
```

手动补传单个文件（大文件从本机传可能失败，优先重跑 workflow）：

```powershell
gh release upload v0.1.11 "release\v0.1.11\Hpp-Android.apk" --clobber
```

## 7. 发布后验收

```powershell
# 资产清单：应有三大平台 + 插件包 + 元数据
gh release view v0.1.11 --json assets -q '.assets[].name'
```

核对：
- `hpp-Setup-<version>.exe` / `Hpp-Android.apk` / `Hpp-Linux-<version>-x86_64.AppImage` 三个都在
- `latest.yml` 里的 sha512/size 与 Release 上的 exe 一致（自动更新用）
- `android-latest.json` 里的 sha256 与 Release 上的 APK 一致；APK 签名指纹应与上一版相同：

```powershell
# 本机校验签名（需 JAVA_HOME 指向含 keytool/apksigner 的 JDK 21）
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.1.0\apksigner.bat" verify --print-certs Hpp-Android.apk
```

## 8. 常见问题

### `GH_TOKEN is required`

在 PowerShell 会话里设置，不要写入仓库：`$env:GH_TOKEN = "<token>"`

### 某个平台资产缺失

优先重跑对应 workflow（见第 6 节），不要从本机传大文件。

### Android workflow 失败

看 `gh run view <run-id> --log-failed`，常见原因：四个 Secret 缺失/名字错、JDK 版本不是 21、`versionName` 与 `package.json` 不一致。

### Release 说明没更新

`npm run release` 会 PATCH 已有 Release 的 body；若只改了本地文档没跑脚本，说明不会同步。
