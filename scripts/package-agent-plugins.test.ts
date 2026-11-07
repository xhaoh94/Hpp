import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { computeContentHash, detectVersionDrift } = require("./package-agent-plugins.cjs");

const tempDirs: string[] = [];

const makePluginDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hpp-plugin-hash-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("detectVersionDrift", () => {
  it("没有基线时不报错（首次生成基线）", () => {
    expect(detectVersionDrift({}, [{ id: "pi", version: "1.3.2", hash: "aaa" }])).toEqual([]);
  });

  it("版本与内容都没变时不报错", () => {
    const baseline = { pi: { version: "1.3.2", hash: "aaa" } };
    expect(detectVersionDrift(baseline, [{ id: "pi", version: "1.3.2", hash: "aaa" }])).toEqual([]);
  });

  it("内容变了但版本没提时报告漂移", () => {
    const baseline = { pi: { version: "1.3.2", hash: "aaa" } };
    expect(detectVersionDrift(baseline, [{ id: "pi", version: "1.3.2", hash: "bbb" }])) 
      .toEqual([{ id: "pi", version: "1.3.2" }]);
  });

  it("内容变了且版本已提升时放行", () => {
    const baseline = { pi: { version: "1.3.2", hash: "aaa" } };
    expect(detectVersionDrift(baseline, [{ id: "pi", version: "1.3.3", hash: "bbb" }])).toEqual([]);
  });

  it("只报告真正漂移的插件", () => {
    const baseline = {
      pi: { version: "1.3.2", hash: "aaa" },
      codex: { version: "1.1.2", hash: "ccc" },
    };
    const drifted = detectVersionDrift(baseline, [
      { id: "pi", version: "1.3.2", hash: "bbb" },
      { id: "codex", version: "1.1.2", hash: "ccc" },
    ]);
    expect(drifted).toEqual([{ id: "pi", version: "1.3.2" }]);
  });
});

describe("computeContentHash", () => {
  it("同样内容得到同样指纹", () => {
    const a = makePluginDir();
    const b = makePluginDir();
    for (const dir of [a, b]) {
      writeFileSync(join(dir, "manifest.json"), '{"id":"x"}');
      mkdirSync(join(dir, "lib"), { recursive: true });
      writeFileSync(join(dir, "lib", "index.mjs"), "export const x = 1;\n");
    }
    expect(computeContentHash(a)).toBe(computeContentHash(b));
    expect(computeContentHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("内容变化会改变指纹", () => {
    const dir = makePluginDir();
    writeFileSync(join(dir, "index.mjs"), "export const x = 1;\n");
    const before = computeContentHash(dir);
    writeFileSync(join(dir, "index.mjs"), "export const x = 2;\n");
    expect(computeContentHash(dir)).not.toBe(before);
  });

  it("重命名文件也会改变指纹（路径参与计算）", () => {
    const dir = makePluginDir();
    writeFileSync(join(dir, "a.mjs"), "same\n");
    const before = computeContentHash(dir);
    rmSync(join(dir, "a.mjs"));
    writeFileSync(join(dir, "b.mjs"), "same\n");
    expect(computeContentHash(dir)).not.toBe(before);
  });

  it("跳过测试文件：它们不进入 zip，也不应影响指纹", () => {
    const dir = makePluginDir();
    writeFileSync(join(dir, "config.mjs"), "export const x = 1;\n");
    writeFileSync(join(dir, "config.test.ts"), "// test\n");
    const before = computeContentHash(dir);
    writeFileSync(join(dir, "config.test.ts"), "// changed test\n");
    expect(computeContentHash(dir)).toBe(before);
  });
});
