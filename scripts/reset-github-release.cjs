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
      "- 新增 Android 与 Web 远程客户端，可浏览项目、会话、流式消息、工具过程和 diff。",
      "- 支持远程新建、关闭、恢复、重载和分叉会话，以及队列、问卷、审批和中止。",
      "- 支持模型、思考等级与 Plan 模式双向同步。",
      "- 新增局域网/Tailscale 配对、设备令牌管理、会话草稿和移动端图片发送。",
      "- Windows 桌面安装包支持 GitHub 自动更新。",
      "- 正式发布使用持久签名的 Android APK，为后续覆盖更新建立签名链。",
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
