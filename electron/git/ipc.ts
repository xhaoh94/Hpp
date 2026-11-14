import { ipcMain } from "electron";

import { gitService } from "./git-service";

const requireTarget = (target: unknown) => {
  if (typeof target !== "string" || !target.trim()) throw new Error("缺少仓库路径。");
  return target;
};

export function registerGitIpc() {
  ipcMain.handle("git:status", (_event, target: unknown) => gitService.status(requireTarget(target)));
  ipcMain.handle("git:diff", (_event, target: unknown, path: unknown, staged: unknown) =>
    gitService.diff(requireTarget(target), path, staged === true));
  ipcMain.handle("git:stage", (_event, target: unknown, paths: unknown) =>
    gitService.stage(requireTarget(target), paths));
  ipcMain.handle("git:stageHunks", (_event, target: unknown, path: unknown, indexes: unknown, direction: unknown) =>
    gitService.stageHunks(requireTarget(target), path, indexes, direction));
  ipcMain.handle("git:unstage", (_event, target: unknown, paths: unknown) =>
    gitService.unstage(requireTarget(target), paths));
  ipcMain.handle("git:discard", (_event, target: unknown, paths: unknown) =>
    gitService.discard(requireTarget(target), paths));
  ipcMain.handle("git:discardHunks", (_event, target: unknown, path: unknown, indexes: unknown) =>
    gitService.discardHunks(requireTarget(target), path, indexes));
  ipcMain.handle("git:commit", (_event, target: unknown, message: unknown, amend: unknown) =>
    gitService.commit(requireTarget(target), message, amend === true));
  ipcMain.handle("git:stashCreate", (_event, target: unknown, message: unknown) =>
    gitService.stashCreate(requireTarget(target), message));
  ipcMain.handle("git:stashList", (_event, target: unknown) =>
    gitService.stashList(requireTarget(target)));
  ipcMain.handle("git:stashPop", (_event, target: unknown, ref: unknown) =>
    gitService.stashPop(requireTarget(target), ref));
  ipcMain.handle("git:resolveConflict", (_event, target: unknown, path: unknown, choice: unknown) =>
    gitService.resolveConflict(requireTarget(target), path, choice));
  ipcMain.handle("git:continueOperation", (_event, target: unknown) =>
    gitService.continueOperation(requireTarget(target)));
  ipcMain.handle("git:abortOperation", (_event, target: unknown) =>
    gitService.abortOperation(requireTarget(target)));
  ipcMain.handle("git:branches", (_event, target: unknown) =>
    gitService.branches(requireTarget(target)));
  ipcMain.handle("git:createBranch", (_event, target: unknown, name: unknown) =>
    gitService.createBranch(requireTarget(target), name));
  ipcMain.handle("git:switchBranch", (_event, target: unknown, name: unknown) =>
    gitService.switchBranch(requireTarget(target), name));
  ipcMain.handle("git:deleteBranch", (_event, target: unknown, name: unknown) =>
    gitService.deleteBranch(requireTarget(target), name));
  ipcMain.handle("git:log", (_event, target: unknown, limit: unknown) =>
    gitService.log(requireTarget(target), Number(limit) || 50));
  ipcMain.handle("git:showCommit", (_event, target: unknown, hash: unknown) =>
    gitService.showCommit(requireTarget(target), hash));
  ipcMain.handle("git:fetch", (_event, target: unknown) =>
    gitService.fetch(requireTarget(target)));
  ipcMain.handle("git:pull", (_event, target: unknown) =>
    gitService.pull(requireTarget(target)));
  ipcMain.handle("git:push", (_event, target: unknown) =>
    gitService.push(requireTarget(target)));
  ipcMain.handle("git:merge", (_event, target: unknown, branch: unknown) =>
    gitService.merge(requireTarget(target), branch));
  ipcMain.handle("git:rebase", (_event, target: unknown, branch: unknown) =>
    gitService.rebase(requireTarget(target), branch));
  ipcMain.handle("git:worktrees", (_event, target: unknown) =>
    gitService.worktrees(requireTarget(target)));
  ipcMain.handle("git:removeWorktree", (_event, target: unknown, path: unknown) =>
    gitService.removeWorktree(requireTarget(target), path));
}
