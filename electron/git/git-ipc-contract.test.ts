import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const preload = read("electron/preload.ts");
const ipc = read("electron/git/ipc.ts");
const apiTypes = read("src/types/index.ts");
const main = read("electron/main.ts");

const collect = (source: string, pattern: RegExp) =>
  [...source.matchAll(pattern)].map((match) => match[1]).sort();

/** preload 里真正 invoke 的 git 通道 */
const invokedChannels = collect(preload, /ipcRenderer\.invoke\("(git:[^"]+)"/g);
/** 主进程注册的 git 通道 */
const handledChannels = collect(ipc, /ipcMain\.handle\("(git:[^"]+)"/g);
/** preload 暴露的 git 方法名 */
const preloadMethods = collect(preload, /^\s{2}(git[A-Z]\w*):/gm);

describe("git IPC contract", () => {
  it("registers a main-process handler for every channel the renderer can call", () => {
    expect(invokedChannels.length).toBeGreaterThan(20);
    expect(invokedChannels).toEqual(handledChannels);
  });

  it("exposes every git method in the ElectronAPI type", () => {
    expect(preloadMethods.length).toBeGreaterThan(20);
    for (const name of preloadMethods) {
      expect(apiTypes).toContain(`  ${name}:`);
    }
  });

  it("declares every typed git method in preload", () => {
    const typedMethods = collect(apiTypes, /^\s{2}(git[A-Z]\w*):\s*\(/gm);
    expect(typedMethods.length).toBeGreaterThan(20);
    for (const name of typedMethods) {
      expect(preloadMethods).toContain(name);
    }
  });

  it("wires the git handlers into the app bootstrap", () => {
    expect(main).toContain("registerGitIpc()");
  });

  it("only calls git methods the preload actually exposes", () => {
    const dir = resolve(process.cwd(), "src/components/git");
    const sources = [
      ...readdirSync(dir).filter((name) => name.endsWith(".tsx")).map((name) => read(join("src/components/git", name))),
      read("src/components/sidebar/ProjectView.tsx"),
    ];
    const used = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/(?:electronAPI\??\.|blameApi|api\.)(git[A-Z]\w*)/g)) {
        used.add(match[1]);
      }
    }
    expect(used.size).toBeGreaterThan(20);
    for (const name of used) {
      expect(preloadMethods).toContain(name);
    }
  });
});
