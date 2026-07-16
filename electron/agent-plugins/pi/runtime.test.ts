import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeCommand } from "./runtime.mjs";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi runtime command resolution", () => {
  it("invokes npm through node.exe on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-runtime-"));
    tempRoots.push(root);
    const npmCli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(join(root, "node_modules", "npm", "bin"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "node.exe"), ""),
      writeFile(join(root, "npm.cmd"), ""),
      writeFile(npmCli, ""),
    ]);

    expect(resolveRuntimeCommand(
      "npm",
      ["--version"],
      { Path: root, PATHEXT: ".EXE;.CMD" },
      "win32",
    )).toEqual({
      command: join(root, "node.exe"),
      args: [npmCli, "--version"],
    });
  });

  it("resolves node to its executable instead of a shell command", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-pi-runtime-"));
    tempRoots.push(root);
    await writeFile(join(root, "node.exe"), "");

    expect(resolveRuntimeCommand(
      "node",
      ["--version"],
      { PATH: root, PATHEXT: ".EXE" },
      "win32",
    )).toEqual({
      command: join(root, "node.exe"),
      args: ["--version"],
    });
  });
});
