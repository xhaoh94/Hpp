# Hpp 远程访问

Hpp Android 与 Web 客户端直接连接正在运行的 Hpp 桌面应用。Agent 进程、项目、凭据和文件都保留在桌面电脑上。

## 桌面端设置

1. 打开 Hpp 设置并选择**远程访问**。
2. 将广播地址设置为桌面所在局域网、Tailscale 或 WireGuard 地址。
3. 远程访问随 Hpp 自动启动，默认 TCP 端口为 `47831`。
4. 选择**配对**。使用 Hpp Android 扫描一次性二维码，或用系统相机打开二维码以使用 Web 客户端。
5. 保持 Hpp 运行，建议启用"关闭到托盘"。

配对邀请五分钟后过期且只能使用一次。每台设备会获得独立的令牌，并可在桌面设置页面中吊销。

## 网络要求

- 仅接受针对 localhost、私有局域网网段、链路本地地址以及 Tailscale CGNAT 网段的明文 `http://` 和 `ws://` 连接。
- 从其他网络连接时请使用 Tailscale 或 WireGuard。
- 可填写用户自管理的 HTTPS 反向代理地址（`https://`）。
- 请勿将端口 `47831` 直接暴露到公网。本次发布中 Hpp Android 应用不提供托管中继或应用层加密。
- 局域网客户端无法访问健康检查端点时，请在桌面防火墙中允许入站 TCP `47831`。

未经认证的健康检查端点为 `GET /api/v1/health`。它仅返回主机与协议状态，绝不返回项目或会话数据。

## Web 客户端

远程访问运行后，在浏览器中打开广播的桌面地址，例如：

```text
http://192.168.1.20:47831/
```

Web 客户端由 Hpp 自身提供，因此局域网 `http/ws` 连接保持同源，不会被当作混合内容拦截。配对二维码会打开此页面并自动完成配对。后续访问请使用相同的主机名或 IP，因为浏览器存储按源隔离。

开发命令：

```powershell
npm run web:dev
npm run web:build
npm run web:preview
```

## Android 开发

前置要求：

- Node.js 20 或更高版本
- 带 Android SDK 36 的 Android Studio
- JDK 21，包括当前 Android Studio 自带的 JBR

命令：

```powershell
npm install
npm run mobile:sync
npm run mobile:android
```

构建调试版 APK：

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
npm run mobile:apk
```

APK 输出到：

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

构建已签名的发布版 APK：

```powershell
npm run mobile:release
```

发布版 APK 和更新元数据写入 `release/v<version>/Hpp-Android.apk` 与 `release/v<version>/android-latest.json`。首次发布构建时，Hpp 会在 `%USERPROFILE%\.hpp\android-signing` 下创建持久签名密钥。请安全备份该目录：今后每次 Android 更新都必须使用相同的密钥签名。

## Android 更新

Android 应用在启动时以及每次回到前台时，会检查最新 GitHub Release 中的 `android-latest.json`。它比较的是 Android `versionCode` 而非显示版本号。检测到更新的构建后，Hpp 会下载 APK、校验其 SHA-256 摘要，然后打开 Android 系统安装器。桌面端主机列表底部显示的版本号可以点按，用于手动检查。

首次更新时 Android 可能会请求安装未知应用的权限。请为 Hpp 授予该权限并返回应用，安装会使用已校验的 APK 继续。所有更新发布都必须使用相同的签名密钥和更高的 `versionCode`。

在更新器功能加入之前发布的构建无法自行发现更新器。请手动安装一次首个包含更新器的 APK，之后的版本即可使用应用内更新流程。

修改 `mobile/src` 下的文件后需要运行 `mobile:sync`，它会重新构建 Web 应用并复制到原生 Android 项目中。

## 安全与存储

- Android 连接配置与令牌由基于 Android Keystore 的安全存储保存。
- Web 连接配置与令牌以明文保存在浏览器按源隔离的本地存储中。请仅使用可信的浏览器配置和设备。
- 两个客户端都会记住上次连接的桌面并自动重新连接。
- 项目与会话快照保存在内存中，Android 进程终止后即消失。
- 桌面端仅在 `hpp-data/remote-access.json` 中持久保存令牌的 SHA-256 哈希和设备元数据。
- 远程载荷不会包含项目根目录、Agent 会话文件路径、Provider 配置和凭据。
- 发送消息需要唯一的 `clientMessageId`。未确认的发送不会自动重试。

## 当前边界

项目只能在桌面端创建。远程客户端可以在已有项目中创建、关闭、重新打开和分叉会话，但不能永久删除它们。它们还可以浏览会话、发送文本和图片、排队后续消息、回答 Agent 提问、停止运行中的任务，以及更改会话模型、思考级别和全局 Plan 模式。

GitHub Releases 提供签名 APK 和元数据，用于将来的直接 APK 更新。
