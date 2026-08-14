// 把项目图标嵌入开发模式的 electron.exe（复用 electron-winstaller 自带的 rcedit）。
// 开发模式下任务栏/Alt-Tab 等界面会按 exe 路径缓存图标，而 electron.exe 内嵌的
// 是 Electron 默认原子图标；一旦 Windows 重建图标缓存，默认图标就会"复活"。
// 把 exe 内嵌图标换成 Hpp 图标后，即使缓存重建也拿到正确的图标。
// postinstall 自动执行，Electron 版本更新（exe 被替换）后也会自动重新打补丁。
const { existsSync } = require("fs");
const { execFileSync } = require("child_process");
const { resolve } = require("path");

const root = resolve(__dirname, "..");
const rcedit = resolve(root, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");
const electronExe = resolve(root, "node_modules", "electron", "dist", "electron.exe");
const icon = resolve(root, "public", "icon.ico");

if (!existsSync(rcedit) || !existsSync(electronExe) || !existsSync(icon)) {
  console.log("[patch-dev-electron-icon] skipped (rcedit / electron.exe / icon.ico missing)");
  process.exit(0);
}

try {
  execFileSync(rcedit, [electronExe, "--set-icon", icon], { stdio: "inherit" });
  console.log("[patch-dev-electron-icon] electron.exe icon patched:", icon);
} catch (error) {
  // 不阻塞 npm install；失败时开发图标退回旧行为（需要手动清图标缓存）。
  console.warn("[patch-dev-electron-icon] failed:", error instanceof Error ? error.message : error);
}
