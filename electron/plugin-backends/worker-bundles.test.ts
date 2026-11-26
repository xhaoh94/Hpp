import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/**
 * 复制清单：[源路径, 目标文件名]。
 * worker 是平铺到 out/main 的，所以两个文件不能同名（不同目录同名也会撞）。
 */
function readWorkerCopyList(): Array<[string, string]> {
  const config = workspaceFile("electron.vite.config.ts");
  const block = config.slice(
    config.indexOf("const workers = ["),
    config.indexOf("];", config.indexOf("const workers = [")),
  );
  const entries: Array<[string, string]> = [];
  for (const line of block.split("\n")) {
    const match = /\["([^"]+)",\s*"([^"]+)"\]/.exec(line);
    if (match) entries.push([match[1], match[2]]);
  }
  return entries;
}

const STATIC_IMPORT = /from\s+"(\.\/[^"]+\.mjs)"/g;

function staticRelativeImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT)) found.push(match[1]);
  return found;
}

describe("worker bundle copy list", () => {
  const entries = readWorkerCopyList();
  const targetNames = new Set(entries.map(([, target]) => target));

  it("declares every static .mjs dependency of every copied worker", () => {
    const missing: string[] = [];
    for (const [source] of entries) {
      let code: string;
      try {
        code = workspaceFile(source);
      } catch {
        missing.push(`源文件不存在：${source}`);
        continue;
      }
      for (const relative of staticRelativeImports(code)) {
        const dependency = relative.replace("./", "");
        // worker 被平铺到 out/main，依赖仍按同目录解析，所以目标名必须存在。
        if (!targetNames.has(dependency)) {
          missing.push(`${source} → ${relative}（清单里没有 ${dependency}）`);
        }
      }
    }
    // 漏一个的症状就是启动即崩：`Pi SDK worker output pipe closed before the process exited`
    // （真实原因是 ERR_MODULE_NOT_FOUND，但上层只看到管道关闭）。
    expect(missing).toEqual([]);
  });

  it("keeps target file names unique", () => {
    const targets = entries.map(([, target]) => target);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("marks every listed source as an existing file", () => {
    const absent = entries
      .map(([source]) => source)
      .filter((source) => {
        try {
          workspaceFile(source);
          return false;
        } catch {
          return true;
        }
      });
    expect(absent).toEqual([]);
  });
});
