const { cpSync, existsSync, mkdirSync, rmSync } = require("fs");
const { resolve } = require("path");

const root = resolve(__dirname, "..");
const source = resolve(root, "mobile", "dist");
const target = resolve(root, "out", "mobile");

if (!existsSync(source)) throw new Error("Mobile web build is missing. Run npm run mobile:build first.");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`packaged web client -> ${target}`);
