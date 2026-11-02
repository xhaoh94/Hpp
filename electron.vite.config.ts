import { resolve } from "path";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { buildSync } from "esbuild";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const copyAgentWorkerPlugin = () => ({
  name: "copy-agent-workers",
  writeBundle() {
    const targetDir = resolve(__dirname, "out/main");
    mkdirSync(targetDir, { recursive: true });
    const workers = [
      ["electron/plugin-runtime/agent-plugin-host.mjs", "agent-plugin-host.mjs"],
      ["electron/plugin-backends/codex/worker.mjs", "codex-worker.mjs"],
      ["electron/plugin-backends/codex/fork-utils.mjs", "fork-utils.mjs"],
      ["electron/plugin-backends/codex/command-invocation.mjs", "command-invocation.mjs"],
      ["electron/plugin-backends/pi/worker.mjs", "pi-sdk-worker.mjs"],
      ["electron/plugin-backends/pi/pi-fork-utils.mjs", "pi-fork-utils.mjs"],
      ["electron/plugin-backends/pi/pi-agent-dir.mjs", "pi-agent-dir.mjs"],
      ["electron/plugin-backends/pi/shell-environment.mjs", "shell-environment.mjs"],
      ["electron/plugin-backends/pi/plan-mode-policy.mjs", "plan-mode-policy.mjs"],
      ["electron/plugin-backends/pi/subagent-extension.mjs", "subagent-extension.mjs"],
      ["electron/plugin-backends/pi/subagent-bridge-extension.mjs", "subagent-bridge-extension.mjs"],
      ["electron/plugin-backends/pi/subagent-policy.mjs", "subagent-policy.mjs"],
      ["electron/plugin-backends/claude/worker.mjs", "claude-sdk-worker.mjs"],
      ["electron/plugin-backends/claude/openai-anthropic-adapter.mjs", "openai-anthropic-adapter.mjs"],
    ];
    for (const [source, target] of workers) {
      const sourcePath = resolve(__dirname, source);
      const targetPath = resolve(targetDir, target);
      if (!existsSync(sourcePath)) {
        // worker 源文件被删除 / 改名时不能留下 out/ 里的旧副本：旧副本往往还
        // import 着已删除的模块，而 copyFileSync 抛错会中断整轮复制，main 与
        // worker 版本错位，症状是「Pi SDK worker output pipe closed」。
        rmSync(targetPath, { force: true });
        console.warn(`[copy-agent-workers] 跳过不存在的源文件：${source}`);
        continue;
      }
      copyFileSync(sourcePath, targetPath);
    }
    const subagentPromptSourceDir = resolve(__dirname, "electron/plugin-backends/pi/subagent-prompts");
    const subagentPromptTargetDir = resolve(targetDir, "subagent-prompts");
    mkdirSync(subagentPromptTargetDir, { recursive: true });
    for (const entry of readdirSync(subagentPromptSourceDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      copyFileSync(
        resolve(subagentPromptSourceDir, entry.name),
        resolve(subagentPromptTargetDir, entry.name),
      );
    }
    const backendRoot = resolve(__dirname, "electron/plugin-backends");
    const backendEntryPoints = Object.fromEntries(
      readdirSync(backendRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(resolve(backendRoot, entry.name, "entry.ts")))
        .map((entry) => [`plugin-backend-${entry.name}`, resolve(backendRoot, entry.name, "entry.ts")]),
    );
    buildSync({
      entryPoints: backendEntryPoints,
      outdir: targetDir,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      sourcemap: false,
      external: ["electron"],
    });
  },
});

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyAgentWorkerPlugin()],
    build: {
      lib: {
        entry: resolve(__dirname, "electron/main.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve(__dirname, "electron/preload.ts"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src"),
    publicDir: resolve(__dirname, "public"),
    server: {
      hmr: false,
      watch: {
        ignored: [resolve(__dirname, "out/**")],
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/index.html"),
        },
      },
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@shared": resolve(__dirname, "shared"),
      },
    },
  },
});
