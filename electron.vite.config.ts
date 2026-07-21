import { resolve } from "path";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "fs";
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
      ["electron/plugin-backends/claude/worker.mjs", "claude-sdk-worker.mjs"],
      ["electron/plugin-backends/claude/openai-anthropic-adapter.mjs", "openai-anthropic-adapter.mjs"],
    ];
    for (const [source, target] of workers) {
      copyFileSync(resolve(__dirname, source), resolve(targetDir, target));
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
