#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, "package.json");
const packageLockPath = path.join(rootDir, "package-lock.json");
const releaseDir = path.join(rootDir, "release");

const args = process.argv.slice(2);
const options = new Set(args.filter((arg) => arg.startsWith("--")));
const version = args.find((arg) => !arg.startsWith("--"));

function usage(exitCode = 0) {
  console.log(`
Usage:
  npm run release -- <version> [options]

Examples:
  npm run release -- 0.0.2
  npm run release -- 0.0.2 --dry-run
  npm run release -- 0.0.2 --require-clean

Options:
  --dry-run          Build installer without publishing to GitHub.
  --require-clean    Refuse to release if the working tree has existing changes.
  --no-commit        Do not create and push the automatic version commit.
  --keep-release     Do not delete existing files in release/ before packaging.
  --help             Show this help.

Environment:
  GH_TOKEN or GITHUB_TOKEN with GitHub Contents: Read and write permission.
  If neither is set, the script will try to use "gh auth token".
`);
  process.exit(exitCode);
}

if (options.has("--help") || !version) usage(options.has("--help") ? 0 : 1);

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[release] Invalid version: ${version}`);
  process.exit(1);
}

const tagName = `v${version}`;
const dryRun = options.has("--dry-run");
const requireClean = options.has("--require-clean");
const noCommit = options.has("--no-commit");

function readJson(filePath) {
  return readFile(filePath, "utf8").then((content) => JSON.parse(content));
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function run(command, commandArgs, extraEnv = {}) {
  const { executable, args } = resolveCommandInvocation(command, commandArgs);
  console.log(`[release] $ ${[command, ...commandArgs].join(" ")}`);
  const result = spawnSync(executable, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  if (result.error) {
    console.error(`[release] Failed to start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function capture(command, commandArgs) {
  const { executable, args } = resolveCommandInvocation(command, commandArgs);
  const result = spawnSync(executable, args, {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail || `${command} ${commandArgs.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function captureOptional(command, commandArgs) {
  const { executable, args } = resolveCommandInvocation(command, commandArgs);
  const result = spawnSync(executable, args, {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.error) return "";
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function resolveCommandInvocation(command, commandArgs) {
  if (command === "npm") {
    const npmCli = findNpmCli();
    if (npmCli) return { executable: process.execPath, args: [npmCli, ...commandArgs] };
  }

  if (command === "electron-builder") {
    const electronBuilderCli = findFirstExisting([
      path.join(rootDir, "node_modules", "electron-builder", "cli.js"),
      path.join(rootDir, "node_modules", "electron-builder", "out", "cli", "cli.js"),
    ]);
    if (electronBuilderCli) return { executable: process.execPath, args: [electronBuilderCli, ...commandArgs] };
  }

  return { executable: command, args: commandArgs };
}

function findNpmCli() {
  return findFirstExisting([
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(path.dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]);
}

function findFirstExisting(candidates) {
  return candidates.filter(Boolean).find((candidate) => existsSync(candidate));
}

function stageReleaseChanges() {
  run("git", ["add", "-A", "--", "."]);
  run("git", ["restore", "--staged", "--", "out"]);
}

function getGithubToken() {
  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (envToken) return { token: envToken, source: process.env.GH_TOKEN ? "GH_TOKEN" : "GITHUB_TOKEN" };

  const ghToken = captureOptional("gh", ["auth", "token"]);
  if (ghToken) return { token: ghToken, source: "gh auth token" };

  return { token: "", source: "" };
}

function githubRequest(method, pathname, token, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method,
        hostname: "api.github.com",
        path: pathname,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Hpp-release-script",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          const parsed = responseBody ? JSON.parse(responseBody) : undefined;
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve(parsed);
            return;
          }
          const message = parsed?.message || `GitHub API returned HTTP ${response.statusCode}`;
          const error = new Error(message);
          error.statusCode = response.statusCode;
          error.response = parsed;
          reject(error);
        });
      }
    );
    request.on("error", reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

function getGithubPublishConfig(packageJson) {
  const publish = packageJson.build?.publish;
  const entries = Array.isArray(publish) ? publish : publish ? [publish] : [];
  const github = entries.find((entry) => entry?.provider === "github");
  if (!github?.owner || !github?.repo) {
    throw new Error("package.json build.publish must include GitHub owner and repo.");
  }
  return { owner: github.owner, repo: github.repo };
}

async function ensureGithubTag({ owner, repo, token, tag, sha }) {
  const refPath = `/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`;
  try {
    const existing = await githubRequest("GET", refPath, token);
    const existingSha = existing?.object?.sha;
    if (existingSha && existingSha !== sha) {
      throw new Error(`GitHub tag ${tag} already points to ${existingSha}, not current HEAD ${sha}.`);
    }
    console.log(`[release] GitHub tag ${tag} already exists.`);
    return;
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }

  console.log(`[release] Creating GitHub tag ${tag} at ${sha}.`);
  try {
    await githubRequest("POST", `/repos/${owner}/${repo}/git/refs`, token, {
      ref: `refs/tags/${tag}`,
      sha,
    });
  } catch (error) {
    if (error.statusCode === 422) {
      throw new Error(`Cannot create ${tag} on GitHub. Push current HEAD first, then rerun this script.`);
    }
    throw error;
  }
}

async function cleanReleaseDir() {
  if (options.has("--keep-release") || !existsSync(releaseDir)) return;
  const resolvedRelease = path.resolve(releaseDir);
  const resolvedRoot = path.resolve(rootDir);
  if (!resolvedRelease.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing to clean release dir outside project: ${resolvedRelease}`);
  }
  for (const entry of await readdir(resolvedRelease)) {
    await rm(path.join(resolvedRelease, entry), { recursive: true, force: true });
  }
}

