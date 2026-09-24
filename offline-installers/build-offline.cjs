"use strict";
// 构建 Windows x64 离线包：Codex CLI + Pi SDK/CLI + 便携 Node.js（自包含，目标机无需 npm/Node）。
// 规格见 docs/offline-cli-packaging.md。版本可用环境变量覆盖：CODEX_VERSION / PI_VERSION / NODE_VERSION。
// 产物：release/codex-pi-offline-win-x64-<codex>-<pi>.zip 及同名 .sha256。
// 注意：install.ps1 必须是纯 ASCII（PowerShell 5.1 按 ANSI 解码无 BOM UTF-8 会乱码报错）。

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } = fs;
const { dirname, join, resolve } = require("node:path");
const AdmZip = require("adm-zip");

const ROOT = resolve(__dirname, "..");
const RELEASE_DIR = join(ROOT, "release");

const CODEX_VERSION = process.env.CODEX_VERSION || "0.156.1";
const PI_VERSION = process.env.PI_VERSION || "0.87.1";
const NODE_VERSION = process.env.NODE_VERSION || "24.12.0";

const STAMP = new Date().toISOString().slice(0, 10);
const STAGE_NAME = `codex-pi-offline-win-x64-latest-${STAMP}`;
const STAGE_DIR = join(RELEASE_DIR, STAGE_NAME);
const APP_DIR = join(STAGE_DIR, "app");
const RUNTIME_DIR = join(STAGE_DIR, "runtime");
const ZIP_PATH = join(RELEASE_DIR, `codex-pi-offline-win-x64-${CODEX_VERSION}-${PI_VERSION}.zip`);
// GNU tar 不支持 `-a` 打 zip；必须用 Windows 自带的 bsdtar。
const WINDOWS_TAR = "C:\\Windows\\System32\\tar.exe";

const CODEX_ENTRY = join("node_modules", "@openai", "codex", "bin", "codex.js");
const PI_ENTRY = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

const log = (msg) => console.log(`[offline] ${msg}`);
const fail = (msg) => { throw new Error(msg); };

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error) fail(`执行失败 ${cmd}: ${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} 退出码 ${res.status}（args: ${args.join(" ")})`);
}

