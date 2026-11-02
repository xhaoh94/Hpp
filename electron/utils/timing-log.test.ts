import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendTimingLog, appendTimingLogLines, getTimingLogFile } from "./timing-log";

const tempDirs: string[] = [];
const originalDataDir = process.env.HPP_DATA_DIR;

const createTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hpp-timing-log-"));
  tempDirs.push(dir);
  return dir;
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.HPP_DATA_DIR;
  else process.env.HPP_DATA_DIR = originalDataDir;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("timing log", () => {
  it("stays disabled without an HPP_DATA_DIR", () => {
    process.env.HPP_DATA_DIR = "";
    expect(getTimingLogFile()).toBe("");
    expect(() => appendTimingLog("[Hpp timing] test")).not.toThrow();
  });

  it("appends timestamped lines into logs/hpp-timing.log", () => {
    const dir = createTempDir();
    process.env.HPP_DATA_DIR = dir;

    appendTimingLog("[Hpp timing] agent:createSession:done durationMs=1059");
    appendTimingLogLines("[pi-sdk-worker]", "[pi-init] loadPiSDK +230ms total=230ms\n[pi-init] ready +1ms total=929ms");

    const file = join(dir, "logs", "hpp-timing.log");
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[Hpp timing\] agent:createSession:done durationMs=1059$/m);
    expect(content).toContain("[pi-sdk-worker] [pi-init] loadPiSDK +230ms total=230ms");
    expect(content).toContain("[pi-sdk-worker] [pi-init] ready +1ms total=929ms");
  });

  it("rotates instead of growing past the size cap", () => {
    const dir = createTempDir();
    process.env.HPP_DATA_DIR = dir;
    const file = join(dir, "logs", "hpp-timing.log");

    // 先塞一个超过 2MB 的文件，模拟长期运行后的体积。
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(file, "x".repeat(2 * 1024 * 1024 + 10), "utf8");
    appendTimingLog("[Hpp timing] after-rotate");

    expect(readFileSync(`${file}.1`, "utf8").startsWith("x")).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("after-rotate");
  });
});
