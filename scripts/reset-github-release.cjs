const { createReadStream, existsSync, readFileSync, readdirSync, statSync } = require("fs");
const { basename, join, resolve } = require("path");
const https = require("https");

const owner = "xhaoh94";
const repo = "Hpp";
const version = require("../package.json").version;
const tag = `v${version}`;
const releaseDir = resolve("release", tag);
const token = process.env.GH_TOKEN;

if (!token) throw new Error("GH_TOKEN is required.");

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

  const releaseNotes = [
    `Hpp ${version}`,
    "",
    "- 资源管理器支持状态保留、多选、右键操作、搜索定位预览、拖入聊天和文件夹引用。",
    "- 优化聊天消息折叠、时间显示、附件卡片、中间过程归档、项目卡片排序与会话收起。",
    "- 新增 Agent CLI/SDK 版本管理、历史版本安装和一键回退。",
    "- 思考等级改为匹配当前 Agent 与模型的实际能力，不再固定显示六档。",
    "- 改进 Pi、Codex 及其他 Agent 的过程输出、Shell 回退、失败恢复和子 Agent 状态展示。",
    "- 完善 Web 与移动端运行状态、消息同步、上下文压缩和输入交互。",
    "- 默认消息切换快捷键改为上、下方向键。",
  ].join("\n");

  const release = await requestJson("POST", `/repos/${owner}/${repo}/releases`, {
    tag_name: tag,
    target_commitish: "main",
    name: `Hpp ${tag}`,
    body: releaseNotes,
    /* body: [
      `Hpp ${version}`,
      "",
      "- 增强资源管理器：状态保留、多选与右键操作、搜索定位预览、拖入聊天和文件夹引用。",
      "- 优化聊天体验：消息折叠与时间、附件卡片、中间过程归档、项目卡片排序与会话收起。",
      "- 新增 Agent CLI/SDK 版本管理、历史版本安装及一键回退。",
      "- 思考等级改为匹配当前 Agent 与模型的实际能力，不再固定显示六档。",
      "- 改进 Pi、Codex 及其他 Agent 的过程输出、Shell 回退、失败恢复与子 Agent 状态展示。",
      "- 完善 Web 与移动端运行状态、消息信息和输入交互。",
      "- 消息历史切换默认快捷键改为上、下方向键。",
    ].join("\n"), */
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
