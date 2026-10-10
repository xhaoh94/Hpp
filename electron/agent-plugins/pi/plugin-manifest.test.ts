import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Pi 插件清单里声明的内置扩展。
 *
 * 顺序即 UI 渲染顺序（AgentConfigModal 直接 map options，无二次排序），
 * 所以改顺序就是改界面。这里钉住当前顺序与 worker 映射表的键顺序一致。
 */
const readPluginManifest = () =>
  JSON.parse(
    readFileSync(join(process.cwd(), "electron/agent-plugins/pi/hpp-agent-plugin.json"), "utf8"),
  ) as {
    capabilities: {
      builtinExtensions: {
        defaultEnabled: string[];
        options: Array<{ id: string; label: string; hotReload?: boolean }>;
      };
    };
  };

const readWorkerMapping = () => {
  const source = readFileSync(
    join(process.cwd(), "electron/plugin-backends/pi/worker.mjs"),
    "utf8",
  );
  const body = source
    .slice(source.indexOf("OPTIONAL_BUILTIN_EXTENSIONS = {"))
    .split("};")[0];
  return [...body.matchAll(/^\s*(\w+):\s*"create(\w+)Extension"/gm)].map((match) => match[1]);
};

describe("pi 插件的内置扩展声明", () => {
  it("按 codemode → mcp → tool_search 的顺序声明（UI 渲染顺序）", () => {
    const manifest = readPluginManifest();
    expect(manifest.capabilities.builtinExtensions.options.map((option) => option.id)).toEqual([
      "codemode",
      "mcp",
      "tool_search",
    ]);
  });

  it("worker 的工厂映射表键顺序与清单一致", () => {
    const manifest = readPluginManifest();
    expect(readWorkerMapping()).toEqual(
      manifest.capabilities.builtinExtensions.options.map((option) => option.id),
    );
  });

  it("默认全关—— 三项都会改变模型可见的工具集合", () => {
    expect(readPluginManifest().capabilities.builtinExtensions.defaultEnabled).toEqual([]);
  });

  it("每一项都声明了 label 与 hotReload", () => {
    for (const option of readPluginManifest().capabilities.builtinExtensions.options) {
      expect(option.label, `${option.id} 缺少 label`).toBeTruthy();
      expect(option.hotReload, `${option.id} 缺少 hotReload`).toBe(true);
    }
  });
});