async function updateVersionFiles(nextVersion) {
  const packageJson = await readJson(packageJsonPath);
  packageJson.version = nextVersion;
  await writeJson(packageJsonPath, packageJson);

  if (existsSync(packageLockPath)) {
    const packageLock = await readJson(packageLockPath);
    packageLock.version = nextVersion;
    if (packageLock.packages?.[""]) {
      packageLock.packages[""].version = nextVersion;
    }
    await writeJson(packageLockPath, packageLock);
  }
  return packageJson;
}

async function main() {
  const { token, source: tokenSource } = getGithubToken();
  if (!dryRun && !token) {
    console.error("[release] Missing GitHub token.");
    console.error("[release] Set GH_TOKEN/GITHUB_TOKEN in the current shell, or run `gh auth login` first.");
    console.error("[release] PowerShell example: $env:GH_TOKEN=\"your_token\"");
    process.exit(1);
  }
  if (!dryRun) {
    console.log(`[release] Using GitHub token from ${tokenSource}.`);
  }

  const initialDirty = capture("git", ["status", "--porcelain"]);
  if (!dryRun && requireClean && initialDirty) {
    console.error("[release] Working tree is not clean.");
    console.error("[release] Run without --require-clean to include current changes in the release commit.");
    console.error(initialDirty);
    process.exit(1);
  }
  if (!dryRun && !noCommit && initialDirty) {
    console.log("[release] Working tree has changes; they will be included in the release commit.");
  }

  const packageJson = await updateVersionFiles(version);
  const { owner, repo } = getGithubPublishConfig(packageJson);

  await cleanReleaseDir();

  const releaseEnv = {
    GH_TOKEN: token || process.env.GH_TOKEN || "",
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR || "https://npmmirror.com/mirrors/electron-builder-binaries/",
  };

  run("npm", ["run", "build"], releaseEnv);

  let sha = capture("git", ["rev-parse", "HEAD"]);
  if (!dryRun) {
    if (!noCommit) {
      stageReleaseChanges();
      const staged = capture("git", ["diff", "--cached", "--name-only"]);
      if (staged) {
        run("git", ["commit", "-m", `chore: release ${tagName}`]);
        run("git", ["push", "origin", "HEAD"]);
        sha = capture("git", ["rev-parse", "HEAD"]);
      } else {
        console.log("[release] Version files are already up to date; no version commit created.");
        run("git", ["push", "origin", "HEAD"]);
      }
    }

    const dirty = capture("git", ["status", "--porcelain"]);
    if (dirty && noCommit) {
      console.warn("[release] Warning: working tree has uncommitted changes.");
      console.warn("[release] The installer will include local changes, but the GitHub tag points to current HEAD.");
    }
    await ensureGithubTag({ owner, repo, token, tag: tagName, sha });
  }
  run("electron-builder", ["--publish", dryRun ? "never" : "always"], releaseEnv);

  console.log(`[release] Done: ${dryRun ? "built" : "published"} ${tagName}`);
}

main().catch((error) => {
  console.error(`[release] ${error.message || String(error)}`);
  process.exit(1);
});
