const { createReadStream, statSync } = require("fs");
const { basename, resolve } = require("path");
const https = require("https");

const owner = "xhaoh94";
const repo = "Hpp";
const version = "0.0.1";
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
  for (const release of releases) {
    console.log(`Deleting release ${release.tag_name}`);
    await requestJson("DELETE", `/repos/${owner}/${repo}/releases/${release.id}`);
  }

  const refs = await requestJson("GET", `/repos/${owner}/${repo}/git/matching-refs/tags/`);
  for (const ref of refs) {
    const refName = ref.ref.replace(/^refs\//, "");
    console.log(`Deleting tag ${refName}`);
    await requestJson("DELETE", `/repos/${owner}/${repo}/git/refs/${refName}`);
  }

  const release = await requestJson("POST", `/repos/${owner}/${repo}/releases`, {
    tag_name: tag,
    target_commitish: "main",
    name: `Hpp ${tag}`,
    body: "Hpp 重新整理后的首个发布版本。包含独立 Agent 插件进程、真实 backend 进程隔离、插件目录重构和安全修复。",
    draft: false,
    prerelease: false,
    make_latest: "true",
  });

  const assets = [
    ["release/hpp-Setup-0.0.1.exe", "application/vnd.microsoft.portable-executable"],
    ["release/hpp-Setup-0.0.1.exe.blockmap", "application/octet-stream"],
    ["release/latest.yml", "text/yaml"],
    ["release/agent-plugins/agent-plugins.json", "application/json"],
    ["release/agent-plugins/codex.zip", "application/zip"],
    ["release/agent-plugins/pi.zip", "application/zip"],
    ["release/agent-plugins/opencode.zip", "application/zip"],
    ["release/agent-plugins/droid.zip", "application/zip"],
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
