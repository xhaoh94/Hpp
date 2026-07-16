# Hpp remote access

The Hpp Android and Web clients connect directly to a running Hpp desktop application. Agent processes, projects, credentials, and files remain on the desktop computer.

## Desktop setup

1. Open Hpp settings and select **Remote access**.
2. Set the advertised address to the desktop LAN, Tailscale, or WireGuard address.
3. Remote access starts automatically with Hpp. The default TCP port is `47831`.
4. Select **Pair**. Scan the one-time QR code with Hpp Android, or open it with a system camera to use the Web client.
5. Keep Hpp running. Enabling close-to-tray is recommended.

Pairing offers expire after five minutes and can be used once. Each device receives a separate token and can be revoked from the desktop settings page.

## Network requirements

- Plain `http://` and `ws://` connections are accepted only for localhost, private LAN ranges, link-local addresses, and the Tailscale CGNAT range.
- Use Tailscale or WireGuard when connecting from another network.
- A user-managed HTTPS reverse proxy can be entered as an `https://` address.
- Do not expose port `47831` directly to the public internet. The Hpp Android app does not provide a hosted relay or application-layer encryption in this release.
- Allow inbound TCP `47831` in the desktop firewall when LAN clients cannot reach the health endpoint.

The unauthenticated health endpoint is `GET /api/v1/health`. It returns host and protocol status only and never returns project or conversation data.

## Web client

With remote access running, open the advertised desktop address in a browser, for example:

```text
http://192.168.1.20:47831/
```

The Web client is served by Hpp itself, so LAN `http/ws` connections remain same-origin and are not blocked as mixed content. The pairing QR opens this page and completes pairing automatically. Use the same hostname or IP address on later visits because browser storage is isolated by origin.

Development commands:

```powershell
npm run web:dev
npm run web:build
npm run web:preview
```

## Android development

Prerequisites:

- Node.js 20 or newer
- Android Studio with Android SDK 36
- JDK 21, including the JBR bundled with current Android Studio

Commands:

```powershell
npm install
npm run mobile:sync
npm run mobile:android
```

Build a debug APK:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
npm run mobile:apk
```

The APK is written to:

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Build the signed release APK:

```powershell
npm run mobile:release
```

The release APK and update metadata are written to `release/Hpp-Android.apk` and `release/android-latest.json`. On the first release build, Hpp creates a persistent signing key under `%USERPROFILE%\.hpp\android-signing`. Back up that directory securely: every future Android update must be signed with the same key.

`mobile:sync` rebuilds the Web application and copies it into the native Android project. Run it after changing files under `mobile/src`.

## Security and storage

- Android connection profiles and bearer tokens are stored by Android Keystore-backed secure storage.
- Web connection profiles and bearer tokens are stored unencrypted in the browser's origin-scoped local storage. Use only a trusted browser profile and device.
- Both clients remember the last connected desktop and reconnect automatically on the next launch.
- Project and conversation snapshots remain in memory and disappear when the Android process is terminated.
- The desktop persists only SHA-256 token hashes and device metadata in `hpp-data/remote-access.json`.
- Remote payloads omit project roots, Agent session file paths, provider configuration, and credentials.
- Sending a message requires a unique `clientMessageId`. An unacknowledged send is not retried automatically.

## Current boundaries

Projects can only be created on the desktop. Remote clients can create, close, reopen, and fork sessions inside an existing project, but they cannot permanently delete them. They can also browse conversations, send text and images, queue follow-ups, answer Agent questions, stop a running task, and change the session model, thinking level, and global Plan mode.

Reliable background notifications, offline conversation storage, iOS, a hosted relay, and Google Play publishing are not included. GitHub releases provide the signed APK and metadata for future direct APK updates.
