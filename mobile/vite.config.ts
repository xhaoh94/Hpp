import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: resolve(__dirname),
  base: "./",
  publicDir: resolve(__dirname, "../public"),
  plugins: [react()],
  resolve: {
    alias: {
      "@mobile": resolve(__dirname, "src"),
      "@shared": resolve(__dirname, "../shared"),
    },
  },
  server: {
    host: "0.0.0.0",
    fs: { allow: [resolve(__dirname, "..") ] },
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});
