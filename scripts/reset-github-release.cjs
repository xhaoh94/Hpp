const { createReadStream, existsSync, readFileSync, statSync, mkdirSync, readdirSync } = require("fs");
const { basename, join, resolve } = require("path");
const https = require("https");

const owner = "xhaoh94";
const repo = "Hpp";
const version = require("../package.json").version;
const tag = `v${version}`;
const releaseDir = resolve("release", tag);
const releaseNotesPath = resolve("docs", "release-notes", `${tag}.md`);
const token = process.env.GH_TOKEN;

if (!token) throw new Error("GH_TOKEN is required.");

// ---- Validate release notes ----
if (!existsSync(releaseNotesPath)) {
  mkdirSync(resolve("docs", "release-notes"), { recursive: true });
  const template = [
    `# Hpp ${tag} 发布说明`,
    "",
    "> 每次发布前必须基于最近改动重新编辑此文件。",
    "> 禁止复用旧版本说明。修改完成后再执行发布命令。",
    "",
    "## 本次版本主要改动",
    "",
    "- TODO: 根据最近提交和用户反馈逐项填写。",
    "",
  ].join("\n");
  throw new Error(
    `Release notes not found: ${releaseNotesPath}. ` +
    `A skeleton template was created. Fill it with actual changes for ${tag}, then rerun.`
  );
}
const releaseNotes = readFileSync(releaseNotesPath, "utf8").replace(/\r\n/g, "\n").trim();
if (!releaseNotes) throw new Error("Release notes is empty.");
if (/TODO|TBD|待填写|示例|样例/.test(releaseNotes)) {
  throw new Error("Release notes still contains placeholder text (TODO/TBD/etc). Replace with actual changes.");
}

// ---- HTTP helpers ----
const apiHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "hpp-release-tool",
  "X-GitHub-Api-Version": "2022-11-28",
};

function requestJson(method, path, body) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = https.request({
      hostname: "api.github.com",
      method,
      path,
      headers: {
        ...apiHeaders,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
      },
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${method} ${path} HTTP ${response.statusCode}: ${text.slice(0, 500)}`));
          return;
        }
        resolvePromise(text ? JSON.parse(text) : undefined);
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function uploadFile(uploadUrl, filePath, contentType, label) {
  return new Promise((resolvePromise, reject) => {
    const fileName = basename(filePath);
    const url = new URL(uploadUrl.replace("{?name,label}", ""));
    url.searchParams.set("name", fileName);
    if (label) url.searchParams.set("label", label);
    const size = statSync(filePath).size;
    const request = https.request({
      hostname: url.hostname,
      method: "POST",
      path: `${url.pathname}${url.search}`,
      headers: {
        ...apiHeaders,
        "Content-Type": contentType,
        "Content-Length": size,
      },
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Upload ${fileName} HTTP ${response.statusCode}: ${text.slice(0, 500)}`));
          return;
        }
        resolvePromise(JSON.parse(text));
      });
    });
    request.on("error", reject);
    createReadStream(filePath).pipe(request);
  });
}

// ---- Main ----
async function main() {
  // 1. Find or create the release (NON-destructive!)
  let release;
  try {
    release = await requestJson("GET", `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    console.log(`Found existing release ${tag}, id=${release.id}`);
  } catch (e) {
    console.log(`Release ${tag} not found, creating...`);
    release = await requestJson("POST", `/repos/${owner}/${repo}/releases`, {
      tag_name: tag,
      target_commitish: "main",
      name: `Hpp ${tag}`,
      body: releaseNotes,
      draft: false,
      prerelease: false,
      make_latest: "true",
    });
    console.log(`Created release ${tag}, id=${release.id}`);
  }

  // 2. Update release body (notes) — always sync from local file
  console.log("Updating release notes...");
  release = await requestJson("PATCH", `/repos/${owner}/${repo}/releases/${release.id}`, {
    body: releaseNotes,
    name: `Hpp ${tag}`,
  });

  // 3. Gather local assets
  const androidMetadataPath = join(releaseDir, "android-latest.json");
  const androidMetadata = existsSync(androidMetadataPath)
    ? JSON.parse(readFileSync(androidMetadataPath, "utf8"))
    : null;

  const pluginDir = join(releaseDir, "agent-plugins");
  let pluginAssets = [];
  if (existsSync(pluginDir)) {
    pluginAssets = readdirSync(pluginDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (entry.name.endsWith(".zip") || entry.name === "agent-plugins.json"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => [
        join(pluginDir, entry.name),
        entry.name.endsWith(".zip") ? "application/zip" : "application/json",
      ]);
  }

  const localAssets = [
    [join(releaseDir, `hpp-Setup-${version}.exe`), "application/vnd.microsoft.portable-executable"],
    [join(releaseDir, `hpp-Setup-${version}.exe.blockmap`), "application/octet-stream"],
    [join(releaseDir, "latest.yml"), "text/yaml"],
    ...(androidMetadata ? [[
      join(releaseDir, "Hpp-Android.apk"),
      "application/vnd.android.package-archive",
      `hpp-version-code:${androidMetadata.versionCode}`,
    ], [androidMetadataPath, "application/json"]] : []),
    ...pluginAssets,
  ];

  const preparedAssets = localAssets
    .filter(([p]) => existsSync(p))
    .map(([p, ct, label]) => ({ filePath: resolve(p), contentType: ct, label, size: statSync(resolve(p)).size }));

  if (preparedAssets.length === 0) {
    console.warn(`No assets found in ${releaseDir}. Build first!`);
    return;
  }
  console.log(`Found ${preparedAssets.length} assets to upload.`);

  // 4. Get existing release asset IDs for deletion (to avoid duplicates)
  const existingAssetIds = new Map();
  for (const asset of (release.assets || [])) {
    existingAssetIds.set(asset.name, asset.id);
  }

  // 5. Upload each asset (delete old one with same name first if exists)
  for (const { filePath, contentType, label, size } of preparedAssets) {
    const fileName = basename(filePath);
    console.log(`Uploading ${fileName} (${size.toLocaleString()} bytes)...`);

    // Delete existing asset with same name to avoid duplicates
    const existingId = existingAssetIds.get(fileName);
    if (existingId) {
      console.log(`  Replacing existing asset (id=${existingId})`);
      try {
        await requestJson("DELETE", `/repos/${owner}/${repo}/releases/assets/${existingId}`);
      } catch (e) {
        console.warn(`  Warning: could not delete old asset: ${e.message}`);
      }
    }

    await uploadFile(release.upload_url, filePath, contentType, label);
    console.log(`  Done.`);
  }

  console.log(`\nPublished: ${release.html_url}`);
  console.log(`Tag: ${tag} | Assets: ${preparedAssets.length}`);
}

main().catch((error) => {
  console.error("ERROR:", error.message);
  process.exitCode = 1;
});
