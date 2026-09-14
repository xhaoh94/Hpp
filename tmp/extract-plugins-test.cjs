const AdmZip = require("adm-zip");
const { existsSync, mkdirSync, readdirSync } = require("fs");
const { join } = require("path");

const installRoot = "C:/Users/xhaoh/AppData/Roaming/hpp/hpp-data/agent-plugins";
const sourceDir = "C:/Project/Hpp/release/v0.1.3/agent-plugins";

if (!existsSync(sourceDir)) {
  throw new Error(`源目录不存在: ${sourceDir}`);
}
if (!existsSync(installRoot)) {
  throw new Error(`安装目录不存在: ${installRoot}（请先安装并运行一次 hpp 以生成 userData）`);
}

const zips = readdirSync(sourceDir).filter((f) => f.endsWith(".zip"));
if (zips.length === 0) throw new Error("没有找到插件 zip");

for (const zipFile of zips) {
  const id = zipFile.replace(/\.zip$/, "");
  const target = join(installRoot, id);
  mkdirSync(target, { recursive: true });
  const zip = new AdmZip(join(sourceDir, zipFile));
  zip.extractAllTo(target, true /* overwrite */);
  console.log(`已覆盖插件 ${id} -> ${target}`);
}
console.log(`完成，共注入 ${zips.length} 个插件。`);
