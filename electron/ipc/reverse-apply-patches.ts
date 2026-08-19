import { spawnSync } from "node:child_process";

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

const defaultRunGitApply: RunGitApply = (cwd, patch, reverse) => spawnSync(
  "git",
  ["apply", ...(reverse ? ["--reverse"] : []), "--whitespace=nowarn", "-"],
  {
    cwd,
    input: `${patch.trimEnd()}\n`,
    encoding: "utf-8",
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  },
);

const getFailureDetail = (result: GitApplyResult) => {
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
