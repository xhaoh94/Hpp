const { buildSync } = require("esbuild");
const { resolve } = require("path");

const root = resolve(__dirname, "..");

buildSync({
  entryPoints: {
    "plugin-backend-codex": resolve(root, "electron/plugin-backends/codex/entry.ts"),
    "plugin-backend-pi": resolve(root, "electron/plugin-backends/pi/entry.ts"),
    "plugin-backend-opencode": resolve(root, "electron/plugin-backends/opencode/entry.ts"),
    "plugin-backend-droid": resolve(root, "electron/plugin-backends/droid/entry.ts"),
  },
  outdir: resolve(root, "out/main"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  external: ["electron"],
});
