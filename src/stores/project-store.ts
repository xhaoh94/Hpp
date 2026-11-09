import { create } from "zustand";
import { isDefaultWorkspaceProject, withDefaultWorkspace } from "@/lib/default-workspace";

export interface ProjectSession {
  id: string;
  agentId: string;
  agentSessionId: string;
  title: string;
  /** 首条用户消息的轻量预览；正文仍按会话按需加载。 */
  preview?: string;
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
  /** 侧栏里该项目卡片是否收起会话列表；缺省表示“从未手动切换过”。 */
  sessionsCollapsed?: boolean;
}

export type AgentStatus = "idle" | "running" | "completed" | "error";

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  projectDataHydrated: boolean;
  agentStatuses: Record<string, AgentStatus>; // sessionId -> status
  initializedSessionIds: Set<string>; // session IDs with agent backend created
  /** 正在唤醒后端（spawn/握手/恢复上下文）的会话；仅用于 UI 展示，不参与持久化。 */
  initializingSessionIds: Set<string>;
  addProject: (name: string, path: string, agentIds?: string[]) => void;
  updateProject: (id: string, patch: { name?: string; path?: string }) => void;
  /** 记住侧栏项目卡片的展开/收起状态（随 projects.json 持久化）。 */
  setProjectSessionsCollapsed: (id: string, collapsed: boolean) => void;
  /** 同步内置默认工作区（固定首位），路径来自设置。 */
  syncDefaultWorkspace: (path: string) => void;
  removeProject: (id: string) => void;
  reorderProjects: (sourceId: string, targetId: string, insertAfter?: boolean) => void;
  setActiveProject: (id: string | null) => void;
  addSession: (projectId: string, session: ProjectSession, activate?: boolean) => void;
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
  markSessionInitializing: (sessionId: string) => void;
  clearSessionInitializing: (sessionId: string) => void;
  isSessionInitialized: (sessionId: string) => boolean;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  activeSessionId: null,
  projectDataHydrated: false,
  agentStatuses: {},
  initializedSessionIds: new Set<string>(),
  initializingSessionIds: new Set<string>(),

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

  updateProject: (id, patch) =>
    set((s) => {
      const name = patch.name?.trim();
      const path = patch.path?.trim();
      if (!name && !path) return s;
      return {
        projects: s.projects.map((project) => {
          if (project.id !== id) return project;
          // 内置工作区的名字是固定文案，只有路径跟着设置走。
          const nextName = isDefaultWorkspaceProject(project) || !name ? project.name : name;
          return {
            ...project,
            name: nextName,
            path: path || project.path,
          };
        }),
      };
    }),

  setProjectSessionsCollapsed: (id, collapsed) =>
    set((s) => {
      const target = s.projects.find((project) => project.id === id);
      if (!target || target.sessionsCollapsed === collapsed) return s;
      return {
        projects: s.projects.map((project) => (
          project.id === id ? { ...project, sessionsCollapsed: collapsed } : project
        )),
      };
    }),

  syncDefaultWorkspace: (path) =>
    set((s) => {
      const projects = withDefaultWorkspace(s.projects, path);
      return projects === s.projects ? {} : { projects };
    }),

  removeProject: (id) =>
    set((s) => {
      // 内置工作区不可删除：它的会话是用户的兜底入口。
      if (isDefaultWorkspaceProject({ id })) return s;
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

  reorderProjects: (sourceId, targetId, insertAfter = false) =>
    set((s) => {
      if (sourceId === targetId) return s;
      // 内置工作区永远置顶：既不能拖走，也不能被插到前面。
      if (isDefaultWorkspaceProject({ id: sourceId }) || isDefaultWorkspaceProject({ id: targetId })) return s;
      const sourceIndex = s.projects.findIndex((project) => project.id === sourceId);
      const targetIndex = s.projects.findIndex((project) => project.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return s;
      const projects = [...s.projects];
      const [moved] = projects.splice(sourceIndex, 1);
      const rawInsertionIndex = targetIndex + (insertAfter ? 1 : 0);
      const insertionIndex = sourceIndex < rawInsertionIndex ? rawInsertionIndex - 1 : rawInsertionIndex;
      if (insertionIndex === sourceIndex) return s;
      projects.splice(insertionIndex, 0, moved);
      return { projects };
    }),

  setActiveProject: (id) => set((s) => (
    s.activeProjectId === id ? {} : { activeProjectId: id }
  )),

  addSession: (projectId, session, activate = true) =>
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, sessions: [...p.sessions, session] } : p
      ),
      activeSessionId: activate ? session.id : s.activeSessionId,
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
      const nextAgentStatuses = { ...s.agentStatuses };
      delete nextAgentStatuses[sessionId];
      const nextInitializedSessionIds = new Set(s.initializedSessionIds);
      nextInitializedSessionIds.delete(sessionId);
      const nextInitializingSessionIds = new Set(s.initializingSessionIds);
      nextInitializingSessionIds.delete(sessionId);
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
        agentStatuses: nextAgentStatuses,
        initializedSessionIds: nextInitializedSessionIds,
        initializingSessionIds: nextInitializingSessionIds,
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

  markSessionInitializing: (sessionId) =>
    set((s) => {
      if (s.initializingSessionIds.has(sessionId)) return {};
      const next = new Set(s.initializingSessionIds);
      next.add(sessionId);
      return { initializingSessionIds: next };
    }),

  clearSessionInitializing: (sessionId) =>
    set((s) => {
      if (!s.initializingSessionIds.has(sessionId)) return {};
      const next = new Set(s.initializingSessionIds);
      next.delete(sessionId);
      return { initializingSessionIds: next };
    }),

  isSessionInitialized: (sessionId) => get().initializedSessionIds.has(sessionId),
}));
