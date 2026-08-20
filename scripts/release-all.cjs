const { spawnSync } = require("child_process");
const { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } = require("fs");
const { join, resolve, basename } = require("path");

const version = require("../package.json").version;
const tag = `v${version}`;
const releaseDir = resolve("release", tag);

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

function copyIfExists(src, dest) {
  if (existsSync(src)) {
    copyFileSync(src, dest);
    console.log(`  Copied: ${basename(dest)} (${statSync(dest).size.toLocaleString()} bytes)`);
    return true;
  }
  console.warn(`  Missing: ${src}`);
  return false;
}

async function main() {
  const forceBuild = process.argv.includes("--build"); // Force rebuild even if exists
  const skipBuild = process.argv.includes("--skip-build"); // Skip build, just use existing files
  const skipLinux = process.argv.includes("--skip-linux"); // Don't trigger Linux AppImage

  console.log(`=== Hpp Release ${tag} ===`);

  // ---- Step 1: Build (unless --skip-build) ----
  if (!skipBuild) {
    console.log("\n--- Step 1: Building Windows + Android ---");
    run("npm", ["run", "dist"]);
    run("npm", ["run", "mobile:release"]);
  } else {
    console.log("\n--- Step 1: SKIPPED (--skip-build) ---");
  }

  // ---- Step 2: Archive ----
  console.log(`\n--- Step 2: Archiving to ${releaseDir} ---`);
  mkdirSync(releaseDir, { recursive: true });

  const srcRelease = resolve("release");
  copyIfExists(
    join(srcRelease, `hpp-Setup-${version}.exe`),
    join(releaseDir, `hpp-Setup-${version}.exe`)
  );
  copyIfExists(
    join(srcRelease, `hpp-Setup-${version}.exe.blockmap`),
    join(releaseDir, `hpp-Setup-${version}.exe.blockmap`)
  );
  copyIfExists(
    join(srcRelease, "latest.yml"),
    join(releaseDir, "latest.yml")
  );
  copyIfExists(
    join(srcRelease, "Hpp-Android.apk"),
    join(releaseDir, "Hpp-Android.apk")
  );
  copyIfExists(
    join(srcRelease, "android-latest.json"),
    join(releaseDir, "android-latest.json")
  );

  // Copy agent plugins if available
  const pluginDir = join(srcRelease, "agent-plugins");
  const destPluginDir = join(releaseDir, "agent-plugins");
  if (existsSync(pluginDir)) {
    mkdirSync(destPluginDir, { recursive: true });
    const files = readdirSync(pluginDir);
    for (const f of files) {
      if (f.endsWith(".zip") || f === "agent-plugins.json") {
        copyIfExists(join(pluginDir, f), join(destPluginDir, f));
      }
    }
  }

  // ---- Step 3: Upload to GitHub ----
  console.log("\n--- Step 3: Uploading to GitHub Release ---");
  run("node", ["scripts/reset-github-release.cjs"]);

  // ---- Step 4: Trigger Linux AppImage ----
  if (!skipLinux) {
    console.log("\n--- Step 4: Triggering Linux AppImage workflow ---");
    // Use gh CLI to trigger the workflow
    const result = spawnSync("gh", [
      "workflow", "run", "build-linux-appimage.yml",
      "--ref", "main",
      "-f", `release_tag=${tag}`,
    ], { stdio: "pipe", encoding: "utf8" });

    if (result.status === 0) {
      console.log("Linux AppImage workflow triggered successfully.");
      console.log("Check status: https://github.com/xhaoh94/Hpp/actions/workflows/build-linux-appimage.yml");
    } else {
      console.warn("Failed to trigger Linux workflow:", result.stderr || result.stdout);
      console.warn("You may need to manually trigger it from GitHub Actions page.");
    }
  } else {
    console.log("\n--- Step 4: SKIPPED (--skip-linux) ---");
  }

  console.log(`\n=== Release ${tag} done ===`);
  console.log(`Release URL: https://github.com/xhaoh94/Hpp/releases/tag/${tag}`);
  console.log(`Local archive: ${releaseDir}`);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
