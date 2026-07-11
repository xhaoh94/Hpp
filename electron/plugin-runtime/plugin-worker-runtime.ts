import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getCommandEnv, getNodeExecutable } from "../utils/command-utils";

export function getPluginWorkerPath(workerFileName: string): string {
  const configuredDir = process.env.HPP_AGENT_WORKER_DIR;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configuredDir ? join(configuredDir, workerFileName) : "",
    join(moduleDir, workerFileName),
    join(moduleDir, "..", workerFileName),
    join(process.cwd(), "electron", "agents", workerFileName),
    join(process.cwd(), "out", "main", workerFileName),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

export function getPluginWorkerInvocation(
  workerFileName: string,
  nodeEnvKeys: string[] = [],
  preferExternalNode = false,
) {
  const workerPath = getPluginWorkerPath(workerFileName);
  if (!preferExternalNode && process.env.ELECTRON_RUN_AS_NODE === "1") {
    return {
      command: process.execPath,
      args: [workerPath],
      env: getCommandEnv({ ELECTRON_RUN_AS_NODE: "1" }),
    };
  }
  return {
    command: getNodeExecutable(nodeEnvKeys),
    args: [workerPath],
    env: getCommandEnv(),
  };
}
