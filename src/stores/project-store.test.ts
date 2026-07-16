import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore, type ProjectSession } from "./project-store";

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
