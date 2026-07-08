# Hpp Release Guide

本文档记录 Hpp 一键打包和发布到 GitHub Release 的规则。

## 发布入口

```bash
npm run release -- <version>
```

示例：

```bash
npm run release -- 0.0.2
```

脚本位置：

```text
scripts/release.mjs
```

## 默认发布流程

默认情况下，脚本适合本地开发完成后直接发版。

执行：

```bash
npm run release -- 0.0.2
```

脚本会按顺序执行：

1. 更新 `package.json` 和 `package-lock.json` 的版本号。
2. 清空旧的 `release/` 打包目录。
3. 执行 `npm run build`。
4. 构建通过后执行 `git add -A`。
5. 创建 release commit，提交信息为 `chore: release v0.0.2`。
6. push 当前分支到 `origin`。
7. 在 GitHub 创建 tag，例如 `v0.0.2`。
8. 执行 `electron-builder --publish always`。
9. 上传安装包、blockmap 和 `latest.yml` 到 GitHub Release。

也就是说，当前工作区里未提交的源码改动会默认一起进入 release commit。

## 版本号规则

版本号必须是 SemVer 格式：

```text
0.0.2
0.1.0
1.0.0
1.0.0-beta.1
```

脚本会自动给 Git tag 加 `v` 前缀：

```text
0.0.2 -> v0.0.2
```

## GitHub Token

正式发布需要 GitHub token。脚本会按顺序读取：

1. `GH_TOKEN`
2. `GITHUB_TOKEN`
3. `gh auth token`

Token 权限要求：

```text
Contents: Read and write
```

如果使用 fine-grained token，需要选择目标仓库 `xhaoh94/Hpp`。

PowerShell 临时设置：

```powershell
$env:GH_TOKEN="你的 token"
```

如果 token 已经写入 Windows 系统环境变量，但当前终端没有继承：

```powershell
$env:GH_TOKEN=[Environment]::GetEnvironmentVariable("GH_TOKEN","Machine")
```

用户级环境变量：

```powershell
$env:GH_TOKEN=[Environment]::GetEnvironmentVariable("GH_TOKEN","User")
```

也可以用 GitHub CLI：

```bash
gh auth login
```

## 常用命令

测试打包，不上传 GitHub，不提交：

```bash
npm run release -- 0.0.2 --dry-run
```

正式打包并发布：

```bash
npm run release -- 0.0.2
```

严格模式：如果发布前已经有未提交改动，就直接中止：

```bash
npm run release -- 0.0.2 --require-clean
```

只打包发布，不自动创建 release commit：

```bash
npm run release -- 0.0.2 --no-commit
```

查看帮助：

```bash
npm run release -- --help
```

## 参数说明

| 参数 | 说明 |
| --- | --- |
| `--dry-run` | 只构建安装包，不提交、不上传 GitHub Release。 |
| `--require-clean` | 发布前要求工作区没有任何已有改动。 |
| `--no-commit` | 不自动提交和推送 release commit。 |
| `--keep-release` | 打包前不清空已有的 `release/` 目录。 |
| `--help` | 显示帮助信息。 |

## release 目录规则

默认情况下，脚本会在打包前清空 `release/` 目录。

这样可以避免旧安装包、旧 `latest.yml` 或旧 `win-unpacked/` 影响本次产物。

如果需要保留已有产物，可以使用：

```bash
npm run release -- 0.0.2 --keep-release
```

注意：如果旧的 `release/win-unpacked` 正在被运行中的应用占用，打包可能因为文件锁失败。正常发布建议不要使用 `--keep-release`。

## 构建产物规则

`out/` 是构建产物，已在 `.gitignore` 中忽略。

`release/` 是安装包输出目录，也已在 `.gitignore` 中忽略。

正式产物以 GitHub Release 上传结果为准。

## GitHub Release 配置来源

发布目标读取自 `package.json` 的 `build.publish`：

```json
{
  "provider": "github",
  "owner": "xhaoh94",
  "repo": "Hpp",
  "releaseType": "release"
}
```

如果以后迁移仓库，需要同步修改这里。

## 下载源规则

脚本默认使用 Electron 国内镜像下载依赖：

```text
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

如果当前环境已经设置了同名环境变量，脚本会优先使用外部环境变量。

## 常见问题

### Missing GitHub token

说明当前 shell 进程没有读到 GitHub token，也没有通过 `gh auth token` 读取到 token。

处理方式：

```powershell
$env:GH_TOKEN="你的 token"
```

或者：

```bash
gh auth login
```

如果刚刚修改了系统环境变量，需要重新打开终端或重启应用，让新环境变量进入当前进程。

### Working tree is not clean

只有使用 `--require-clean` 时才会出现。

默认发布不要求工作区干净，会把当前改动一起提交到 release commit。

### Published releases must have a valid tag

说明 GitHub Release 需要对应 tag。

当前脚本会在发布前自动检查并创建 tag。如果仍然出现该错误，优先检查：

1. 当前分支是否已经 push。
2. Token 是否有 `Contents: Read and write`。
3. 目标仓库是否是 `xhaoh94/Hpp`。

### GitHub tag already points to another commit

说明远端已经存在同名 tag，并且指向的 commit 不是当前 `HEAD`。

不要直接覆盖 tag。建议换一个新版本号重新发布。

### EPERM rename release/win-unpacked

通常是旧的打包产物正在被占用。

处理方式：

1. 关闭正在运行的打包版 Hpp。
2. 不使用 `--keep-release`。
3. 删除 `release/` 后重新执行发布命令。
