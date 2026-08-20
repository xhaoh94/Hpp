# Hpp 发布构建手册

一键发布：`npm run release` 完成 Windows + Android 构建、归档、上传 GitHub、触发 Linux AppImage。

## 0. 快速发布（一键完成）

```powershell
# 1. 编写发布说明
编辑 docs/release-notes/v0.1.15.md

# 2. 一键发布（构建 + 归档 + 上传 + 触发 Linux）
$env:GH_TOKEN = "<GitHub token>"
npm run release
```

可选参数：
- `npm run release -- --build` 强制重新构建（默认行为）
- `npm run release -- --skip-build` 跳过构建，直接用已有产物发布
- `npm run release -- --skip-linux` 不触发 Linux AppImage 构建

## 1. 发布前检查

```powershell
git status --short
npm test
```

修改 `package.json` 的 `version`（例如 `0.1.16`）。Android 的 `mobile/android/app/build.gradle` 中 `versionName` 必须相同，`versionCode` 每个版本递增。

## 2. 编写发布说明（强制）

每次发布**必须**根据本次实际改动重新编写发布说明，**禁止复用旧版本说明**。

编辑 `docs/release-notes/v<version>.md`，脚本会执行三道检查：
- 文件不存在 → 报错并生成骨架模板
- 文件为空 → 报错
- 含 `TODO / TBD / 待填写` 等占位符 → 报错

## 3. 发布流程详解

`npm run release` 自动执行以下步骤：

1. **构建**：`npm run dist`（Windows + Electron 插件）+ `npm run mobile:release`（Android APK）
2. **归档**：将产物复制到 `release\v<version>\` 目录
3. **上传 GitHub**：创建/更新 Release，上传所有资产
4. **触发 Linux**：调用 GitHub Actions 构建 AppImage 并自动上传

## 4. Linux AppImage

Linux AppImage 由 GitHub Actions 在 Ubuntu runner 上构建，完成后自动上传到同一 Release。

**发布完成后检查**：
- 访问 https://github.com/xhaoh94/Hpp/actions 查看 Linux workflow 状态
- 等待绿色完成 → AppImage 自动出现在 Release 资产列表

## 5. 手动操作（仅当需要时）

### 只上传不构建

```powershell
npm run release -- --skip-build
```

### 只触发 Linux 构建

```powershell
gh workflow run build-linux-appimage.yml --ref main -f release_tag=v0.1.15
```

### 手动上传单个文件

```powershell
gh release upload v0.1.15 "release\v0.1.15\Hpp-Android.apk" --clobber
```

## 6. 常见问题

### `GH_TOKEN is required`

在当前 PowerShell 会话设置环境变量，不要写入仓库：
```powershell
$env:GH_TOKEN = "<token>"
```

### Release 资产丢失

新流程不会删除 Release。如果资产丢失说明上传中断，重新执行 `npm run release` 即可（会自动覆盖/追加）。

### Linux AppImage 未构建

手动触发：GitHub Actions → Build & Publish Linux AppImage → Run workflow

### Android 构建失败

检查 `JAVA_HOME`、`ANDROID_HOME`、签名目录和 `versionName/versionCode`。APK 必须使用同一签名密钥。
