import { existsSync, realpathSync } from "fs";
import { delimiter, dirname, isAbsolute, join, normalize, posix, sep, win32 } from "path";
import { homedir } from "os";

export function getPathEnvKey(env: NodeJS.ProcessEnv = process.env): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
}

export function getPathEnvValue(env: NodeJS.ProcessEnv = process.env): string {
  return env[getPathEnvKey(env)] || "";
}

export function getCommonCommandDirs(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string[] {
  if (platform === "win32") {
    return [
      env.APPDATA ? win32.join(env.APPDATA, "npm") : "",
      env.ProgramFiles ? win32.join(env.ProgramFiles, "nodejs") : "",
      env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "Programs", "nodejs") : "",
    ].filter(Boolean);
  }

  const homeDirs = [
    posix.join(home, ".local", "bin"),
    posix.join(home, ".volta", "bin"),
    posix.join(home, ".fnm", "aliases", "default", "bin"),
  ];
  return platform === "darwin"
    ? [...homeDirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    : [...homeDirs, "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"];
}

function commandHasPath(command: string): boolean {
  return command.includes("/") || command.includes("\\") || isAbsolute(command);
}

function getWindowsExecutableExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const supported = new Set([".com", ".exe", ".cmd", ".bat"]);
  const configured = (env.PATHEXT || "")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => supported.has(ext));
  return [...new Set([...configured, ".com", ".exe", ".cmd", ".bat"])];
}

function getCommandNames(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== "win32") return [command];
  const lower = command.toLowerCase();
  const hasKnownExtension = getWindowsExecutableExtensions(env).some((ext) => lower.endsWith(ext));
  if (hasKnownExtension) return [command];
  return getWindowsExecutableExtensions(env).map((ext) => `${command}${ext}`);
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
    env: getCommandEnv(),
    excludeNodeModules: options.excludeNodeModules,
  });
}

export function getCommandEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  const pathKey = getPathEnvKey(env);
  const pathDirs = (env[pathKey] || "").split(delimiter).filter(Boolean);
  for (const dir of getCommonCommandDirs(process.platform, env)) {
    if (!pathDirs.includes(dir)) pathDirs.push(dir);
  }
  env[pathKey] = pathDirs.join(delimiter);
  return env;
}

export function getNodeExecutable(envKeys: string[] = []): string {
  for (const key of envKeys) {
    const value = process.env[key];
    if (value && existsSync(value)) return value;
  }
  return findCommandOnPath("node", { env: getCommandEnv() }) || "node";
}

export function isWindowsShellShim(filePath: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(filePath);
}

function quoteWindowsCommandArg(value: string): string {
  if (!value || /[\s"&|<>^()]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function getExecFileInvocation(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const resolvedCommand = resolveCommand(command, env);
  if (!isWindowsShellShim(resolvedCommand)) {
    return { command: resolvedCommand, args };
  }

  const commandLine = [quoteWindowsCommandArg(resolvedCommand), ...args.map(quoteWindowsCommandArg)].join(" ");
  return {
    command: env.ComSpec || process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `chcp 65001>nul & call ${commandLine}`],
  };
}

export function getNpmInvocation(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const npmCommand = findCommandOnPath("npm", { env });
  if (!npmCommand) return null;

  if (process.platform === "win32") {
    const npmCli = join(dirname(npmCommand), "node_modules", "npm", "bin", "npm-cli.js");
    const bundledNode = join(dirname(npmCommand), "node.exe");
    if (!existsSync(npmCli)) return null;
    return {
      command: existsSync(bundledNode) ? bundledNode : getNodeExecutable(),
      args: [npmCli, ...args],
    };
  }

  try {
    const npmCli = realpathSync(npmCommand);
    return { command: getNodeExecutable(), args: [npmCli, ...args] };
  } catch {
    return null;
  }
}

export function getNpmPackageBinTarget(shimPath: string, packageName: string, binPath: string): string | undefined {
  const target = join(dirname(shimPath), "node_modules", packageName, binPath);
  return existsSync(target) ? target : undefined;
}