function writeAppPackageJson() {
  const pkg = {
    dependencies: {
      "@earendil-works/pi-coding-agent": PI_VERSION,
      "@openai/codex": CODEX_VERSION,
    },
  };
  writeFileSync(join(APP_DIR, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

function canSpawnChildren() {
  const probe = spawnSync(process.execPath, ["--version"], { encoding: "utf8" });
  return !probe.error;
}

function installAppDeps() {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  // 不要用 --ignore-scripts：Codex 的 win32 原生包走可选依赖，跳过会缺可执行文件。
  const args = ["install", "--omit=dev", "--no-audit", "--no-fund"];
  if (!canSpawnChildren()) {
    // 沙箱里 node 不能创建子进程时，包的生命周期脚本（典型是 esbuild 校验二进制）会 EBUSY。
    // codex/pi 自身无 install 脚本、原生二进制走可选依赖，跳过脚本不影响本包产物。
    log("检测到无法创建子进程（EBUSY），改用 --ignore-scripts 安装");
    args.push("--ignore-scripts");
  }
  log(`安装生产依赖（codex ${CODEX_VERSION} / pi ${PI_VERSION}）…`);
  run(npmCmd, args, {
    cwd: APP_DIR,
    shell: process.platform === "win32",
  });
  // 与既有产物保持一致：不把锁文件带进离线包。
  rmSync(join(APP_DIR, "package-lock.json"), { force: true });
}

function verifyAppDeps() {
  const checks = [
    [CODEX_ENTRY, "Codex 入口"],
    [PI_ENTRY, "Pi 入口"],
    [join("node_modules", "@openai", "codex-win32-x64"), "Codex win32 原生包"],
  ];
  for (const [rel, label] of checks) {
    if (!existsSync(join(APP_DIR, rel))) fail(`缺少${label}: app/${rel}`);
  }
  log("依赖校验通过");
}

async function downloadNodeRuntime() {
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;
  log(`下载 Node 运行时 ${url}`);
  const res = await fetch(url);
  if (!res.ok) fail(`下载 Node 失败：${res.status} ${res.statusText}`);
  const tmpZip = join(RELEASE_DIR, `.node-runtime-${NODE_VERSION}.zip`);
  writeFileSync(tmpZip, Buffer.from(await res.arrayBuffer()));

  const zip = new AdmZip(tmpZip);
  const prefix = `node-v${NODE_VERSION}-win-x64/`;
  let count = 0;
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith(prefix)) continue;
    const rel = entry.entryName.slice(prefix.length);
    if (!rel) continue;
    const dest = join(RUNTIME_DIR, rel);
    if (entry.isDirectory) { mkdirSync(dest, { recursive: true }); continue; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.getData());
    count += 1;
  }
  rmSync(tmpZip, { force: true });
  if (!existsSync(join(RUNTIME_DIR, "node.exe"))) fail("runtime/node.exe 缺失");
  log(`Node 运行时解压完成（${count} 个文件）`);
}

function writeEntryScripts() {
  writeFileSync(join(STAGE_DIR, "codex.cmd"),
    `@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0app\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`, "utf8");
  writeFileSync(join(STAGE_DIR, "pi.cmd"),
    `@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0app\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n`, "utf8");

  // ASCII-only，勿加中文。
  const installPs1 = [
    "param(",
    '    [string]$InstallDir = "$env:LOCALAPPDATA\\Programs\\CodexPiCLI",',
    '    [string]$HppDataDir = "$env:APPDATA\\hpp\\hpp-data",',
    "    [switch]$NoPath,",
    "    [switch]$SkipHppSDK",
    ")",
    "",
    '$ErrorActionPreference = "Stop"',
    "$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path",
    "",
    '$nodeExe = Join-Path $ScriptDir "runtime\\node.exe"',
    '$codexEntry = Join-Path $ScriptDir "app\\node_modules\\@openai\\codex\\bin\\codex.js"',
    '$piEntry = Join-Path $ScriptDir "app\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js"',
    "",
    "if (-not (Test-Path $nodeExe)) {",
    '    Write-Error "runtime\\node.exe not found"',
    "    exit 1",
    "}",
    "if (-not (Test-Path $codexEntry)) {",
    '    Write-Error "Codex entry not found"',
    "    exit 1",
    "}",
    "if (-not (Test-Path $piEntry)) {",
    '    Write-Error "Pi entry not found"',
    "    exit 1",
    "}",
    "",
    "if (-not (Test-Path $InstallDir)) {",
    "    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null",
    "}",
    "",
    'Write-Host "Installing to $InstallDir ..."',
    'robocopy /E /NFL /NDL /NJH /NJS /NC /NS /NP /R:0 "$ScriptDir\\runtime" "$InstallDir\\runtime"',
    "if ($LASTEXITCODE -ge 8) {",
    '    Write-Error "Failed to copy runtime"',
    "    exit 1",
    "}",
    'robocopy /E /NFL /NDL /NJH /NJS /NC /NS /NP /R:0 "$ScriptDir\\app" "$InstallDir\\app"',
    "if ($LASTEXITCODE -ge 8) {",
    '    Write-Error "Failed to copy app"',
    "    exit 1",
    "}",
    'Copy-Item "$ScriptDir\\codex.cmd" "$InstallDir\\codex.cmd" -Force',
    'Copy-Item "$ScriptDir\\pi.cmd" "$InstallDir\\pi.cmd" -Force',
    "",
    "if (-not $SkipHppSDK) {",
    '    $hppSdkDir = Join-Path $HppDataDir "pi-sdk-runtime"',
    "    if (-not (Test-Path $hppSdkDir)) {",
    "        New-Item -ItemType Directory -Path $hppSdkDir -Force | Out-Null",
    "    }",
    '    Write-Host "Deploying Hpp Pi SDK to $hppSdkDir ..."',
    '    robocopy /E /NFL /NDL /NJH /NJS /NC /NS /NP /R:0 "$ScriptDir\\app" "$hppSdkDir"',
    "    if ($LASTEXITCODE -ge 8) {",
    '        Write-Error "Failed to copy Hpp Pi SDK"',
    "        exit 1",
    "    }",
    "",
    '    $piPackageJson = Join-Path $hppSdkDir "node_modules\\@earendil-works\\pi-coding-agent\\package.json"',
    "    if (Test-Path $piPackageJson) {",
    "        $piPackage = Get-Content $piPackageJson | ConvertFrom-Json",
    '        Write-Host "Hpp Pi SDK installed: $($piPackage.version)"',
    "    }",
    "}",
    "",
    "if (-not $NoPath) {",
    '    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")',
    '    if ($currentPath -notlike "*$InstallDir*") {',
    '        [Environment]::SetEnvironmentVariable("Path", "$currentPath;$InstallDir", "User")',
    '        Write-Host "Added $InstallDir to user PATH"',
    "    }",
    "}",
    "",
    'Write-Host "Verifying installation..."',
    '& "$InstallDir\\codex.cmd" --version',
    '& "$InstallDir\\pi.cmd" --version',
    "",
    'Write-Host "Installation complete!"',
  ].join("\r\n");
  writeFileSync(join(STAGE_DIR, "install.ps1"), `${installPs1}\r\n`, "utf8");

  writeFileSync(join(STAGE_DIR, "VERSIONS.txt"),
    `Codex CLI: ${CODEX_VERSION}\nPi SDK/CLI: ${PI_VERSION}\nNode.js: ${NODE_VERSION}\n`, "utf8");

  const readme = [
    "Codex CLI + Pi SDK/CLI 离线包",
    "=============================",
    "",
    "版本：",
    `- Codex CLI: ${CODEX_VERSION}`,
    `- Pi SDK/CLI: ${PI_VERSION}`,
    `- Node.js: ${NODE_VERSION}`,
    "",
    "安装方法：",
    "1. 解压此 ZIP 文件",
    "2. 在解压目录打开 PowerShell",
    "3. 执行：powershell -ExecutionPolicy Bypass -File .\\install.ps1",
    "",
    "可选参数：",
    "- -InstallDir: 指定 CLI 安装目录（默认：$env:LOCALAPPDATA\\Programs\\CodexPiCLI）",
    "- -HppDataDir: 指定 Hpp 数据目录（默认：$env:APPDATA\\hpp\\hpp-data）",
    "- -NoPath: 不修改用户 PATH",
    "- -SkipHppSDK: 只安装便携 CLI，不部署 Hpp Pi SDK",
    "",
    "便携运行：",
    ".\\codex.cmd --version",
    ".\\pi.cmd --version",
    "",
  ].join("\r\n");
  writeFileSync(join(STAGE_DIR, "README.txt"), readme, "utf8");
}

function packZip() {
  if (!existsSync(WINDOWS_TAR)) fail(`找不到 Windows tar: ${WINDOWS_TAR}`);
  rmSync(ZIP_PATH, { force: true });
  log(`打包 ZIP ${ZIP_PATH}`);
  run(WINDOWS_TAR, ["-a", "-cf", ZIP_PATH, "-C", RELEASE_DIR, STAGE_NAME]);
  if (!existsSync(ZIP_PATH)) fail("ZIP 未生成");
}

async function writeSha256() {
  const hash = createHash("sha256");
  await new Promise((res, rej) => {
    createReadStream(ZIP_PATH).on("data", (d) => hash.update(d)).on("end", res).on("error", rej);
  });
  const hex = hash.digest("hex").toUpperCase();
  writeFileSync(`${ZIP_PATH}.sha256`, `SHA-256: ${hex}\n`, "utf8");
  log(`SHA-256: ${hex}`);
}

async function main() {
  log(`版本：Codex ${CODEX_VERSION} / Pi ${PI_VERSION} / Node ${NODE_VERSION}`);
  log(`staging: ${STAGE_DIR}`);
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(APP_DIR, { recursive: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });

  writeAppPackageJson();
  installAppDeps();
  verifyAppDeps();
  await downloadNodeRuntime();
  writeEntryScripts();
  packZip();
  await writeSha256();
  log("完成");
}

main().catch((error) => {
  console.error(`[offline] 失败：${error?.stack || error}`);
  process.exitCode = 1;
});
