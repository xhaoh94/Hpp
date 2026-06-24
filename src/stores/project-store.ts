import { create } from "zustand";

export interface ProjectSession {
  id: string;
  agentId: string;
  agentSessionId: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  sessionFilePath?: string;
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
  addProject: (name: string, path: string) => void;
  removeProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;
  addSession: (projectId: string, session: ProjectSession) => void;
  removeSession: (projectId: string, sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  setAgentStatus: (sessionId: string, status: AgentStatus) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  activeProjectId: null,
  activeSessionId: null,
  agentStatuses: {},

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
            agents: ["pi"],
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

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  setAgentStatus: (sessionId, status) =>
    set((s) => ({
      agentStatuses: { ...s.agentStatuses, [sessionId]: status },
    })),
}));
