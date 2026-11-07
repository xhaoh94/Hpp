const AdmZip = require("adm-zip");
const { createHash } = require("crypto");
const {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("fs");
const { isAbsolute, join, relative, resolve, sep } = require("path");

const MANIFEST_FILE = "hpp-agent-plugin.json";
const rootDir = resolve(__dirname, "..");
const sourceRoot = join(rootDir, "electron", "agent-plugins");
// 插件内容指纹基线（随仓库提交）。用于拦住“改了插件代码但没提 manifest version”
// 的情况：客户端的更新判断只比较 version，版本相同就永远不会重新拉取 zip，
// 于是修好的插件发到 GitHub 也到不了已安装的用户手上。
const HASH_BASELINE_FILE = join(sourceRoot, "content-hashes.json");
const releaseDownloadBaseUrl = "https://github.com/xhaoh94/Hpp/releases/latest/download";
const currentHppVersion = require(join(rootDir, "package.json")).version;
const outputRoot = join(rootDir, "release", `v${currentHppVersion}`, "agent-plugins");

const defaultCapabilities = {
  planMode: "prompt",
  permissions: false,
  guidance: false,
  fork: false,
  actions: false,
  configuration: "none",
  providerActivation: "none",
  compaction: "none",
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
        ? [...new Set(modelDefaults.supportedThinkingLevels
            .filter((level) => typeof level === "string")
            .map((level) => level.trim())
            .filter(Boolean))]
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

function normalizeCompactionCapabilities(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!input) return "none";
  const customModel = input.customModel === true;
  const thinkingLevel = input.thinkingLevel === true;
  const toggle = input.toggle === true;
  const channelModel = input.channelModel === true;
  return customModel || thinkingLevel || toggle || channelModel
    ? { customModel, thinkingLevel, toggle, channelModel }
    : "none";
}

function normalizeCapabilities(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    planMode: normalizePlanMode(input.planMode),
    permissions: input.permissions === true,
    guidance: input.guidance === true,
    fork: input.fork === true,
    actions: input.actions === true,
    configuration: normalizeProviderConfiguration(input.configuration),
    providerActivation: input.providerActivation === "single-active" ? "single-active" : "none",
    compaction: normalizeCompactionCapabilities(input.compaction),
  };
}

function descriptorFromManifest(manifest, contentHash) {
  const zipFile = `${manifest.id}.zip`;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    // 内容指纹随目录一起发布，供客户端做“版本相同但内容不同”的兜底判断。
    ...(contentHash ? { contentHash } : {}),
    minHppVersion: manifest.minHppVersion,
    description: typeof manifest.description === "string" ? manifest.description : "",
    runtime: manifest.runtime === "cli" || manifest.runtime === "sdk" ? manifest.runtime : "plugin",
    command: typeof manifest.command === "string" ? manifest.command : undefined,
    packageName: typeof manifest.packageName === "string" ? manifest.packageName : undefined,
    // 同一条命令可能对应多个 npm 包（OpenCode 1.x/2.x），目录里要透传，否则
    // 从官方插件列表安装后，更新/卸载会退化成只认 packageName。
    packages: Array.isArray(manifest.packages)
      ? manifest.packages.filter((entry) => (
        entry
        && typeof entry === "object"
        && (entry.line === "v1" || entry.line === "v2")
        && typeof entry.name === "string"
      )).map((entry) => ({
        line: entry.line,
        name: entry.name,
        ...(typeof entry.label === "string" ? { label: entry.label } : {}),
      }))
      : undefined,
    order: typeof manifest.order === "number" && Number.isFinite(manifest.order) ? manifest.order : 1000,
    installHint: typeof manifest.installHint === "string" ? manifest.installHint : undefined,
    updateCommand: typeof manifest.updateCommand === "string" ? manifest.updateCommand : undefined,
    shortName: typeof manifest.shortName === "string" ? manifest.shortName : undefined,
    capabilities: normalizeCapabilities(manifest.capabilities),
    zipFile,
    downloadUrl: `${releaseDownloadBaseUrl}/${zipFile}`,
  };
}

