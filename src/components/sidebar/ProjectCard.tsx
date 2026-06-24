import { useState, useEffect } from "react";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import { useChatStore } from "@/stores/chat-store";
import { SessionHistoryModal } from "@/components/shared/SessionHistoryModal";
import { AVAILABLE_AGENTS } from "@/lib/agents";

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
  const { removeProject, addSession, removeSession, setActiveProject, activeSessionId, setActiveSession, agentStatuses, setAgentStatus } = useProjectStore();
  const { clearMessages, addMessage, sessionMessages, loadSessionMessages, switchSession } = useChatStore();
  const [showHistory, setShowHistory] = useState(false);
  const [enabledAgents, setEnabledAgents] = useState<string[]>(["pi"]);
  const [showAddAgent, setShowAddAgent] = useState(false);

  // Load enabled agents from settings
  useEffect(() => {
    window.electronAPI.loadData("settings").then((data: any) => {
      if (data?.general?.enabledAgents) {
        setEnabledAgents(data.general.enabledAgents);
      }
    });
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
    setActiveProject(project.id);

    // Create session - must await so agent is ready before user sends messages
    const sessionId = crypto.randomUUID();
    const result = await window.electronAPI.agentCreateSession(agentId, project.path, sessionId);

    const session = {
      id: sessionId,
      agentId,
      agentSessionId: sessionId,
      title: `新会话 - ${new Date().toLocaleString("zh-CN")}`,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      sessionFilePath: result.sessionFilePath || undefined,
    };
    addSession(project.id, session);

    // Switch chat to the new (empty) session
    switchSession(sessionId);

    if (!result.success) {
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `Agent 启动失败: ${result.error}`,
        timestamp: Date.now(),
      });
    }
  };

  const handleSelectSession = async (session: ProjectSession) => {
    // Save current session's messages before switching
    const prevSessionId = activeSessionId;
    if (prevSessionId) {
      const currentMessages = useChatStore.getState().messages;
      loadSessionMessages(prevSessionId, currentMessages);
    }

    // Tell the main process to switch the agent session and wait for it
    await window.electronAPI.agentSwitchSession(session.id);

    // Then update UI state
    setActiveSession(session.id);
    setActiveProject(project.id);
    switchSession(session.id);
  };

  const handleDeleteSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    removeSession(project.id, sessionId);
    // Tell the main process to dispose this session's agent
    window.electronAPI.agentRemoveSession(sessionId);
    // Clear messages if deleting active session
    if (sessionId === activeSessionId) {
      clearMessages();
      setActiveSession(null);
    }
  };

  const handleResumeSession = (session: ProjectSession) => {
    handleStartAgent(session.agentId);
    setShowHistory(false);
  };

  const handleDeleteHistorySession = (sessionId: string) => {
    removeSession(project.id, sessionId);
  };

  const uncheckedAgents = AVAILABLE_AGENTS.filter((a) => !enabledAgents.includes(a.id));

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
          {project.sessions.length > 0 && (
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
            {project.agents.filter((agentId) => enabledAgents.includes(agentId)).map((agentId) => (
              <div
                key={agentId}
                className="project-terminal-btn"
                onClick={() => handleStartAgent(agentId)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M7 8L10 11L7 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12 14H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <span>{agentId === "pi" ? "PI" : agentId}</span>
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
                        <span className="agent-add-desc">{agent.desc}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Session tabs - tree child nodes (newest at bottom) */}
      {project.sessions.length > 0 && (
        <div className="project-terminal-children">
          {project.sessions.map((session) => {
            const status = agentStatuses[session.id];
            return (
              <div
                key={session.id}
                className={`project-terminal-child ${session.id === activeSessionId ? "active" : ""}`}
                onClick={() => handleSelectSession(session)}
              >
                {status === "running" ? (
                  <BrailleSpinner />
                ) : status === "completed" ? (
                  <svg className="terminal-child-icon completed" width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M3 7L6 10L11 4" stroke="var(--text-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
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
                <button
                  className="terminal-child-close"
                  onClick={(e) => handleDeleteSession(e, session.id)}
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
        sessions={project.sessions}
        sessionMessages={sessionMessages}
        onResume={handleResumeSession}
        onDelete={handleDeleteHistorySession}
      />
    </>
  );
}
