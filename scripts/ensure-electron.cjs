/*
 * Electron downloads its platform binary from its npm install lifecycle.
 * This guard makes a plain `npm install` self-healing when that lifecycle was
 * interrupted or a previous install left node_modules/electron incomplete.
 */
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const electronRoot = join(__dirname, "..", "node_modules", "electron");
const packageJsonPath = join(electronRoot, "package.json");

if (!existsSync(packageJsonPath)) {
  console.log("[ensure-electron] electron is not installed; npm will handle it.");
  process.exit(0);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const platformPathByPlatform = {
  win32: "electron.exe",
  linux: "electron",
  freebsd: "electron",
  openbsd: "electron",
  darwin: join("Electron.app", "Contents", "MacOS", "Electron"),
};
const platformPath = existsSync(join(electronRoot, "path.txt"))
  ? readFileSync(join(electronRoot, "path.txt"), "utf8").trim()
  : platformPathByPlatform[process.platform];
const binaryPath = platformPath ? join(electronRoot, "dist", platformPath) : undefined;

if (binaryPath && existsSync(binaryPath)) {
  console.log(`[ensure-electron] Electron ${packageJson.version} is ready.`);
  process.exit(0);
}

const installer = join(electronRoot, "install.js");
if (!existsSync(installer)) {
  console.error("[ensure-electron] Electron install.js is missing. Run npm install again.");
  process.exit(1);
}

console.log(`[ensure-electron] Electron ${packageJson.version} binary is missing; downloading it now...`);
const result = spawnSync(process.execPath, [installer], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error("[ensure-electron] Electron download failed. Check network, npm cache, or ELECTRON_MIRROR.");
  process.exit(result.status || 1);
}

console.log(`[ensure-electron] Electron ${packageJson.version} is ready.`);
