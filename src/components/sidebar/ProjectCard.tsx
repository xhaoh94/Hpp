import { useState, useEffect } from "react";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import { useChatStore, type ModelInfo } from "@/stores/chat-store";
import { SessionHistoryModal } from "@/components/shared/SessionHistoryModal";
import { AVAILABLE_AGENTS, getAgentName, getInstallHint } from "@/lib/agents";
import { applySessionModels, getSessionModel, getSessionThinking } from "@/hooks/useDataPersistence";

// Braille Spinner
const BRAILLE_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
  const { removeProject, addSession, removeSession, closeSession, reopenSession, setActiveProject, activeSessionId, setActiveSession, agentStatuses, setAgentStatus, markSessionInitialized, isSessionInitialized, setSessionFilePath } = useProjectStore();
  const { clearMessages, addMessage, sessionMessages, loadSessionMessages, switchSession, setActiveAgent } = useChatStore();
  const [showHistory, setShowHistory] = useState(false);
  const [enabledAgents, setEnabledAgents] = useState<string[]>(["pi"]);
  const [installedAgents, setInstalledAgents] = useState<Record<string, boolean>>({});
  const [showAddAgent, setShowAddAgent] = useState(false);

  // Load enabled agents from settings
  useEffect(() => {
    window.electronAPI.loadData("settings").then((data: any) => {
      if (data?.general?.enabledAgents) {
        setEnabledAgents(data.general.enabledAgents);
      }
    });
  }, []);

  // Check which agents are installed
  useEffect(() => {
    for (const agent of AVAILABLE_AGENTS) {
      if (agent.id === "pi") {
        window.electronAPI.piSDKGetStatus().then((status) => {
          setInstalledAgents((prev) => ({ ...prev, [agent.id]: status.installed }));
        });
        continue;
      }

      if (agent.runtime !== "cli" || !agent.command) continue;
      window.electronAPI.isCommandAvailable(agent.command).then((ok) => {
        setInstalledAgents((prev) => ({ ...prev, [agent.id]: ok }));
      });
    }
  }, []);

  // Close add agent popup on outside click
  useEffect(() => {
    if (!showAddAgent) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".project-terminal-btn-add") && !target.closest(".agent-add-popup")) {
        setShowAddAgent(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showAddAgent]);

  const handleStartAgent = async (agentId: string) => {
    // Check if agent is installed before starting
    if (installedAgents[agentId] !== true) {
      const agent = AVAILABLE_AGENTS.find((a) => a.id === agentId);
      const name = agent?.name || agentId;
      const cmd = agent?.id === "pi" ? "pi" : agent?.command || agentId;
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
      applySessionModels(sessionId, result.models);
      // Re-fetch models now that agent backend is ready
      try {
        const models = await window.electronAPI.agentGetModels(sessionId);
        if (models && models.length > 0) {
          useChatStore.getState().setAvailableModels(models);
          // New session: always use first model for the agent
          useChatStore.getState().setCurrentModel(models[0]);
        }
      } catch { /* ignore */ }
      // New session: default thinking level to "medium"
      useChatStore.getState().setThinkingLevel("medium");
      window.electronAPI.agentSetThinkingLevel("medium");
      if (!result.success) {
        addMessage({
          id: crypto.randomUUID(),
          role: "system",
          content: `Agent 启动失败: ${result.error}`,
          timestamp: Date.now(),
        });
      }
    });
  };

  const handleSelectSession = async (session: ProjectSession) => {
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
    setAgentStatus(session.id, "idle");

    // Create and switch agent session in background (non-blocking)
    window.electronAPI.agentCreateSession(
      session.agentId, project.path, session.id, session.sessionFilePath
    ).then(async (result) => {
      if (result.sessionFilePath) {
        useProjectStore.getState().setSessionFilePath(project.id, session.id, result.sessionFilePath);
      }
      if (useProjectStore.getState().activeSessionId === session.id) {
        applySessionModels(session.id, result.models);
      }
      markSessionInitialized(session.id);
      // Only update if this session is still the active one
      if (useProjectStore.getState().activeSessionId === session.id) {
        await window.electronAPI.agentSwitchSession(session.id);
        try {
          const models = await window.electronAPI.agentGetModels(session.id);
          if (models && models.length > 0) {
            useChatStore.getState().setAvailableModels(models);
            // Restore per-session persisted model if available, otherwise use first
            const persisted = getSessionModel(session.id);
            const match = persisted && models.some(m => m.id === persisted.id && m.provider === persisted.provider);
            useChatStore.getState().setCurrentModel(match ? persisted : models[0]);
          }
          // Restore per-session thinking level (default to "medium" if none persisted)
          const persistedThinking = getSessionThinking(session.id);
          const thinkingToSet = persistedThinking || "medium";
          useChatStore.getState().setThinkingLevel(thinkingToSet);
          window.electronAPI.agentSetThinkingLevel(thinkingToSet);
        } catch { /* ignore */ }
      }
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

  const handleResumeSession = (session: ProjectSession) => {
    reopenSession(project.id, session.id);
    handleSelectSession(session);
    setShowHistory(false);
  };

  const handleDeleteHistorySession = (sessionId: string) => {
    removeSession(project.id, sessionId);
  };

  const uncheckedAgents = AVAILABLE_AGENTS.filter(
    (a) => !enabledAgents.includes(a.id) && installedAgents[a.id] === true
  );

  return (
    <>
      <div className="project-item always-active">
        <div className="project-info">
          <button
            className="project-close-btn"
            onClick={() => removeProject(project.id)}
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
            {AVAILABLE_AGENTS.filter((a) => enabledAgents.includes(a.id) && installedAgents[a.id] === true).map((a) => (
              <div
                key={a.id}
                className="project-terminal-btn"
                onClick={() => handleStartAgent(a.id)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M7 8L10 11L7 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12 14H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <span>{a.id === "pi" ? "PI" : a.id === "opencode" ? "OC" : a.id === "droid" ? "FD" : a.id}</span>
              </div>
            ))}
            {/* Add agent button - only show when there are unchecked agents */}
            {uncheckedAgents.length > 0 && (
              <div className="relative">
                <div
                  className="project-terminal-btn project-terminal-btn-add"
                  onClick={() => setShowAddAgent(!showAddAgent)}
                  title="新建 Agent 会话"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                  </svg>
                </div>
                {showAddAgent && (
                  <div className="agent-add-popup">
                    {uncheckedAgents.map((agent) => (
                      <div
                        key={agent.id}
                        className="agent-add-item"
                        onClick={() => { handleStartAgent(agent.id); setShowAddAgent(false); }}
                      >
                        <span className="agent-add-name">{agent.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Session tabs - tree child nodes (newest at bottom), filtered to non-closed sessions */}
      {project.sessions.filter(s => !s.closed).length > 0 && (
        <div className="project-terminal-children">
          {project.sessions.filter(s => !s.closed).map((session) => {
            const status = agentStatuses[session.id];
            return (
              <div
                key={session.id}
                className={`project-terminal-child ${session.id === activeSessionId ? "active" : ""}`}
                onClick={() => handleSelectSession(session)}
              >
                {status === "running" ? (
                  <BrailleSpinner />
                ) : (
                  <svg className="terminal-child-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M7 8L10 11L7 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M12 14H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                )}
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
        sessions={project.sessions.filter(s => s.closed)}
        sessionMessages={sessionMessages}
        onResume={handleResumeSession}
        onDelete={handleDeleteHistorySession}
      />
    </>
  );
}
