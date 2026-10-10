import { lstatSync, realpathSync } from "node:fs";
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizePiAgentPath } from "./pi-agent-dir.mjs";

/** 新文件解析最近已有父目录；断链、权限错误等必须拒绝，不能回退词法路径。 */
export const resolveRealSubagentPath = (value, cwd = process.cwd()) => {
  const normalized = normalizePiAgentPath(value);
  let current = resolve(cwd, normalized);
  const suffix = [];
  while (true) {
    try {
      lstatSync(current);
      return join(realpathSync(current), ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // lstat 成功但 realpath 失败，说明是断开的 symlink，不能按普通新文件处理。
      try { lstatSync(current); throw new Error("无法解析链接目标"); } catch (linkError) {
        if (linkError?.code !== "ENOENT") throw linkError;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
};

export const isSubagentPathWithinProject = (root, candidate, cwd = root) => {
  try {
    const project = resolveRealSubagentPath(root);
    const target = resolveRealSubagentPath(candidate, cwd);
    const path = relative(project, target);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  } catch {
    return false;
  }
};

export const resolveSubagentCwd = (requested, projectRoot) => {
  const root = resolveRealSubagentPath(projectRoot || process.cwd());
  const cwd = resolveRealSubagentPath(requested || root, root);
  if (!isSubagentPathWithinProject(root, cwd)) {
    throw new Error("SubAgent 工作目录必须位于当前项目目录内。");
  }
  return { cwd, projectRoot: root };
};

/** Shell 没有系统沙箱；只免审批完全无参数、无展开的极小白名单。 */
export const isSafeSubagentShellCommand = (command) =>
  typeof command === "string" && /^(?:pwd|whoami|Get-Location)\s*$/i.test(command.trim());
