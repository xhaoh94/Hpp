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
  ipcMain.handle("git:unstage", (_event, target: unknown, paths: unknown) =>
    gitService.unstage(requireTarget(target), paths));
  ipcMain.handle("git:discard", (_event, target: unknown, paths: unknown) =>
    gitService.discard(requireTarget(target), paths));
  ipcMain.handle("git:commit", (_event, target: unknown, message: unknown, amend: unknown) =>
    gitService.commit(requireTarget(target), message, amend === true));
  ipcMain.handle("git:stashCreate", (_event, target: unknown, message: unknown) =>
    gitService.stashCreate(requireTarget(target), message));
  ipcMain.handle("git:stashList", (_event, target: unknown) =>
    gitService.stashList(requireTarget(target)));
  ipcMain.handle("git:stashPop", (_event, target: unknown, ref: unknown) =>
    gitService.stashPop(requireTarget(target), ref));
}
