import { ipcMain } from "electron";

import type { SessionWorkspace } from "../../shared/session-workspace";
import { worktreeManager } from "./worktree-manager";

export function registerWorktreeIpc() {
  ipcMain.handle("worktree:probe", (_event, projectPath: unknown) => {
    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return { supported: false, isGitRepo: false, clean: false, error: "缺少项目路径。" };
    }
    return worktreeManager.probe(projectPath);
  });

  ipcMain.handle("worktree:create", (_event, projectPath: unknown, sessionId: unknown) => {
    if (typeof projectPath !== "string" || !projectPath.trim()) {
      return { success: false, error: "缺少项目路径。" };
    }
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return { success: false, error: "缺少会话 ID。" };
    }
    return worktreeManager.create(projectPath, sessionId);
  });

  ipcMain.handle("worktree:status", (_event, workspace: SessionWorkspace) =>
    worktreeManager.status(workspace));

  ipcMain.handle("worktree:checkpoint", (_event, workspace: SessionWorkspace, message?: unknown) =>
    worktreeManager.checkpoint(workspace, typeof message === "string" ? message : undefined));

  ipcMain.handle("worktree:merge", (_event, workspace: SessionWorkspace) =>
    worktreeManager.merge(workspace));

  ipcMain.handle("worktree:remove", (_event, workspace: SessionWorkspace) =>
    worktreeManager.remove(workspace));
}
