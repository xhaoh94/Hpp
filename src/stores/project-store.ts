import { create } from "zustand";

export interface ProjectSession {
  id: string;
  agentId: string;
  agentSessionId: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  sessionFilePath?: string;
  closed?: boolean;
  references?: SessionReference[];
  forkedFrom?: SessionForkOrigin;
  forkContext?: SessionForkContext;
}

export interface SessionForkOrigin {
  sourceSessionId: string;
  sourceTitle: string;
  throughMessageId: string;
  createdAt: string;
}

export interface SessionForkContext {
  sourceSessionId: string;
  sourceTitle: string;
  throughMessageId: string;
  createdAt: string;
  messageCount: number;
  context: string;
}

export interface SessionReference {
  sourceSessionId: string;
  sourceAgentId: string;
  sourceTitle: string;
  sourceUpdatedAt: string;
  addedAt: string;
  summary: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  agents: string[];
  sessions: ProjectSession[];
}

export type AgentStatus = "idle" | "running" | "completed" | "error";

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  agentStatuses: Record<string, AgentStatus>; // sessionId -> status
  initializedSessionIds: Set<string>; // session IDs with agent backend created
  addProject: (name: string, path: string, agentIds?: string[]) => void;
  removeProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;
  addSession: (projectId: string, session: ProjectSession) => void;
  removeSession: (projectId: string, sessionId: string) => void;
  closeSession: (projectId: string, sessionId: string) => void;
  reopenSession: (projectId: string, sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  upsertSessionReference: (projectId: string, sessionId: string, reference: SessionReference) => void;
  removeSessionReference: (projectId: string, sessionId: string, sourceSessionId: string) => void;
  setSessionForkContext: (projectId: string, sessionId: string, forkContext?: SessionForkContext) => void;
  setSessionFilePath: (projectId: string, sessionId: string, sessionFilePath: string) => void;
  setAgentStatus: (sessionId: string, status: AgentStatus) => void;
  markSessionInitialized: (sessionId: string) => void;
  isSessionInitialized: (sessionId: string) => boolean;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  activeSessionId: null,
  agentStatuses: {},
  initializedSessionIds: new Set<string>(),

  addProject: (name, path, agentIds = []) =>
    set((s) => {
      const newId = crypto.randomUUID();
      return {
        projects: [
          ...s.projects,
          {
            id: newId,
            name,
            path,
            createdAt: new Date().toISOString(),
            agents: agentIds,
            sessions: [],
          },
        ],
        activeProjectId: newId,
      };
    }),

  removeProject: (id) =>
    set((s) => {
      const project = s.projects.find((p) => p.id === id);
      const removedSessionIds = new Set(project?.sessions.map((session) => session.id) || []);
      const nextAgentStatuses = { ...s.agentStatuses };
      for (const sessionId of removedSessionIds) {
        delete nextAgentStatuses[sessionId];
      }
      const nextInitializedSessionIds = new Set(s.initializedSessionIds);
      for (const sessionId of removedSessionIds) {
        nextInitializedSessionIds.delete(sessionId);
      }
      return {
        projects: s.projects.filter((p) => p.id !== id),
        activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
        activeSessionId: s.activeSessionId && removedSessionIds.has(s.activeSessionId) ? null : s.activeSessionId,
        agentStatuses: nextAgentStatuses,
        initializedSessionIds: nextInitializedSessionIds,
      };
    }),

  setActiveProject: (id) => set({ activeProjectId: id }),

  addSession: (projectId, session) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, sessions: [...p.sessions, session] } : p
      ),
      activeSessionId: session.id,
    })),

  removeSession: (projectId, sessionId) =>
    set((s) => {
      const nextAgentStatuses = { ...s.agentStatuses };
      delete nextAgentStatuses[sessionId];
      const nextInitializedSessionIds = new Set(s.initializedSessionIds);
      nextInitializedSessionIds.delete(sessionId);
      return {
        projects: s.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                sessions: p.sessions
                  .filter((se) => se.id !== sessionId)
                  .map((se) => ({
                    ...se,
                    references: se.references?.filter((ref) => ref.sourceSessionId !== sessionId),
                  })),
              }
            : p
        ),
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
        agentStatuses: nextAgentStatuses,
        initializedSessionIds: nextInitializedSessionIds,
      };
    }),

  closeSession: (projectId, sessionId) =>
    set((s) => {
      const now = new Date().toISOString();
      return {
        projects: s.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                sessions: p.sessions.map((se) =>
                  se.id === sessionId ? { ...se, closed: true, lastActiveAt: now } : se
                ),
              }
            : p
        ),
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
      };
    }),

  reopenSession: (projectId, sessionId) =>
    set((s) => {
      const now = new Date().toISOString();
      return {
        projects: s.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                sessions: p.sessions.map((se) =>
                  se.id === sessionId ? { ...se, closed: false, lastActiveAt: now } : se
                ),
              }
            : p
        ),
      };
    }),

  setActiveSession: (sessionId) => set((s) => {
    if (s.activeSessionId === sessionId) return {};
    if (!sessionId) return { activeSessionId: null };
    const now = new Date().toISOString();
    return {
      activeSessionId: sessionId,
      projects: s.projects.map((p) => ({
        ...p,
        sessions: p.sessions.map((se) =>
          se.id === sessionId ? { ...se, lastActiveAt: now } : se
        ),
      })),
    };
  }),

  upsertSessionReference: (projectId, sessionId, reference) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              sessions: p.sessions.map((se) => {
                if (se.id !== sessionId) return se;
                const existing = se.references || [];
                const nextReferences = [
                  ...existing.filter((ref) => ref.sourceSessionId !== reference.sourceSessionId),
                  reference,
                ];
                return { ...se, references: nextReferences };
              }),
            }
          : p
      ),
    })),

  removeSessionReference: (projectId, sessionId, sourceSessionId) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              sessions: p.sessions.map((se) =>
                se.id === sessionId
                  ? {
                      ...se,
                      references: se.references?.filter((ref) => ref.sourceSessionId !== sourceSessionId),
                    }
                  : se
              ),
            }
          : p
      ),
    })),

  setSessionForkContext: (projectId, sessionId, forkContext) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              sessions: p.sessions.map((se) => {
                if (se.id !== sessionId) return se;
                if (forkContext) return { ...se, forkContext };
                const next = { ...se };
                delete next.forkContext;
                return next;
              }),
            }
          : p
      ),
    })),

  setSessionFilePath: (projectId, sessionId, sessionFilePath) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              sessions: p.sessions.map((se) =>
                se.id === sessionId && se.sessionFilePath !== sessionFilePath
                  ? { ...se, sessionFilePath }
                  : se
              ),
            }
          : p
      ),
    })),

  setAgentStatus: (sessionId, status) =>
    set((s) => (
      s.agentStatuses[sessionId] === status
        ? {}
        : { agentStatuses: { ...s.agentStatuses, [sessionId]: status } }
    )),

  markSessionInitialized: (sessionId) =>
    set((s) => {
      if (s.initializedSessionIds.has(sessionId)) return {};
      const next = new Set(s.initializedSessionIds);
      next.add(sessionId);
      return { initializedSessionIds: next };
    }),

  isSessionInitialized: (sessionId) => get().initializedSessionIds.has(sessionId),
}));
