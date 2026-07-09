import { useMemo, useState, useEffect } from "react";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import { useChatStore } from "@/stores/chat-store";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { SessionHistoryModal } from "@/components/shared/SessionHistoryModal";
import { getAgentName, getInstallHint, normalizeAgentOrder, orderAgents } from "@/lib/agents";
import { applySessionModels, getSessionModel, getSessionThinkingOrDefault } from "@/hooks/useDataPersistence";
import { GitBranch } from "lucide-react";

const AGENT_SETTINGS_UPDATED_EVENT = "agent-settings-updated";

// Braille Spinner
const BRAILLE_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const getSessionAgentBadgeLabel = (agentId: string) => agentId.trim() || "agent";

function BrailleSpinner() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setIndex((p) => (p + 1) % BRAILLE_CHARS.length), 80);
    return () => clearInterval(timer);
  }, []);
  return <span className="braille-spinner">{BRAILLE_CHARS[index]}</span>;
}

interface Props {
  project: Project;
}

export function ProjectCard({ project }: Props) {
  const { removeProject, addSession, removeSession, closeSession, reopenSession, setActiveProject, activeProjectId, activeSessionId, setActiveSession, agentStatuses, setAgentStatus, markSessionInitialized } = useProjectStore();
  const {
    clearMessages,
    addMessage,
    clearAgentStartupErrors,
    sessionMessages,
    loadSessionMessages,
    switchSession,
    setActiveAgent,
    deleteSessionMessages,
    deleteSessionsMessages,
  } = useChatStore();
  const [showHistory, setShowHistory] = useState(false);
  const [agentOrder, setAgentOrder] = useState<string[]>([]);
  const [installedAgents, setInstalledAgents] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const agents = useAgentCatalogStore((state) => state.agents);
  const loadAgents = useAgentCatalogStore((state) => state.loadAgents);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // Load display order and package status; plugin catalog controls which buttons are shown.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      // Load settings
      const data = await window.electronAPI.loadData("settings");
      if (cancelled) return;
      const settings = asRecord(data);
      const general = asRecord(settings.general);
      setAgentOrder(normalizeAgentOrder(getStringArray(general.agentOrder), agents));
      setLoading(false);

      // Check all agents in parallel
      const checks = agents.map(async (agent) => {
        try {
          const status = await window.electronAPI.agentGetStatus(agent.id);
          return { id: agent.id, installed: status.installed };
        } catch {
          return { id: agent.id, installed: false };
        }
      });
      const results = await Promise.all(checks);
      if (cancelled) return;
      const installed: Record<string, boolean> = {};
      for (const r of results) {
        installed[r.id] = r.installed;
      }
      setInstalledAgents(installed);
    };
    run();
    return () => { cancelled = true; };
  }, [agents]);

  useEffect(() => {
    const handleAgentSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ agentOrder?: string[] }>).detail;
      if (Array.isArray(detail?.agentOrder)) setAgentOrder(normalizeAgentOrder(detail.agentOrder, agents));
    };
    window.addEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
    return () => window.removeEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
  }, [agents]);

  const handleStartAgent = async (agentId: string) => {
    // Check if agent is installed before starting
    let packageInstalled = installedAgents[agentId];
    if (packageInstalled !== true) {
      try {
        const status = await window.electronAPI.agentGetStatus(agentId);
        packageInstalled = status.installed;
        setInstalledAgents((prev) => ({ ...prev, [agentId]: status.installed }));
      } catch {
        packageInstalled = false;
      }
    }

    if (packageInstalled !== true) {
      const agent = agents.find((a) => a.id === agentId);
      const name = agent?.name || agentId;
      const cmd = agent?.command || agentId;
      alert(`${name} 未安装，请先安装：\n\n${getInstallHint(cmd)}`);
      return;
    }

    setActiveProject(project.id);

    // Create session object immediately so UI is responsive
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      agentId,
      agentSessionId: sessionId,
      title: `新会话 - ${new Date().toLocaleString("zh-CN")}`,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    addSession(project.id, session);

    // Switch chat to the new (empty) session
    setActiveAgent(agentId);
    switchSession(sessionId);

    // Start agent in background (non-blocking)
    window.electronAPI.agentCreateSession(agentId, project.path, sessionId).then(async (result) => {
      markSessionInitialized(sessionId);
      // Save sessionFilePath back to store so it can be resumed later.
      if (result.sessionFilePath) {
        useProjectStore.getState().setSessionFilePath(project.id, sessionId, result.sessionFilePath);
      }

      const isStillActiveSession = () => useProjectStore.getState().activeSessionId === sessionId;
      if (isStillActiveSession()) {
        applySessionModels(sessionId, result.models);
      }

      // Re-fetch models now that agent backend is ready
      try {
        const models = await window.electronAPI.agentGetModels(sessionId);
        if (isStillActiveSession() && models && models.length > 0) {
          useChatStore.getState().setAvailableModels(models);
          // New session: always use first model for the agent
          useChatStore.getState().setCurrentModel(models[0]);
        }
      } catch { /* ignore */ }
      if (isStillActiveSession()) {
        const thinkingToSet = await getSessionThinkingOrDefault(sessionId, agentId);
        if (isStillActiveSession()) {
          useChatStore.getState().setThinkingLevel(thinkingToSet);
          window.electronAPI.agentSetThinkingLevel(thinkingToSet, sessionId);
        }
      }
      if (!result.success) {
        clearAgentStartupErrors(sessionId);
        addMessage({
          id: crypto.randomUUID(),
          role: "system",
          content: `Agent 启动失败: ${result.error || "Agent 会话初始化失败"}`,
          timestamp: Date.now(),
          systemType: "agent_startup_error",
        }, sessionId);
      } else {
        clearAgentStartupErrors(sessionId);
      }
    }).catch((error: unknown) => {
      markSessionInitialized(sessionId);
      clearAgentStartupErrors(sessionId);
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `Agent 启动失败: ${getErrorMessage(error)}`,
        timestamp: Date.now(),
        systemType: "agent_startup_error",
      }, sessionId);
    });
  };

  const handleSelectSession = async (session: ProjectSession) => {
    setShowHistory(false);

    // Save current session's messages before switching
    const prevSessionId = activeSessionId;
    if (prevSessionId) {
      const currentMessages = useChatStore.getState().messages;
      loadSessionMessages(prevSessionId, currentMessages);
    }

    // Switch UI immediately for responsiveness
    setActiveSession(session.id);
    setActiveProject(project.id);
    setActiveAgent(session.agentId);
    switchSession(session.id);
    // Dismiss completed status so the green dot disappears permanently
    if (agentStatuses[session.id] === "completed") {
      setAgentStatus(session.id, "idle");
    }

    // Create and switch agent session in background (non-blocking)
    window.electronAPI.agentCreateSession(
      session.agentId, project.path, session.id, session.sessionFilePath
    ).then(async (result) => {
      if (result.sessionFilePath) {
        useProjectStore.getState().setSessionFilePath(project.id, session.id, result.sessionFilePath);
      }
      if (result.success) {
        clearAgentStartupErrors(session.id);
      }
      if (useProjectStore.getState().activeSessionId === session.id) {
        applySessionModels(session.id, result.models);
      }
      markSessionInitialized(session.id);
      if (!result.success) {
        clearAgentStartupErrors(session.id);
        addMessage({
          id: crypto.randomUUID(),
          role: "system",
          content: `Agent 启动失败: ${result.error || "Agent 会话初始化失败"}`,
          timestamp: Date.now(),
          systemType: "agent_startup_error",
        }, session.id);
      }
      // Only update if this session is still the active one
      if (useProjectStore.getState().activeSessionId === session.id) {
        await window.electronAPI.agentSwitchSession(session.id);
        try {
          const models = await window.electronAPI.agentGetModels(session.id);
          if (models && models.length > 0) {
            useChatStore.getState().setAvailableModels(models);
            // Restore per-session persisted model if available, otherwise use first
            const persisted = getSessionModel(session.id);
            const match = persisted
              ? models.find(m => m.id === persisted.id && m.provider === persisted.provider)
              : undefined;
            useChatStore.getState().setCurrentModel(match || models[0]);
          }
          const thinkingToSet = await getSessionThinkingOrDefault(session.id, session.agentId);
          if (useProjectStore.getState().activeSessionId === session.id) {
            useChatStore.getState().setThinkingLevel(thinkingToSet);
            window.electronAPI.agentSetThinkingLevel(thinkingToSet, session.id);
          }
        } catch { /* ignore */ }
      }
    }).catch((error: unknown) => {
      markSessionInitialized(session.id);
      clearAgentStartupErrors(session.id);
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `Agent 启动失败: ${getErrorMessage(error)}`,
        timestamp: Date.now(),
        systemType: "agent_startup_error",
      }, session.id);
    });
  };

  const handleCloseSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    closeSession(project.id, sessionId);
    // Tell the main process to dispose this session's agent
    window.electronAPI.agentRemoveSession(sessionId);
    // Clear messages if closing active session
    if (sessionId === activeSessionId) {
      clearMessages();
      setActiveSession(null);
    }
  };

  const disposeAgentSessions = (sessionIds: string[]) => {
    for (const sessionId of sessionIds) {
      void window.electronAPI.agentRemoveSession(sessionId);
    }
  };

  const handleDeleteProject = () => {
    const sessionIds = project.sessions.map((session) => session.id);
    disposeAgentSessions(sessionIds);
    deleteSessionsMessages(sessionIds);
    removeProject(project.id);
  };

  const handleResumeSession = (session: ProjectSession) => {
    reopenSession(project.id, session.id);
    handleSelectSession(session);
    setShowHistory(false);
  };

  const handleDeleteHistorySession = (sessionId: string) => {
    void window.electronAPI.agentRemoveSession(sessionId);
    deleteSessionMessages(sessionId);
    removeSession(project.id, sessionId);
  };

  const orderedAgents = useMemo(
    () => orderAgents(agents, agentOrder),
    [agents, agentOrder]
  );
  const cardAgents = orderedAgents;
  const openSessions = useMemo(
    () => project.sessions.filter((session) => !session.closed),
    [project.sessions]
  );
  const closedSessions = useMemo(
    () => project.sessions.filter((session) => session.closed),
    [project.sessions]
  );

  return (
    <>
      <div className={`project-item always-active ${project.id === activeProjectId ? "active" : ""}`}>
        <div className="project-info">
          <button
            className="project-close-btn"
            onClick={handleDeleteProject}
            title="删除项目"
          >
            ×
          </button>
          {project.sessions.some(s => s.closed) && (
            <button
              className="project-history-btn"
              onClick={() => setShowHistory(true)}
              title="历史会话"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M21 12C21 16.4183 16.9706 20 12 20C10.5109 20 9.11662 19.6978 7.88198 19.1546L3 21L4.39455 16.8328C3.51219 15.4868 3 13.8077 3 12C3 7.58172 7.02944 4 12 4C16.9706 4 21 7.58172 21 12Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <div className="project-name">{project.name}</div>
          <div className="project-path" title={project.path}>{project.path}</div>
          <div className="project-terminals">
            {loading ? (
              <div className="project-terminals-loading">
                <BrailleSpinner />
                <span style={{ fontSize: 11, color: '#888', marginLeft: 4 }}>检查 Agent...</span>
              </div>
            ) : (
              <>
                {cardAgents.map((a) => (
                  <div
                    key={a.id}
                    className="project-terminal-btn"
                    onClick={() => handleStartAgent(a.id)}
                    title={`启动 ${a.name}`}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M7 8L10 11L7 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M12 14H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    <span>{a.id}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Session tabs - tree child nodes (newest at bottom), filtered to non-closed sessions */}
      {openSessions.length > 0 && (
        <div className="project-terminal-children">
          {openSessions.map((session) => {
            const status = agentStatuses[session.id];
            const agentBadgeLabel = getSessionAgentBadgeLabel(session.agentId);
            return (
              <div
                key={session.id}
                className={`project-terminal-child ${session.id === activeSessionId ? "active" : ""}`}
                onClick={() => handleSelectSession(session)}
              >
                {status === "running" && <BrailleSpinner />}
                <span
                  className="terminal-child-agent-badge"
                  title={getAgentName(session.agentId)}
                >
                  {agentBadgeLabel}
                </span>
                <span className="terminal-child-title">
                  {(() => {
                    const msgs = sessionMessages[session.id];
                    const firstUserMsg = msgs?.find((m) => m.role === "user");
                    return firstUserMsg
                      ? firstUserMsg.content.length > 30
                        ? firstUserMsg.content.substring(0, 30) + "..."
                        : firstUserMsg.content
                      : session.title;
                  })()}
                </span>
                {(session.forkedFrom || session.forkContext) && (
                  <span
                    className="terminal-child-fork-badge"
                    title={`Fork 自 ${session.forkedFrom?.sourceTitle || session.forkContext?.sourceTitle || "原会话"}`}
                  >
                    <GitBranch size={11} strokeWidth={2} />
                  </span>
                )}
                {status === "completed" && session.id !== activeSessionId && (
                  <span className="terminal-child-dot" />
                )}
                <button
                  className="terminal-child-close"
                  onClick={(e) => handleCloseSession(e, session.id)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      <SessionHistoryModal
        isOpen={showHistory}
        onClose={() => setShowHistory(false)}
        sessions={closedSessions}
        sessionMessages={sessionMessages}
        onResume={handleResumeSession}
        onDelete={handleDeleteHistorySession}
      />
    </>
  );
}
