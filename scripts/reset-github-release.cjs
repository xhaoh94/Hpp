const { createReadStream, existsSync, readFileSync, readdirSync, statSync, mkdirSync } = require("fs");
const { basename, join, resolve } = require("path");
const https = require("https");

const owner = "xhaoh94";
const repo = "Hpp";
const version = require("../package.json").version;
const tag = `v${version}`;
const releaseDir = resolve("release", tag);
const releaseNotesRoot = resolve("release-notes");
const releaseNotesPath = join(releaseNotesRoot, `${tag}.md`);
const token = process.env.GH_TOKEN;

if (!token) throw new Error("GH_TOKEN is required.");
if (!existsSync(releaseNotesPath)) {
  mkdirSync(releaseNotesRoot, { recursive: true });
  const template = [
    `# Hpp ${tag} 发布说明`,
    "",
    "> 每次发布前必须基于最近改动重新编辑此文件。发布脚本会直接读取本文件作为 GitHub Release Body，",
    "> 禁止复用旧版本说明。修改完成后再执行发布命令。",
    "",
    "## 本次版本主要改动",
    "",
    "- TODO: 根据最近提交和用户反馈逐项填写。可参考 `git log v<上一版本>..HEAD --oneline`。",
    "",
  ].join("\n");
  throw new Error(
    `Release notes file not found at ${releaseNotesPath}. `
    + `A template skeleton has been prepared. Fill it in with the actual changes for ${tag}, then rerun the release command.`,
  );
}
const releaseNotes = readFileSync(releaseNotesPath, "utf8").replace(/\r\n/g, "\n").trim();
if (!releaseNotes) throw new Error(`Release notes file ${releaseNotesPath} is empty.`);
if (/TODO|TBD|待填写|示例|样例/.test(releaseNotes)) {
  throw new Error(`Release notes file ${releaseNotesPath} still contains placeholder text. Replace it with the actual changes for ${tag}.`);
}

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
          reject(new Error(`${method} ${path} failed: ${response.statusCode} ${text.slice(0, 1000)}`));
          return;
        }
        resolvePromise(text ? JSON.parse(text) : undefined);
      });
    });
    request.on("error", reject);
    if (payload) request.end(payload);
    else request.end();
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
          reject(new Error(`Upload ${fileName} failed: ${response.statusCode} ${text.slice(0, 1000)}`));
          return;
        }
        resolvePromise(JSON.parse(text));
      });
    });
    request.on("error", reject);
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.pipe(request);
  });
}

async function main() {
  const androidMetadataPath = join(releaseDir, "android-latest.json");
  const androidMetadata = existsSync(androidMetadataPath)
    ? JSON.parse(readFileSync(androidMetadataPath, "utf8"))
    : null;
  if (androidMetadata && (!Number.isSafeInteger(androidMetadata.versionCode) || androidMetadata.versionCode <= 0)) {
    throw new Error("android-latest.json contains an invalid versionCode");
  }
  const pluginDir = join(releaseDir, "agent-plugins");
  const pluginAssets = readdirSync(pluginDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".zip") || entry.name === "agent-plugins.json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => [
      join(pluginDir, entry.name),
      entry.name.endsWith(".zip") ? "application/zip" : "application/json",
  ]);
  const assets = [
    [join(releaseDir, `hpp-Setup-${version}.exe`), "application/vnd.microsoft.portable-executable"],
    [join(releaseDir, `hpp-Setup-${version}.exe.blockmap`), "application/octet-stream"],
    [join(releaseDir, "latest.yml"), "text/yaml"],
    [join(releaseDir, `Hpp-Linux-${version}-x86_64.AppImage`), "application/vnd.appimage"],
    ...(androidMetadata ? [[
      join(releaseDir, "Hpp-Android.apk"),
      "application/vnd.android.package-archive",
      `hpp-version-code:${androidMetadata.versionCode}`,
    ], [androidMetadataPath, "application/json"]] : []),
    ...pluginAssets,
  ];
  const preparedAssets = assets.filter(([relativePath]) => existsSync(resolve(relativePath))).map(([relativePath, contentType, label]) => {
    const filePath = resolve(relativePath);
    return { filePath, contentType, label, size: statSync(filePath).size };
  });
  console.log(`Validated ${preparedAssets.length} local release assets`);

  const releases = await requestJson("GET", `/repos/${owner}/${repo}/releases?per_page=100`);
  const existingRelease = releases.find((release) => release.tag_name === tag);
  if (existingRelease) {
    console.log(`Deleting existing release ${tag}`);
    await requestJson("DELETE", `/repos/${owner}/${repo}/releases/${existingRelease.id}`);
  }

  const refs = await requestJson("GET", `/repos/${owner}/${repo}/git/matching-refs/tags/${encodeURIComponent(tag)}`);
  for (const ref of refs) {
    if (ref.ref !== `refs/tags/${tag}`) continue;
    const refName = ref.ref.replace(/^refs\//, "");
    console.log(`Deleting tag ${refName}`);
    await requestJson("DELETE", `/repos/${owner}/${repo}/git/refs/${refName}`);
  }

  const release = await requestJson("POST", `/repos/${owner}/${repo}/releases`, {
    tag_name: tag,
    target_commitish: "main",
    name: `Hpp ${tag}`,
    body: releaseNotes,
    draft: false,
    prerelease: false,
    make_latest: "true",
  });

  for (const { filePath, contentType, label, size } of preparedAssets) {
    console.log(`Streaming ${basename(filePath)} (${size} bytes)`);
    await uploadFile(release.upload_url, filePath, contentType, label);
  }

  console.log(`Published ${release.html_url}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
