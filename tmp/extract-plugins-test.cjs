// 把 release/v<version>/agent-plugins/*.zip 解压覆盖到运行期插件安装目录。
// 版本号取自 package.json，避免每次手改。
const AdmZip = require("adm-zip");
const { existsSync, mkdirSync, readdirSync } = require("fs");
const { join, resolve } = require("path");

const rootDir = resolve(__dirname, "..");
const version = require(join(rootDir, "package.json")).version;
const sourceDir = join(rootDir, "release", `v${version}`, "agent-plugins");
const installRoot = join(process.env.APPDATA || "", "hpp", "hpp-data", "agent-plugins");

if (!existsSync(sourceDir)) throw new Error(`源目录不存在: ${sourceDir}`);
if (!existsSync(installRoot)) {
  throw new Error(`安装目录不存在: ${installRoot}（请先安装并运行一次 hpp 以生成 userData）`);
}

const zips = readdirSync(sourceDir).filter((f) => f.endsWith(".zip"));
if (zips.length === 0) throw new Error(`没有找到插件 zip: ${sourceDir}`);

for (const zipFile of zips) {
  const id = zipFile.replace(/\.zip$/, "");
  const target = join(installRoot, id);
  mkdirSync(target, { recursive: true });
  new AdmZip(join(sourceDir, zipFile)).extractAllTo(target, true /* overwrite */);
  console.log(`已覆盖插件 ${id} -> ${target}`);
}
console.log(`完成（v${version}），共注入 ${zips.length} 个插件。`);
