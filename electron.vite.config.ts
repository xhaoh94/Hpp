import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const copyPiSDKWorkerPlugin = () => ({
  name: "copy-pi-sdk-worker",
  writeBundle() {
    const targetDir = resolve(__dirname, "out/main");
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(
      resolve(__dirname, "electron/agents/pi-sdk-worker.mjs"),
      resolve(targetDir, "pi-sdk-worker.mjs")
    );
  },
});

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyPiSDKWorkerPlugin()],
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