/**
 * 计算插件的确定性内容指纹。
 * 覆盖的文件集合必须与写进 zip 的一致（同样跳过 *.test.*），
 * 否则会出现“指纹变了但 zip 没变”的误报。
 */
function computeContentHash(pluginDir) {
  const hash = createHash("sha256");
  const walk = (currentDir) => {
    const entries = readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/\.test\.[cm]?[jt]s$/i.test(entry.name)) continue;
      hash.update(zipPathFor(entryPath, pluginDir));
      hash.update("\0");
      hash.update(readFileSync(entryPath));
      hash.update("\0");
    }
  };
  walk(pluginDir);
  return hash.digest("hex");
}

function readHashBaseline() {
  if (!existsSync(HASH_BASELINE_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(HASH_BASELINE_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`${HASH_BASELINE_FILE}: 不是有效 JSON（${error instanceof Error ? error.message : error}）`);
  }
}

/**
 * 找出“内容变了但版本没提”的插件。
 * 纯函数，方便直接单测：传入基线、本次指纹与清单。
 */
function detectVersionDrift(baseline, entries) {
  const drifted = [];
  for (const entry of entries) {
    const previous = baseline[entry.id];
    if (previous && previous.hash !== entry.hash && previous.version === entry.version) {
      drifted.push({ id: entry.id, version: entry.version });
    }
  }
  return drifted;
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

  // 第一遍：读取 manifest 并校验内容指纹，发现“内容变了但版本没提”就整体中止，
  // 避免产出一份客户端永远收不到的 zip。
  const baseline = readHashBaseline();
  const nextBaseline = {};
  const plans = [];
  for (const pluginDir of pluginDirs) {
    const manifest = readManifest(pluginDir);
    const contentHash = computeContentHash(pluginDir);
    nextBaseline[manifest.id] = { version: manifest.version, hash: contentHash };
    plans.push({ pluginDir, manifest, contentHash });
  }
  const drifted = detectVersionDrift(baseline, plans.map((plan) => ({
    id: plan.manifest.id,
    version: plan.manifest.version,
    hash: plan.contentHash,
  })));
  if (drifted.length > 0) {
    throw new Error(
      "插件内容有改动但 manifest version 未提升，已中止打包：\n"
      + `${drifted.map((entry) => `  ${entry.id}: 内容已变更，但 version 仍是 ${entry.version}`).join("\n")}\n`
      + `请提升 electron/agent-plugins/<id>/${MANIFEST_FILE} 里的 version 后重试`
      + "（客户端只比较版本号，版本不变就收不到更新）。",
    );
  }

  const catalog = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    plugins: [],
  };

  for (const { pluginDir, manifest, contentHash } of plans) {
    const zip = new AdmZip();
    addDirectory(zip, pluginDir, pluginDir);
    const zipPath = join(outputRoot, `${manifest.id}.zip`);
    zip.writeZip(zipPath);
    catalog.plugins.push(descriptorFromManifest(manifest, contentHash));
    console.log(`packaged ${manifest.id} -> ${zipPath}`);
  }

  // 一次性写回基线，保持与本次产物一致。
  writeFileSync(HASH_BASELINE_FILE, `${JSON.stringify(nextBaseline, null, 2)}\n`);
  console.log(`wrote plugin content hashes -> ${HASH_BASELINE_FILE}`);

  const catalogPath = join(outputRoot, "agent-plugins.json");
  catalog.plugins.sort((left, right) => {
    return left.order - right.order || left.name.localeCompare(right.name);
  });
  require("fs").writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`wrote official plugin catalog -> ${catalogPath}`);
}

// 被单测 require 时不要自动执行打包。
if (require.main === module) {
  main();
}

module.exports = { computeContentHash, detectVersionDrift, readHashBaseline, HASH_BASELINE_FILE };
