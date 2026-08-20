# Release Notes 目录

每次发布（`npm run release:github`）前必须更新版本说明。

## 规则（强制执行）

1. **每个版本独立文件**：命名为 `release-notes/v<版本号>.md`，例如 `release-notes/v0.1.15.md`。
2. **每次发布都必须重新编辑**：`scripts/reset-github-release.cjs` 发布时会直接读取对应版本的 md 作为 GitHub Release Body。**禁止复制粘贴旧版本说明作为本次内容**，必须基于最近的实际改动和用户反馈重写。
3. **占位符检查**：脚本会扫描内容中是否出现 `TODO / TBD / 待填写 / 示例 / 样例`，一旦命中会拒绝发布，避免发布空白或占位说明。
4. **如果文件不存在**：脚本会在该目录下自动生成一个带 `TODO` 的骨架模板（并报错中止），按模板内容替换填写后再执行发布即可。

## 编写发布说明的信息源建议

- `git log v<上一版本>..HEAD --oneline` 看近期改动。
- 会话/工单中用户明确要求修复或新增的功能点。
- 本次修复的 Bug（尤其是导致回退的问题，必须明确写在说明里）。

## 示例结构

```md
# Hpp v<X.Y.Z> 发布说明

> 发布日期：YYYY-MM-DD
> 包含：Windows / Android / Linux（可选）

## 本次版本主要改动

### 桌面端
- ...

### 移动端
- ...

### 通用
- ...

## 下载

| 平台 | 文件名 |
|---|---|
| Windows (x64) | hpp-Setup-X.Y.Z.exe |
| Android | Hpp-Android.apk |

## 版本号
- 桌面端：X.Y.Z
- Android：versionName X.Y.Z，versionCode NNN
```

## 参考命令流程（一次完整的发布）

```powershell
# 1. 对齐三个版本号：package.json / mobile/package.json / mobile/android/app/build.gradle (versionCode + versionName)

# 2. 清理并执行完整构建
Remove-Item -Recurse -Force out, dist, release\vX.Y.Z -ErrorAction SilentlyContinue
npm run build

# 3. 打包并整理 Windows 安装包到 release\vX.Y.Z\
npm run dist:publish
# 注意：如果 dist:publish 在创建 release 阶段因为 tag 已存在失败，
# 先手动把 release\ 根目录的 hpp-Setup-*.exe / blockmap / latest.yml 复制到 release\vX.Y.Z\，
# 后续由 release:github 统一上传。

# 4. 打包 Release 签名 APK（会产出 Hpp-Android.apk 并写入 android-latest.json）
npm run mobile:release

# 5. 编辑本次版本说明（强制）
code release-notes\vX.Y.Z.md

# 6. 清理旧 tag / 旧 release 并重新上传所有产物 + 新说明
npm run release:github
```
