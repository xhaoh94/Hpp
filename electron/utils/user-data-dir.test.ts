import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_USER_DATA_DIR_NAME,
  ensureSharedDataDirLink,
  resolveDevDataDir,
  resolveDevUserDataDir,
  resolvePackagedDataDir,
} from "./user-data-dir";

const tempDirs: string[] = [];

const createTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hpp-user-data-dir-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("resolveDevUserDataDir", () => {
  it("puts dev userData under the packaged userData dir", () => {
    const packaged = join("C:", "Users", "me", "AppData", "Roaming", "hpp");
    expect(resolveDevUserDataDir(packaged)).toBe(join(packaged, DEV_USER_DATA_DIR_NAME));
  });

  it("honors an explicit override, trimming whitespace", () => {
    expect(resolveDevUserDataDir("C:\\base", "  D:\\hpp-dev  ")).toBe("D:\\hpp-dev");
  });

  it("ignores blank overrides", () => {
    expect(resolveDevUserDataDir("C:\\base", "   ")).toBe(join("C:\\base", DEV_USER_DATA_DIR_NAME));
    expect(resolveDevUserDataDir("C:\\base", null)).toBe(join("C:\\base", DEV_USER_DATA_DIR_NAME));
    expect(resolveDevUserDataDir("C:\\base", undefined)).toBe(join("C:\\base", DEV_USER_DATA_DIR_NAME));
  });
});

describe("data dir paths", () => {
  it("derives hpp-data from both roots", () => {
    expect(resolveDevDataDir("C:\\base\\dev")).toBe(join("C:\\base\\dev", "hpp-data"));
    expect(resolvePackagedDataDir("C:\\base")).toBe(join("C:\\base", "hpp-data"));
  });
});

describe("ensureSharedDataDirLink", () => {
  it("links dev hpp-data to the packaged one so both see the same files", () => {
    const root = createTempDir();
    const shared = resolvePackagedDataDir(root);
    const dev = resolveDevDataDir(join(root, DEV_USER_DATA_DIR_NAME));
    mkdirSync(join(root, DEV_USER_DATA_DIR_NAME), { recursive: true });
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "marker.txt"), "shared", "utf8");

    expect(ensureSharedDataDirLink(shared, dev)).toBe("linked");
    expect(existsSync(join(dev, "marker.txt"))).toBe(true);

    // 写进链接目录的文件应落到正式版那一份里。
    writeFileSync(join(dev, "from-dev.txt"), "dev", "utf8");
    expect(readdirSync(shared).sort()).toEqual(["from-dev.txt", "marker.txt"]);
  });

  it("keeps an existing dev data dir untouched", () => {
    const root = createTempDir();
    const shared = resolvePackagedDataDir(root);
    const dev = resolveDevDataDir(join(root, DEV_USER_DATA_DIR_NAME));
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, "own.txt"), "own", "utf8");

    expect(ensureSharedDataDirLink(shared, dev)).toBe("skipped");
    expect(statSync(dev).isDirectory()).toBe(true);
    expect(readdirSync(dev)).toEqual(["own.txt"]);
  });
});