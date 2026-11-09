import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/**
 * 升级残留的嵌套依赖（旧 shrinkwrap 布局）只能靠整棵重装清掉：
 * 两条安装路径都必须在 npm install 之前删除 node_modules 与 package-lock.json，
 * 否则新版代码会命中嵌套的旧 pi-ai，子 Agent 直接 ERR_MODULE_NOT_FOUND。
 */
describe("Pi SDK 安装前清理依赖树", () => {
  const cases = [
    {
      name: "IPC 安装路径",
      source: read("./pi-sdk-handlers.ts"),
      removeNodeModules: 'rm(join(packageRoot, "node_modules"), { recursive: true, force: true })',
      removeLock: 'rm(join(packageRoot, "package-lock.json"), { force: true })',
      install: 'runNpmCommand(\n      ["install"',
    },
    {
      name: "插件 runtime 安装路径",
      source: read("../agent-plugins/pi/runtime.mjs"),
      removeNodeModules: 'rm(join(runtimeRoot, "node_modules"), { recursive: true, force: true })',
      removeLock: 'rm(join(runtimeRoot, "package-lock.json"), { force: true })',
      install: 'run("npm", ["install"',
    },
  ];

  for (const item of cases) {
    it(`${item.name}先删 node_modules 与 package-lock 再安装`, () => {
      const installIndex = item.source.indexOf(item.install);
      const nodeModulesIndex = item.source.indexOf(item.removeNodeModules);
      const lockIndex = item.source.indexOf(item.removeLock);

      expect(installIndex).toBeGreaterThan(-1);
      expect(nodeModulesIndex).toBeGreaterThan(-1);
      expect(lockIndex).toBeGreaterThan(-1);
      expect(nodeModulesIndex).toBeLessThan(installIndex);
      expect(lockIndex).toBeLessThan(installIndex);
    });
  }

  it("状态检查会报告嵌套旧副本造成的混合依赖树", () => {
    const source = read("./pi-sdk-handlers.ts");
    expect(source).toContain("detectDependencyTreeProblem");
    expect(source).toContain("dependencyError || error || environmentError");
    expect(source).toContain('pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "package.json"');
  });
});
