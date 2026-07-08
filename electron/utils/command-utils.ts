import { existsSync } from "fs";
import { delimiter, dirname, isAbsolute, join, normalize, sep } from "path";

export function getPathEnvKey(env: NodeJS.ProcessEnv = process.env): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
}

export function getPathEnvValue(env: NodeJS.ProcessEnv = process.env): string {
  return env[getPathEnvKey(env)] || "";
}

function commandHasPath(command: string): boolean {
  return command.includes("/") || command.includes("\\") || isAbsolute(command);
}

function getWindowsExecutableExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.PATHEXT || ".EXE;.CMD;.BAT;.COM";
  return configured
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
}

function getCommandNames(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== "win32") return [command];
  const lower = command.toLowerCase();
  const hasKnownExtension = getWindowsExecutableExtensions(env).some((ext) => lower.endsWith(ext));
  if (hasKnownExtension) return [command];
  return [...getWindowsExecutableExtensions(env).map((ext) => `${command}${ext}`), command];
}

export function findCommandOnPath(
  command: string,
  options: { env?: NodeJS.ProcessEnv; excludeNodeModules?: boolean } = {}
): string | undefined {
  const env = options.env || process.env;
  if (!command.trim()) return undefined;

  if (commandHasPath(command)) {
    const normalized = normalize(command);
    return existsSync(normalized) ? normalized : undefined;
  }

  const dirs = getPathEnvValue(env).split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of getCommandNames(command, env)) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      if (options.excludeNodeModules && candidate.includes(`${sep}node_modules${sep}`)) continue;
      return candidate;
    }
  }
  return undefined;
}

export function findCommandsOnPath(
  command: string,
  options: { env?: NodeJS.ProcessEnv; excludeNodeModules?: boolean } = {}
): string[] {
  const env = options.env || process.env;
  if (!command.trim()) return [];

  if (commandHasPath(command)) {
    const normalized = normalize(command);
    return existsSync(normalized) ? [normalized] : [];
  }

  const matches: string[] = [];
  const seen = new Set<string>();
  const dirs = getPathEnvValue(env).split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of getCommandNames(command, env)) {
      const candidate = join(dir, name);
      const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key) || !existsSync(candidate)) continue;
      if (options.excludeNodeModules && candidate.includes(`${sep}node_modules${sep}`)) continue;
      seen.add(key);
      matches.push(candidate);
    }
  }
  return matches;
}

export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): string {
  return findCommandOnPath(command, { env }) || command;
}

export function commandExists(command: string, options: { excludeNodeModules?: boolean } = {}): boolean {
  return !!findCommandOnPath(command, {
    env: process.env,
    excludeNodeModules: options.excludeNodeModules,
  });
}

export function getCommandEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  const pathKey = getPathEnvKey(env);
  env[pathKey] = env[pathKey] || "";
  return env;
}

export function getNodeExecutable(envKeys: string[] = []): string {
  for (const key of envKeys) {
    const value = process.env[key];
    if (value && existsSync(value)) return value;
  }
  return findCommandOnPath("node") || "node";
}

export function isWindowsShellShim(filePath: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(filePath);
}

export function getNpmPackageBinTarget(shimPath: string, packageName: string, binPath: string): string | undefined {
  const target = join(dirname(shimPath), "node_modules", packageName, binPath);
  return existsSync(target) ? target : undefined;
}
