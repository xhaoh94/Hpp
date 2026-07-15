import { app } from "electron";
import { existsSync } from "fs";
import { join, sep } from "path";
import { getCommandEnv, getNodeExecutable } from "./command-utils";

type PackagedWorkerRuntime = "electron" | "node";

export function getBundledWorkerPath(workerFileName: string, currentDir: string): string {
  const candidates = [
    join(currentDir, workerFileName),
    join(process.cwd(), "electron", "plugin-runtime", workerFileName),
    join(process.cwd(), "electron", "agents", workerFileName),
    join(app.getAppPath(), "out", "main", workerFileName),
    join(app.getAppPath(), "electron", "plugin-runtime", workerFileName),
    join(app.getAppPath(), "electron", "agents", workerFileName),
    join(process.cwd(), "out", "main", workerFileName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[candidates.length - 1];
}

export function getWorkerInvocation(
  workerPath: string,
  nodeEnvKeys: string[] = [],
  options: { packagedRuntime?: PackagedWorkerRuntime } = {}
) {
  const packagedRuntime = options.packagedRuntime || "electron";
  if (app.isPackaged && packagedRuntime === "electron") {
    return {
      command: process.execPath,
      args: [workerPath],
      env: getCommandEnv({ ELECTRON_RUN_AS_NODE: "1" }),
    };
  }

  const externalWorkerPath = app.isPackaged
    ? workerPath.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
    : workerPath;

  return {
    command: getNodeExecutable(nodeEnvKeys),
    args: [externalWorkerPath],
    env: getCommandEnv(),
  };
}
