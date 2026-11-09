import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore, type ProjectSession } from "./project-store";
import {
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_PROJECT_ID,
  isDefaultWorkspaceProject,
} from "@/lib/default-workspace";

const desktopSession: ProjectSession = {
  id: "desktop-session",
  agentId: "codex",
  agentSessionId: "desktop-session",
  title: "Desktop session",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
};

describe("project store remote session creation", () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [{
        id: "project-1",
        name: "Project",
        path: "C:\\project",
        createdAt: "2026-01-01T00:00:00.000Z",
        agents: ["codex"],
        sessions: [desktopSession],
      }],
      activeProjectId: "project-1",
      activeSessionId: desktopSession.id,
      agentStatuses: {},
      initializedSessionIds: new Set<string>(),
    });
  });

  it("adds a remote-created session without changing the desktop active session", () => {
    const remoteSession: ProjectSession = {
      ...desktopSession,
      id: "remote-session",
      agentSessionId: "remote-session",
      title: "Remote session",
    };

    useProjectStore.getState().addSession("project-1", remoteSession, false);

    const state = useProjectStore.getState();
    expect(state.activeSessionId).toBe(desktopSession.id);
    expect(state.projects[0].sessions.map((session) => session.id)).toEqual([desktopSession.id, remoteSession.id]);
  });

  it("disposes runtime state when a session is closed and keeps it recoverable", () => {
    useProjectStore.setState({
      agentStatuses: { [desktopSession.id]: "running" },
      initializedSessionIds: new Set([desktopSession.id]),
    });

    useProjectStore.getState().closeSession("project-1", desktopSession.id);
    let state = useProjectStore.getState();
    expect(state.projects[0].sessions[0].closed).toBe(true);
    expect(state.activeSessionId).toBeNull();
    expect(state.agentStatuses[desktopSession.id]).toBeUndefined();
    expect(state.initializedSessionIds.has(desktopSession.id)).toBe(false);

    useProjectStore.getState().reopenSession("project-1", desktopSession.id);
    state = useProjectStore.getState();
    expect(state.projects[0].sessions[0].closed).toBe(false);
    expect(state.activeSessionId).toBeNull();
  });
});

describe("项目卡片编辑与内置工作区", () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [{
        id: "project-1",
        name: "Project",
        path: "/work/project-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        agents: [],
        sessions: [],
      }],
      activeProjectId: "project-1",
      activeSessionId: null,
      agentStatuses: {},
      initializedSessionIds: new Set<string>(),
    });
  });

  it("改名字和路径都落到 project 上，空值不会把字段清空", () => {
    useProjectStore.getState().updateProject("project-1", { name: " Renamed ", path: "/work/renamed" });
    let project = useProjectStore.getState().projects[0];
    expect(project.name).toBe("Renamed");
    expect(project.path).toBe("/work/renamed");

    useProjectStore.getState().updateProject("project-1", { name: "  ", path: "" });
    project = useProjectStore.getState().projects[0];
    expect(project.name).toBe("Renamed");
    expect(project.path).toBe("/work/renamed");
  });

  it("内置默认工作区改路径时名称保持固定文案", () => {
    useProjectStore.getState().syncDefaultWorkspace("/data/default");
    useProjectStore.getState().updateProject(DEFAULT_WORKSPACE_PROJECT_ID, { name: "别名", path: "/data/next" });

    const project = useProjectStore.getState().projects[0];
    expect(project.id).toBe(DEFAULT_WORKSPACE_PROJECT_ID);
    expect(project.name).toBe(DEFAULT_WORKSPACE_NAME);
    expect(project.path).toBe("/data/next");
  });

  it("内置默认工作区不能被删除，也不能被拖到别的位置", () => {
    useProjectStore.getState().syncDefaultWorkspace("/data/default");
    useProjectStore.getState().removeProject(DEFAULT_WORKSPACE_PROJECT_ID);
    expect(useProjectStore.getState().projects.some(isDefaultWorkspaceProject)).toBe(true);

    useProjectStore.getState().reorderProjects("project-1", DEFAULT_WORKSPACE_PROJECT_ID, false);
    expect(useProjectStore.getState().projects[0].id).toBe(DEFAULT_WORKSPACE_PROJECT_ID);
  });

  it("记住项目卡片的展开/收起状态", () => {
    const projectId = useProjectStore.getState().projects[0].id;

    useProjectStore.getState().setProjectSessionsCollapsed(projectId, true);
    expect(
      useProjectStore.getState().projects.find((project) => project.id === projectId)?.sessionsCollapsed,
    ).toBe(true);

    // 同值不产生新数组（避免没必要的重渲染与写盘）。
    const before = useProjectStore.getState().projects;
    useProjectStore.getState().setProjectSessionsCollapsed(projectId, true);
    expect(useProjectStore.getState().projects).toBe(before);

    useProjectStore.getState().setProjectSessionsCollapsed(projectId, false);
    expect(
      useProjectStore.getState().projects.find((project) => project.id === projectId)?.sessionsCollapsed,
    ).toBe(false);
  });
});
