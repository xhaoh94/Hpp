const https = require("https");
const { readFileSync, existsSync } = require("fs");
const { resolve } = require("path");

const owner = "xhaoh94";
const repo = "Hpp";
const token = process.env.GH_TOKEN;
if (!token) throw new Error("GH_TOKEN is required.");

function api(method, path, body) {
  return new Promise((resolveP, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "api.github.com",
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "hpp-push-tool",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed;
          try { parsed = data ? JSON.parse(data) : null; }
          catch { parsed = { raw: data }; }
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 500)}`));
          } else {
            resolveP(parsed);
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const filesToPush = [
  ".github/workflows/build-linux-appimage.yml",
  "docs/release-notes/README.md",
  "docs/release-notes/v0.1.15.md",
  "scripts/reset-github-release.cjs",
  "package.json",
  "mobile/package.json",
  "updates/android-latest.json",
  "src/components/editor/EditorArea.css",
  "src/components/editor/EditorPane.tsx",
  "src/components/layout/agentEventController.ts",
  "src/components/sidebar/AgentConfigModal.tsx",
];

(async () => {
  const branch = await api("GET", `/repos/${owner}/${repo}/branches/main`);
  const mainSha = branch.commit.sha;
  console.log(`Current main: ${mainSha}`);

  // Get the tree SHA of the latest commit
  const commitData = await api("GET", `/repos/${owner}/${repo}/git/commits/${mainSha}`);
  const baseTreeSha = commitData.tree.sha;
  console.log(`Base tree: ${baseTreeSha}`);

  const treeEntries = [];
  for (const filePath of filesToPush) {
    const absPath = resolve(__dirname, "..", filePath);
    if (!existsSync(absPath)) { console.log(`SKIP: ${filePath}`); continue; }
    const content = readFileSync(absPath).toString("base64");
    const blob = await api("POST", `/repos/${owner}/${repo}/git/blobs`, { content, encoding: "base64" });
    if (!blob.sha) throw new Error(`Blob failed for ${filePath}: ${JSON.stringify(blob)}`);
    treeEntries.push({ path: filePath, mode: "100644", type: "blob", sha: blob.sha });
    console.log(`Blob: ${filePath} -> ${blob.sha}`);
  }

  const newTree = await api("POST", `/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeEntries,
  });
  if (!newTree.sha) throw new Error(`Tree creation failed: ${JSON.stringify(newTree).substring(0, 500)}`);
  console.log(`Tree: ${newTree.sha}`);

  const commit = await api("POST", `/repos/${owner}/${repo}/git/commits`, {
    message: "release: v0.1.15 — Linux AppImage auto trigger + release notes enforcement",
    tree: newTree.sha,
    parents: [mainSha],
  });
  if (!commit.sha) throw new Error(`Commit failed: ${JSON.stringify(commit).substring(0, 500)}`);
  console.log(`Commit: ${commit.sha}`);

  const ref = await api("PATCH", `/repos/${owner}/${repo}/git/refs/heads/main`, { sha: commit.sha });
  console.log(`Ref updated: ${JSON.stringify(ref).substring(0, 200)}`);
  console.log(`\nPushed main -> ${commit.sha}`);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
