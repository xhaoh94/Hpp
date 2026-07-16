import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@mobile": resolve(__dirname, "mobile/src"),
      "@shared": resolve(__dirname, "shared"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "electron/**/*.test.ts", "shared/**/*.test.ts", "mobile/src/**/*.test.ts"],
  },
});
