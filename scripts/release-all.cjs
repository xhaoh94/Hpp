const { spawnSync } = require("child_process");
const { resolve } = require("path");

const version = require("../package.json").version;
const tag = `v${version}`;
const WORKFLOWS = [
  { file: "build-windows-release.yml", label: "Windows installer" },
  { file: "build-android-apk.yml", label: "Android APK" },
  { file: "build-linux-appimage.yml", label: "Linux AppImage" },
];

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: resolve(__dirname, ".."),
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with code ${result.status}`);
  }
  return result;
}

function runCapture(cmd, args) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: resolve(__dirname, ".."),
  });
}

async function main() {
  const skipTrigger = process.argv.includes("--skip-trigger");

  console.log(`=== Hpp Release ${tag} (cloud builds) ===`);
  console.log("所有平台产物由 GitHub Actions 在云端构建并上传到 Release。\n");

  // Step 1: 创建/更新 Release（仅说明，不上传本地产物）。
  // 三个平台 workflow 监听 published 事件，所以必须先有 Release。
  console.log("--- Step 1: Creating/updating GitHub Release (notes only) ---");
  run("node", ["scripts/reset-github-release.cjs"], { env: { ...process.env, RG_NOTES_ONLY: "1" } });

  if (skipTrigger) {
    console.log("\n--- Skipping workflow triggers (--skip-trigger) ---");
    return;
  }

  // Step 2: 触发三个平台云端构建。
  console.log("\n--- Step 2: Triggering cloud build workflows ---");
  for (const { file, label } of WORKFLOWS) {
    const result = runCapture("gh", ["workflow", "run", file, "--ref", "main", "-f", `release_tag=${tag}`]);
    if (result.status === 0) console.log(`  ✓ ${label}: ${file}`);
    else {
      console.warn(`  ✗ ${label} trigger failed: ${(result.stderr || result.stdout || "").trim()}`);
      console.warn(`    手动补发: gh workflow run ${file} --ref main -f release_tag=${tag}`);
    }
  }

  // Step 3: 等待各 workflow 结束（gh run watch 偶发 EOF，失败只提示不中断）。
  console.log("\n--- Waiting for workflows ---");
  for (const { file, label } of WORKFLOWS) {
    const list = runCapture("gh", ["run", "list", "--workflow", file, "--limit", "1", "--json", "databaseId,status"]);
    if (list.status !== 0) {
      console.warn(`  ? ${label}: 无法查询运行状态，请到 Actions 页面确认`);
      continue;
    }
    let runId;
    try { runId = JSON.parse(list.stdout)[0]?.databaseId; } catch { /* ignore */ }
    if (!runId) {
      console.warn(`  ? ${label}: 没有找到运行记录`);
      continue;
    }
    const watch = runCapture("gh", ["run", "watch", String(runId), "--exit-status", "--interval", "15"]);
    if (watch.status === 0) console.log(`  ✓ ${label}: 构建与上传完成`);
    else console.warn(`  ✗ ${label}: 构建失败或监控中断（run ${runId}），请检查 Actions 日志`);
  }

  // Step 4: 验收关键产物。
  console.log("\n--- Step 4: Verifying release assets ---");
  const assets = runCapture("gh", ["release", "view", tag, "--json", "assets", "-q", ".assets[].name"]);
  const names = (assets.stdout || "").split(/\r?\n/).filter(Boolean);
  const expected = [
    `hpp-Setup-${version}.exe`,
    "Hpp-Android.apk",
    `Hpp-Linux-${version}-x86_64.AppImage`,
    "latest.yml",
    "agent-plugins.json",
  ];
  let missing = false;
  for (const name of expected) {
    const ok = names.includes(name);
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) missing = true;
  }

  if (missing) {
    console.warn("\n部分产物缺失，请检查上方 workflow 日志或手动触发。");
    process.exitCode = 1;
  } else {
    console.log(`\n=== Release ${tag} published: https://github.com/xhaoh94/Hpp/releases/tag/${tag} ===`);
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
