const AdmZip = require("adm-zip");
const {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} = require("fs");
const { isAbsolute, join, relative, resolve, sep } = require("path");

const MANIFEST_FILE = "hpp-agent-plugin.json";
const rootDir = resolve(__dirname, "..");
const sourceRoot = join(rootDir, "electron", "agent-plugins");
const outputRoot = join(rootDir, "release", "agent-plugins");
const releaseDownloadBaseUrl = "https://github.com/xhaoh94/Hpp/releases/latest/download";

const defaultCapabilities = {
  planMode: "prompt",
  guidance: false,
  fork: false,
  configuration: "none",
  providerActivation: "none",
};

function normalizeRelativePath(value, label) {
  const normalized = String(value || "").replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`${label} must be a relative path`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new Error(`${label} cannot contain parent directory segments`);
  }
  return parts.join("/");
}

function readManifest(pluginDir) {
  const manifestPath = join(pluginDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing ${MANIFEST_FILE} in ${pluginDir}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) throw new Error(`${pluginDir}: schemaVersion must be 1`);
  if (!manifest.id || typeof manifest.id !== "string") throw new Error(`${pluginDir}: missing id`);
  if (!manifest.name || typeof manifest.name !== "string") throw new Error(`${pluginDir}: missing name`);
  if (!manifest.version || typeof manifest.version !== "string") throw new Error(`${pluginDir}: missing version`);
  if (!manifest.entry || typeof manifest.entry !== "string") throw new Error(`${pluginDir}: missing entry`);
  if (!/^[a-zA-Z0-9._:-]+$/.test(manifest.id)) {
    throw new Error(`${pluginDir}: invalid id ${manifest.id}`);
  }

  const entry = normalizeRelativePath(manifest.entry, `${manifest.id} entry`);
  const entryPath = join(pluginDir, ...entry.split("/"));
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    throw new Error(`${pluginDir}: entry file not found: ${manifest.entry}`);
  }

  return manifest;
}

function normalizePlanMode(value) {
  return value === "native" || value === "prompt" || value === "none"
    ? value
    : defaultCapabilities.planMode;
}

function normalizeCapabilities(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    planMode: normalizePlanMode(input.planMode),
    guidance: input.guidance === true,
    fork: input.fork === true,
    configuration: input.configuration === "openai-compatible" ? "openai-compatible" : "none",
    providerActivation: input.providerActivation === "single-active" ? "single-active" : "none",
  };
}

function descriptorFromManifest(manifest) {
  const zipFile = `${manifest.id}.zip`;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: typeof manifest.description === "string" ? manifest.description : "",
    runtime: manifest.runtime === "cli" || manifest.runtime === "sdk" ? manifest.runtime : "plugin",
    command: typeof manifest.command === "string" ? manifest.command : undefined,
    packageName: typeof manifest.packageName === "string" ? manifest.packageName : undefined,
    capabilities: normalizeCapabilities(manifest.capabilities),
    zipFile,
    downloadUrl: `${releaseDownloadBaseUrl}/${zipFile}`,
  };
}

function zipPathFor(filePath, pluginDir) {
  const rel = relative(pluginDir, filePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing to package file outside plugin directory: ${filePath}`);
  }
  return rel.split(sep).join("/");
}

function addDirectory(zip, currentDir, pluginDir) {
  const entries = readdirSync(currentDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const entryPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      addDirectory(zip, entryPath, pluginDir);
    } else if (entry.isFile()) {
      zip.addFile(zipPathFor(entryPath, pluginDir), readFileSync(entryPath));
    }
  }
}

function main() {
  if (!existsSync(sourceRoot)) {
    throw new Error(`Agent plugin source directory not found: ${sourceRoot}`);
  }

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  const pluginDirs = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(sourceRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    plugins: [],
  };

  for (const pluginDir of pluginDirs) {
    const manifest = readManifest(pluginDir);
    const zip = new AdmZip();
    addDirectory(zip, pluginDir, pluginDir);
    const zipPath = join(outputRoot, `${manifest.id}.zip`);
    zip.writeZip(zipPath);
    catalog.plugins.push(descriptorFromManifest(manifest));
    console.log(`packaged ${manifest.id} -> ${zipPath}`);
  }

  const catalogPath = join(outputRoot, "agent-plugins.json");
  const orderedIds = ["codex", "pi", "opencode", "droid"];
  catalog.plugins.sort((left, right) => {
    const leftIndex = orderedIds.indexOf(left.id);
    const rightIndex = orderedIds.indexOf(right.id);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
    }
    return left.name.localeCompare(right.name);
  });
  require("fs").writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`wrote official plugin catalog -> ${catalogPath}`);
}

main();
