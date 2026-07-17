const { createReadStream, readdirSync, statSync } = require("fs");
const { basename, resolve } = require("path");
const https = require("https");

const owner = "xhaoh94";
const repo = "Hpp";
const version = require("../package.json").version;
const tag = `v${version}`;
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

function uploadFile(uploadUrl, filePath, contentType) {
  return new Promise((resolvePromise, reject) => {
    const fileName = basename(filePath);
    const url = new URL(uploadUrl.replace("{?name,label}", ""));
    url.searchParams.set("name", fileName);
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
    body: [
      `Hpp ${version}`,
      "",
      "- 桌面端新增系统、浅色和深色主题，并支持跟随 Windows 外观变化。",
      "- 桌面端与 Android 更换为新的 D7 H++ 应用图标。",
      "- 优化 Windows 标题栏的最小化、最大化/还原和关闭按钮。",
      "- 修复 Pi 插件在 Windows 下触发的 Node.js DEP0190 警告。",
      "- 修复 Hpp 退出时插件状态查询误报 Plugin host exited (0) 的问题。",
      "- 修复应用内安装更新时旧进程尚未退出，导致安装器提示 Hpp 无法关闭的问题。",
      "- 修复桌面安装包误包含 Android 构建文件，导致旧版升级时出现 Hpp 无法关闭提示的问题。",
      "- 修复 Android 输入法文本需要先输入回车才能发送的问题。",
      "- 开发版使用独立 App ID，避免任务栏错误复用已安装版本的图标缓存。",
    ].join("\n"),
    draft: false,
    prerelease: false,
    make_latest: "true",
  });

  const pluginAssets = readdirSync(resolve("release/agent-plugins"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".zip") || entry.name === "agent-plugins.json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => [
      `release/agent-plugins/${entry.name}`,
      entry.name.endsWith(".zip") ? "application/zip" : "application/json",
  ]);
  const assets = [
    [`release/hpp-Setup-${version}.exe`, "application/vnd.microsoft.portable-executable"],
    [`release/hpp-Setup-${version}.exe.blockmap`, "application/octet-stream"],
    ["release/latest.yml", "text/yaml"],
    ["release/Hpp-Android.apk", "application/vnd.android.package-archive"],
    ["release/android-latest.json", "application/json"],
    ...pluginAssets,
  ];

  for (const [relativePath, contentType] of assets) {
    const filePath = resolve(relativePath);
    console.log(`Streaming ${basename(filePath)} (${statSync(filePath).size} bytes)`);
    await uploadFile(release.upload_url, filePath, contentType);
  }

  console.log(`Published ${release.html_url}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
