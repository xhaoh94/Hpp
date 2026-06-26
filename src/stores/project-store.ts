import { create } from "zustand";
import { AVAILABLE_AGENTS } from "@/lib/agents";

export interface ProjectSession {
  id: string;
  agentId: string;
  agentSessionId: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  sessionFilePath?: string;
  closed?: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  agents: string[];
  sessions: ProjectSession[];
}

export type AgentStatus = "idle" | "running" | "completed";

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  agentStatuses: Record<string, AgentStatus>; // sessionId -> status
  initializedSessionIds: Set<string>; // session IDs with agent backend created
  addProject: (name: string, path: string) => void;
  removeProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;
  addSession: (projectId: string, session: ProjectSession) => void;
  removeSession: (projectId: string, sessionId: string) => void;
  closeSession: (projectId: string, sessionId: string) => void;
  reopenSession: (projectId: string, sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
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

  addProject: (name, path) =>
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
            agents: AVAILABLE_AGENTS.map((a) => a.id),
            sessions: [],
          },
        ],
        activeProjectId: newId,
      };
    }),

  removeProject: (id) =>
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
    })),

  setActiveProject: (id) => set({ activeProjectId: id }),

  addSession: (projectId, session) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, sessions: [...p.sessions, session] } : p
      ),
      activeSessionId: session.id,
    })),

  removeSession: (projectId, sessionId) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? { ...p, sessions: p.sessions.filter((se) => se.id !== sessionId) }
          : p
      ),
      activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
    })),

  closeSession: (projectId, sessionId) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              sessions: p.sessions.map((se) =>
                se.id === sessionId ? { ...se, closed: true } : se
              ),
            }
          : p
      ),
      activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
    })),

  reopenSession: (projectId, sessionId) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              sessions: p.sessions.map((se) =>
                se.id === sessionId ? { ...se, closed: false } : se
              ),
            }
          : p
      ),
    })),

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

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
    set((s) => ({
      agentStatuses: { ...s.agentStatuses, [sessionId]: status },
    })),

  markSessionInitialized: (sessionId) =>
    set((s) => {
      const next = new Set(s.initializedSessionIds);
      next.add(sessionId);
      return { initializedSessionIds: next };
    }),

  isSessionInitialized: (sessionId) => get().initializedSessionIds.has(sessionId),
}));
