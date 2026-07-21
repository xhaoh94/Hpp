import { useCallback, useMemo, useState, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useProjectStore, type Project, type ProjectSession } from "@/stores/project-store";
import { useChatStore } from "@/stores/chat-store";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { SessionHistoryModal } from "@/components/shared/SessionHistoryModal";
import { getAgentName, getInstallHint, normalizeAgentOrder, orderAgents } from "@/lib/agents";
import { SessionCommandCoordinator } from "@/lib/session-command-coordinator";
import { purgeDeletedSessionData } from "@/hooks/useDataPersistence";
import { calculateVisibleAgentCount } from "@/lib/agent-shortcuts-layout";
import { GitBranch, Terminal } from "lucide-react";

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

const getSessionSortTime = (session: ProjectSession) => {
  const timestamp = Date.parse(session.lastActiveAt || session.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

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
  const { removeProject, removeSession, activeProjectId, activeSessionId, agentStatuses } = useProjectStore();
  const {
    sessionMessages,
    deleteSessionsMessages,
  } = useChatStore();
  const [showHistory, setShowHistory] = useState(false);
  const [agentOrder, setAgentOrder] = useState<string[]>([]);
  const [installedAgents, setInstalledAgents] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [visibleAgentCount, setVisibleAgentCount] = useState(0);
  const [agentMenuPosition, setAgentMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const agentShortcutsRef = useRef<HTMLDivElement>(null);
  const agentMeasurementsRef = useRef<HTMLDivElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const agentMoreButtonRef = useRef<HTMLButtonElement>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);
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

  const updateAgentMenuPosition = useCallback(() => {
    const button = agentMoreButtonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setAgentMenuPosition({
      left: rect.left,
      top: rect.bottom + 5,
    });
  }, []);

  useEffect(() => {
    if (!showAgentPicker) {
      setAgentMenuPosition(null);
      return;
    }
    updateAgentMenuPosition();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !agentPickerRef.current?.contains(target) &&
        !agentMenuRef.current?.contains(target)
      ) {
        setShowAgentPicker(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowAgentPicker(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateAgentMenuPosition);
    window.addEventListener("scroll", updateAgentMenuPosition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateAgentMenuPosition);
      window.removeEventListener("scroll", updateAgentMenuPosition, true);
    };
  }, [showAgentPicker, updateAgentMenuPosition]);

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
      alert(`${name} 未安装，请先安装：\n\n${getInstallHint(agent || cmd)}`);
      return;
    }

    try {
      await SessionCommandCoordinator.createSession({
        projectId: project.id,
        agentId,
        activate: true,
        verifyInstalled: false,
      });
    } catch (error) {
      alert(getErrorMessage(error));
    }
  };

  const handleSelectSession = async (session: ProjectSession) => {
    setShowHistory(false);
    await SessionCommandCoordinator.initializeSession(session.id, {
      activate: true,
      recordFailure: true,
    });
  };

  const handleCloseSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    void SessionCommandCoordinator.closeSession(sessionId);
  };

  const handleDeleteProject = () => {
    const sessionIds = project.sessions.map((session) => session.id);
    void Promise.all(sessionIds.map((sessionId) => SessionCommandCoordinator.closeSession(sessionId)))
      .finally(() => {
        deleteSessionsMessages(sessionIds);
        removeProject(project.id);
        void purgeDeletedSessionData(sessionIds, [project.id]).catch((error) => {
          console.error("[persistence] project cleanup failed:", error);
        });
      });
  };

  const handleResumeSession = (session: ProjectSession) => {
    void SessionCommandCoordinator.reopenSession(session.id, { activate: true })
      .finally(() => setShowHistory(false));
  };

  const handleDeleteHistorySessions = async (sessionIds: string[]) => {
    const uniqueSessionIds = [...new Set(sessionIds)].filter((sessionId) =>
      project.sessions.some((session) => session.id === sessionId && session.closed)
    );
    if (uniqueSessionIds.length === 0) return;

    await Promise.allSettled(uniqueSessionIds.map((sessionId) =>
      SessionCommandCoordinator.closeSession(sessionId)
    ));
    deleteSessionsMessages(uniqueSessionIds);
    for (const sessionId of uniqueSessionIds) {
      removeSession(project.id, sessionId);
    }
    try {
      await purgeDeletedSessionData(uniqueSessionIds);
    } catch (error) {
      console.error("[persistence] session cleanup failed:", error);
      alert(`会话已从列表移除，但磁盘数据清理失败：${getErrorMessage(error)}`);
      throw error;
    }
  };

  const handleDeleteHistorySession = (sessionId: string) =>
    handleDeleteHistorySessions([sessionId]);

  const orderedAgents = useMemo(
    () => orderAgents(agents, agentOrder),
    [agents, agentOrder]
  );
  const cardAgents = orderedAgents.slice(0, visibleAgentCount);
  const overflowAgents = orderedAgents.slice(visibleAgentCount);

  useLayoutEffect(() => {
    if (loading) return;
    const container = agentShortcutsRef.current;
    const measurements = agentMeasurementsRef.current;
    if (!container || !measurements) return;

    let animationFrame = 0;
    const measure = () => {
      const buttons = Array.from(
        measurements.querySelectorAll<HTMLElement>("[data-agent-shortcut-measure]")
      );
      const moreButton = measurements.querySelector<HTMLElement>("[data-agent-more-measure]");
      const styles = window.getComputedStyle(container);
      const nextCount = calculateVisibleAgentCount(
        buttons.map((button) => button.getBoundingClientRect().width),
        container.clientWidth,
        moreButton?.getBoundingClientRect().width || 24,
        Number.parseFloat(styles.columnGap || styles.gap) || 0,
      );
      setVisibleAgentCount((current) => current === nextCount ? current : nextCount);
    };
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(measure);
    };

    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    observer?.observe(container);
    window.addEventListener("resize", scheduleMeasure);
    void document.fonts?.ready.then(scheduleMeasure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [loading, orderedAgents]);

  useEffect(() => {
    if (overflowAgents.length === 0) setShowAgentPicker(false);
  }, [overflowAgents.length]);
  const openSessions = useMemo(
    () => project.sessions.filter((session) => !session.closed),
    [project.sessions]
  );
  const closedSessions = useMemo(
    () => project.sessions
      .filter((session) => session.closed)
      .sort((a, b) => getSessionSortTime(b) - getSessionSortTime(a)),
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
          <div className="project-terminals" ref={agentShortcutsRef}>
            {loading ? (
              <div className="project-terminals-loading">
                <BrailleSpinner />
                <span style={{ fontSize: 11, color: '#888', marginLeft: 4 }}>检查 Agent...</span>
              </div>
            ) : (
              <>
                {cardAgents.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    className="project-terminal-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleStartAgent(a.id);
                    }}
                    title={`启动 ${a.name}`}
                  >
                    <span>{a.name}</span>
                  </button>
                ))}
                {overflowAgents.length > 0 && (
                  <div className="project-agent-picker" ref={agentPickerRef}>
                    <button
                      type="button"
                      ref={agentMoreButtonRef}
                      className="project-terminal-btn project-agent-more-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (showAgentPicker) {
                          setShowAgentPicker(false);
                        } else {
                          updateAgentMenuPosition();
                          setShowAgentPicker(true);
                        }
                      }}
                      title="选择其他 Agent"
                      aria-label="选择其他 Agent"
                      aria-haspopup="menu"
                      aria-expanded={showAgentPicker}
                    >
                      <Terminal size={13} strokeWidth={1.8} />
                    </button>
                    {showAgentPicker && agentMenuPosition && createPortal(
                      <div
                        className="project-agent-menu"
                        ref={agentMenuRef}
                        role="menu"
                        style={{ left: agentMenuPosition.left, top: agentMenuPosition.top }}
                      >
                        {overflowAgents.map((agent) => (
                          <button
                            type="button"
                            key={agent.id}
                            className="project-agent-menu-item"
                            onClick={(event) => {
                              event.stopPropagation();
                              setShowAgentPicker(false);
                              void handleStartAgent(agent.id);
                            }}
                            title={`启动 ${agent.name}`}
                            role="menuitem"
                          >
                            <span>{agent.name}</span>
                          </button>
                        ))}
                      </div>,
                      document.body
                    )}
                  </div>
                )}
                <div className="project-terminal-measurements" ref={agentMeasurementsRef} aria-hidden="true">
                  {orderedAgents.map((agent) => (
                    <button
                      type="button"
                      key={agent.id}
                      className="project-terminal-btn"
                      data-agent-shortcut-measure
                      tabIndex={-1}
                    >
                      <span>{agent.name}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="project-terminal-btn project-agent-more-btn"
                    data-agent-more-measure
                    tabIndex={-1}
                  >
                    <Terminal size={13} strokeWidth={1.8} />
                  </button>
                </div>
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
                  title="关闭并移到历史会话"
                  aria-label={`关闭并移到历史会话：${session.title}`}
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
        onDeleteAll={() => handleDeleteHistorySessions(closedSessions.map((session) => session.id))}
      />
    </>
  );
}
