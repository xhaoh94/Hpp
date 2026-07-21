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
const releaseDownloadBaseUrl = "https://github.com/xhaoh94/Hpp/releases/latest/download";
const currentHppVersion = require(join(rootDir, "package.json")).version;
const outputRoot = join(rootDir, "release", `v${currentHppVersion}`, "agent-plugins");

const defaultCapabilities = {
  planMode: "prompt",
  guidance: false,
  fork: false,
  configuration: "none",
  providerActivation: "none",
};

function parseVersion(version) {
  const match = String(version || "").trim().match(/^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: match[1].split(".").map((part) => Number.parseInt(part, 10)),
    prerelease: match[2]
      ? match[2].split(".").map((part) => /^\d+$/.test(part) ? Number.parseInt(part, 10) : part)
      : null,
  };
}

function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left || !right) throw new Error(`Invalid version comparison: ${leftVersion}, ${rightVersion}`);
  const coreLength = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < coreLength; index += 1) {
    const difference = (left.core[index] || 0) - (right.core[index] || 0);
    if (difference !== 0) return difference;
  }
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart - rightPart;
    if (typeof leftPart === "number") return -1;
    if (typeof rightPart === "number") return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

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
  if (manifest.schemaVersion !== 3) throw new Error(`${pluginDir}: schemaVersion must be 3`);
  if (!manifest.id || typeof manifest.id !== "string") throw new Error(`${pluginDir}: missing id`);
  if (!manifest.name || typeof manifest.name !== "string") throw new Error(`${pluginDir}: missing name`);
  if (!manifest.version || typeof manifest.version !== "string") throw new Error(`${pluginDir}: missing version`);
  if (!parseVersion(manifest.version)) throw new Error(`${pluginDir}: invalid version ${manifest.version}`);
  if (!manifest.minHppVersion || typeof manifest.minHppVersion !== "string") {
    throw new Error(`${pluginDir}: missing minHppVersion`);
  }
  if (!parseVersion(manifest.minHppVersion)) {
    throw new Error(`${pluginDir}: invalid minHppVersion ${manifest.minHppVersion}`);
  }
  if (compareVersions(currentHppVersion, manifest.minHppVersion) < 0) {
    throw new Error(`${pluginDir}: requires Hpp ${manifest.minHppVersion}, package version is ${currentHppVersion}`);
  }
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

function normalizeProviderConfiguration(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!input || input.type !== "provider" || !Array.isArray(input.endpoints)) return "none";
  const seenEndpoints = new Set();
  const endpoints = input.endpoints.flatMap((rawEndpoint) => {
    if (!rawEndpoint || typeof rawEndpoint !== "object" || Array.isArray(rawEndpoint)) return [];
    const id = String(rawEndpoint.id || "").trim();
    if (!id || seenEndpoints.has(id)) return [];
    seenEndpoints.add(id);
    return [{ id, label: String(rawEndpoint.label || id).trim() || id }];
  });
  if (endpoints.length === 0) return "none";
  const defaultEndpoint = String(input.defaultEndpoint || "").trim();
  const seenAuthModes = new Set();
  const authModes = Array.isArray(input.authModes)
    ? input.authModes.flatMap((rawAuthMode) => {
        if (!rawAuthMode || typeof rawAuthMode !== "object" || Array.isArray(rawAuthMode)) return [];
        const id = String(rawAuthMode.id || "").trim();
        if ((id !== "bearer" && id !== "x-api-key") || seenAuthModes.has(id)) return [];
        seenAuthModes.add(id);
        return [{ id, label: String(rawAuthMode.label || id).trim() || id }];
      })
    : [];
  const defaultAuthMode = String(input.defaultAuthMode || "").trim();
  const modelDefaults = input.modelDefaults && typeof input.modelDefaults === "object" && !Array.isArray(input.modelDefaults)
    ? input.modelDefaults
    : {};
  const modelListMode = input.modelListMode === "configured" || input.modelListMode === "backend"
    ? input.modelListMode
    : "merge";
  const rawBackendModelVisibility = input.backendModelVisibility
    && typeof input.backendModelVisibility === "object"
    && !Array.isArray(input.backendModelVisibility)
      ? input.backendModelVisibility
      : undefined;
  return {
    type: "provider",
    storage: input.storage === "plugin" ? "plugin" : "hpp",
    endpoints,
    defaultEndpoint: endpoints.some((endpoint) => endpoint.id === defaultEndpoint)
      ? defaultEndpoint
      : endpoints[0].id,
    authModes: authModes.length > 0 ? authModes : undefined,
    defaultAuthMode: authModes.some((mode) => mode.id === defaultAuthMode)
      ? defaultAuthMode
      : authModes[0]?.id,
    pathLabel: typeof input.pathLabel === "string" && input.pathLabel.trim() ? input.pathLabel.trim() : undefined,
    hint: typeof input.hint === "string" && input.hint.trim() ? input.hint.trim() : undefined,
    modelDefaults: {
      reasoning: modelDefaults.reasoning === true,
      imageInput: modelDefaults.imageInput === true,
      supportedThinkingLevels: Array.isArray(modelDefaults.supportedThinkingLevels)
        ? modelDefaults.supportedThinkingLevels.filter((level) =>
            typeof level === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(level))
        : undefined,
    },
    fixedModelCapabilities: input.fixedModelCapabilities === true,
    modelListMode,
    backendModelVisibility: modelListMode === "merge" && rawBackendModelVisibility
      ? {
          userConfigurable: rawBackendModelVisibility.userConfigurable === true,
          defaultVisible: rawBackendModelVisibility.defaultVisible !== false,
          label: typeof rawBackendModelVisibility.label === "string" && rawBackendModelVisibility.label.trim()
            ? rawBackendModelVisibility.label.trim()
            : "显示 Agent 内置模型",
          description: typeof rawBackendModelVisibility.description === "string" && rawBackendModelVisibility.description.trim()
            ? rawBackendModelVisibility.description.trim()
            : undefined,
        }
      : undefined,
  };
}

function normalizeCapabilities(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    planMode: normalizePlanMode(input.planMode),
    guidance: input.guidance === true,
    fork: input.fork === true,
    configuration: normalizeProviderConfiguration(input.configuration),
    providerActivation: input.providerActivation === "single-active" ? "single-active" : "none",
  };
}

function descriptorFromManifest(manifest) {
  const zipFile = `${manifest.id}.zip`;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    minHppVersion: manifest.minHppVersion,
    description: typeof manifest.description === "string" ? manifest.description : "",
    runtime: manifest.runtime === "cli" || manifest.runtime === "sdk" ? manifest.runtime : "plugin",
    command: typeof manifest.command === "string" ? manifest.command : undefined,
    packageName: typeof manifest.packageName === "string" ? manifest.packageName : undefined,
    order: typeof manifest.order === "number" && Number.isFinite(manifest.order) ? manifest.order : 1000,
    installHint: typeof manifest.installHint === "string" ? manifest.installHint : undefined,
    updateCommand: typeof manifest.updateCommand === "string" ? manifest.updateCommand : undefined,
    shortName: typeof manifest.shortName === "string" ? manifest.shortName : undefined,
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
      if (/\.test\.[cm]?[jt]s$/i.test(entry.name)) continue;
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
    schemaVersion: 2,
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
  catalog.plugins.sort((left, right) => {
    return left.order - right.order || left.name.localeCompare(right.name);
  });
  require("fs").writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`wrote official plugin catalog -> ${catalogPath}`);
}

main();
