import { existsSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodemodeConfig, writeCodemodeConfig } from "./codemode-config";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("codemode config", () => {
  it("creates the Pi agent directory on first save", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-codemode-config-"));
    roots.push(root);
    const agentDir = join(root, "nested", "agent");

    await expect(writeCodemodeConfig({ mode: "only", inlineBudget: 1200 }, agentDir))
      .resolves.toEqual({ mode: "only", inlineBudget: 1200 });

    const filePath = join(agentDir, "settings.json");
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      codemode: { mode: "only", inlineBudget: 1200 },
    });
    await expect(readCodemodeConfig(agentDir)).resolves.toMatchObject({
      config: { mode: "only", inlineBudget: 1200 },
      stored: true,
    });
  });
});
