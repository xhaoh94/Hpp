const AdmZip = require("adm-zip");
const { existsSync, mkdirSync, readdirSync, readFileSync } = require("fs");
const { join, relative, resolve, sep } = require("path");

const rootDir = resolve(__dirname, "..");
const pluginDir = join(rootDir, "electron", "agent-plugins", "pi");
const manifest = JSON.parse(readFileSync(join(pluginDir, "hpp-agent-plugin.json"), "utf8"));

if (manifest.schemaVersion !== 3 || manifest.id !== "pi" || !manifest.version) {
  throw new Error("pi plugin manifest is invalid (schemaVersion/id/version)");
}
if (!existsSync(join(pluginDir, manifest.entry))) {
  throw new Error(`pi plugin entry is missing: ${manifest.entry}`);
}

const hppVersion = require(join(rootDir, "package.json")).version;
const outputDir = join(rootDir, "release", `v${hppVersion}`);
mkdirSync(outputDir, { recursive: true });

const zip = new AdmZip();
const addDirectory = (dir) => {
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      addDirectory(full);
      continue;
    }
    if (!entry.isFile()) continue;
    // 与 package-agent-plugins.cjs 保持一致：测试文件不进包。
    if (/\.test\.[cm]?[jt]s$/i.test(entry.name)) continue;
    zip.addFile(relative(pluginDir, full).split(sep).join("/"), readFileSync(full));
  }
};
addDirectory(pluginDir);

const outputPath = join(outputDir, `pi-${manifest.version}-offline.zip`);
zip.writeZip(outputPath);

console.log(`pi ${manifest.version} -> ${outputPath}`);
for (const entry of zip.getEntries()) console.log(`  ${entry.entryName}`);
