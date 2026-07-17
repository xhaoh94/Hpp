# Hpp 发布约定

每个版本的本地发布产物必须保存到独立目录：

```text
release/
  v<version>/
    hpp-Setup-<version>.exe
    hpp-Setup-<version>.exe.blockmap
    latest.yml
    Hpp-Android.apk
    android-latest.json
    agent-plugins/
      agent-plugins.json
      <plugin-id>.zip
```

例如 `0.1.1` 的产物目录是 `release/v0.1.1/`。构建和发布脚本必须从根目录 `package.json` 的 `version` 自动计算目录名，不允许把新版本产物重新堆放在 `release/` 根目录。

GitHub Release 上传必须使用 Node.js 文件流。当前发布脚本 `scripts/reset-github-release.cjs` 通过 `createReadStream()` 将每个资产直接传给 HTTPS 请求；后续修改或重写发布流程时必须保留流式上传，不能把 APK、EXE 等完整文件一次性读入内存。

常用发布命令：

```powershell
npm run build
npm run dist
npm run mobile:release
npm run release:github
```

执行 `npm run release:github` 前，确认 `release/v<version>/` 中的桌面安装包、Android APK、更新清单和 Agent 插件资产均属于同一版本。
