import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type GitApplyResult = {
  error?: Error;
  status: number | null;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
};

export type RunGitApply = (
  cwd: string,
  patch: string,
  reverse: boolean,
) => GitApplyResult;

// 补丁里只有这三类行参与内容比对；`---`/`+++` 头与 `\ No newline` 必须原样保留。
const PATCH_CONTENT_LINE = /^(?: |\+(?!\+\+)|\-(?!\-\-))/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** 目标文件的行尾分布。crlfByLine 下标是 0 基行号，越界时退回 defaultCrlf。 */
export type TargetLineEndings = {
  defaultCrlf: boolean;
  crlfByLine: readonly boolean[];
};

/**
 * 把补丁的内容行对齐到目标文件的行尾（幂等）。
 * 传 TargetLineEndings 时按 hunk 行号逐行取真实行尾 —— 混行文件（CRLF 行与 LF 行并存）
 * 只有这样才能匹配；新增行没有可匹配的旧行，一律跟随 defaultCrlf。
 */
export const alignPatchLineEndings = (patch: string, target: boolean | TargetLineEndings) => {
  const perLine = typeof target === "boolean" ? null : target;
  const fallback = typeof target === "boolean" ? target : target.defaultCrlf;
  const out: string[] = [];
  let inHunk = false;
  // 旧文件行号（1 基），只有上下文行与删除行推进它
  let oldLine = 0;

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      inHunk = true;
      oldLine = Number(header[1]);
      out.push(line);
      continue;
    }
    if (!inHunk || !PATCH_CONTENT_LINE.test(line)) {
      out.push(line);
      continue;
    }
    const body = line.replace(/\r$/, "");
    let crlf = fallback;
    if (line[0] !== "+") {
      crlf = perLine?.crlfByLine[oldLine - 1] ?? fallback;
      oldLine += 1;
    }
    out.push(crlf ? `${body}\r` : body);
  }

  return out.join("\n");
};

const unquotePatchPath = (value: string) => {
  const head = value.trim().split("\t", 1)[0];
  if (!head) return "";
  if (!head.startsWith('"')) return head;
  try {
    return JSON.parse(head) as string;
  } catch {
    return "";
  }
};

/** 补丁的目标文件路径（相对形式）；/dev/null、越界或解析不出时返回空串。 */
export const getPatchTargetPath = (patch: string) => {
  const lines = patch.split("\n", 40);
  const header = lines.find((line) => line.startsWith("+++ "))
    || lines.find((line) => line.startsWith("--- "));
  const raw = header ? unquotePatchPath(header.slice(4)) : "";
  if (!raw || raw === "/dev/null") return "";
  const normalized = raw.replace(/^[ab]\//, "").replace(/\\/g, "/");
  // 这个路径只用来读文件判断行尾，越界一律不认。
  if (normalized.split("/").includes("..")) return "";
  return normalized;
};

/** 读目标文件每行的真实行尾；读不到（新增/删除/越界）返回 null。 */
export const readTargetLineEndings = (cwd: string, patch: string): TargetLineEndings | null => {
  const relative = getPatchTargetPath(patch);
  if (!relative) return null;
  try {
    const text = readFileSync(isAbsolute(relative) ? relative : join(cwd, relative)).toString("utf8");
    const split = text.split("\n");
    // 末尾空串是收尾换行，不算一行内容
    const rows = split[split.length - 1] === "" ? split.slice(0, -1) : split;
    const crlf = (text.match(/\r\n/g) || []).length;
    return {
      defaultCrlf: crlf > (text.match(/\n/g) || []).length - crlf,
      crlfByLine: rows.map((row) => row.endsWith("\r")),
    };
  } catch {
    return null;
  }
};

const spawnGitApply = (cwd: string, patch: string, reverse: boolean) => spawnSync(
  "git",
  [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.filemode=false",
    "apply",
    ...(reverse ? ["--reverse"] : []),
    "--whitespace=nowarn",
    "-",
  ],
  {
    cwd,
    // 补丁最后一行可能以 \r 结尾（CRLF 文件的内容），trimEnd 会把它当
    // 空白剥掉导致 git apply 失败。只去尾随换行符，再补回单个分隔换行。
    input: `${patch.replace(/\n+$/, "")}\n`,
    encoding: "utf-8",
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  },
);

/**
 * 上面固定了 core.autocrlf=false，好让结果不随用户的 git 配置变化；代价是 git apply
 * 退化成纯字节比对：磁盘文件是 CRLF、而 provider 给的补丁是 LF 时（Windows 上
 * autocrlf=true 检出的仓库必然如此），正反向都匹配不上，整个文件会被判成
 * 「无法安全撤销」。这里在失败后按目标文件逐行的真实行尾对齐补丁再试一次。
 *
 * 只在第一次失败时重试：git apply 默认全或无，失败时磁盘没有任何改动。
 */
export const defaultRunGitApply: RunGitApply = (cwd, patch, reverse) => {
  const first = spawnGitApply(cwd, patch, reverse);
  if (!first.error && first.status === 0) return first;

  const endings = readTargetLineEndings(cwd, patch);
  if (endings === null) return first;
  const aligned = alignPatchLineEndings(patch, endings);
  if (aligned === patch) return first;

  const retry = spawnGitApply(cwd, aligned, reverse);
  return !retry.error && retry.status === 0 ? retry : first;
};


export const getFailureDetail = (result: GitApplyResult) => {
  if (result.error) return result.error.message;
  const detail = String(result.stderr || result.stdout || "").trim();
  return detail || `git apply exited with code ${result.status}`;
};

/**
 * Reverts chronological patches one at a time from newest to oldest.
 * If a step fails, previously reverted patches are replayed to avoid leaving
 * the working tree in a partially reverted state.
 */
export function reverseApplyPatches(
  projectPath: string,
  patches: string[],
  runGitApply: RunGitApply = defaultRunGitApply,
): { success: boolean; error?: string } {
  const ordered = patches
    .filter((patch): patch is string => typeof patch === "string" && patch.trim().length > 0);
  if (ordered.length === 0) return { success: false, error: "No patch content to revert" };

  const reverted: string[] = [];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const patch = ordered[index];
    const result = runGitApply(projectPath, patch, true);
    if (!result.error && result.status === 0) {
      reverted.push(patch);
      continue;
    }

    const revertError = getFailureDetail(result);
    const rollbackErrors: string[] = [];
    for (let rollbackIndex = reverted.length - 1; rollbackIndex >= 0; rollbackIndex -= 1) {
      const rollback = runGitApply(projectPath, reverted[rollbackIndex], false);
      if (rollback.error || rollback.status !== 0) {
        rollbackErrors.push(getFailureDetail(rollback));
      }
    }
    return {
      success: false,
      error: rollbackErrors.length > 0
        ? `${revertError}\n恢复已撤销修改失败：${rollbackErrors.join("; ")}`
        : revertError,
    };
  }

  return { success: true };
}
