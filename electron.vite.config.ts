import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const copyAgentWorkerPlugin = () => ({
  name: "copy-agent-workers",
  writeBundle() {
    const targetDir = resolve(__dirname, "out/main");
    mkdirSync(targetDir, { recursive: true });
    for (const worker of ["pi-sdk-worker.mjs", "codex-worker.mjs", "codex-fork-utils.mjs"]) {
      copyFileSync(
        resolve(__dirname, "electron/agents", worker),
        resolve(targetDir, worker)
      );
    }
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
      },
    },
  },
});
