import { useState, useRef, useEffect, useCallback } from "react";
import { flushSync } from "react-dom";
import { useChatStore, type ModelInfo } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { useAppStore } from "@/stores/app-store";
import "./ChatPanel.css";

function PersistedThinkingBlock({ thinkingContent }: { thinkingContent: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="chat-thinking">
      <button className="chat-thinking-toggle" onClick={() => setExpanded(!expanded)}>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span>Thought</span>
      </button>
      {expanded && <div className="chat-thinking-content">{thinkingContent}</div>}
    </div>
  );
}

export function ChatPanel({ sendKey = "Enter" }: { sendKey?: string }) {
  const {
    messages,
    isStreaming,
    activeAgentId,
    addMessage,
    setStreaming,
    currentModel,
    setCurrentModel,
    availableModels,
    setAvailableModels,
    favoriteModels,
    toggleFavorite,
    thinkingLevel,
    setThinkingLevel,
    pendingFiles,
    removePendingFile,
    clearPendingFiles,
    loadSessionMessages,
    updateLastAssistantThinking,
    sessionMessages,
  } = useChatStore();

  const { activeProjectId, projects, activeSessionId, setAgentStatus } = useProjectStore();
  const { triggerAddProject } = useAppStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const activeSession = activeProject?.sessions.find((s) => s.id === activeSessionId);

  const [input, setInput] = useState("");
  const [thinkingContent, setThinkingContent] = useState("");
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const [thinkingElapsed, setThinkingElapsed] = useState(0);
  const thinkingStartTimeRef = useRef<number>(0);
  const thinkingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [pendingImages, setPendingImages] = useState<{ id: string; src: string; name: string; file: File }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [userMsgHistoryOpen, setUserMsgHistoryOpen] = useState(false);
  const userMsgHistoryRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const streamBufferRef = useRef("");
  const thinkingBufferRef = useRef("");
  const fetchModelsRef = useRef<() => Promise<void>>();
  const isUserScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track user scrolling - stop auto-scroll when user scrolls up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      if (!atBottom) {
        isUserScrollingRef.current = true;
      } else {
        isUserScrollingRef.current = false;
      }
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 150) + "px";
    }
  }, [input]);

  // Close user message history on outside click
  useEffect(() => {
    if (!userMsgHistoryOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (userMsgHistoryRef.current && !userMsgHistoryRef.current.contains(e.target as Node)) {
        setUserMsgHistoryOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [userMsgHistoryOpen]);

  // Scroll to a specific message
  const scrollToMessage = useCallback((msgId: string) => {
    const el = scrollRef.current;
    if (!el) return;
    const msgEl = el.querySelector(`[data-msg-id="${msgId}"]`);
    if (msgEl) {
      msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
      // Brief background highlight matching theme
      const htmlEl = msgEl as HTMLElement;
      htmlEl.classList.add("chat-msg-highlight");
      setTimeout(() => {
        htmlEl.classList.remove("chat-msg-highlight");
      }, 1500);
    }
    setUserMsgHistoryOpen(false);
  }, []);

  // Core: parse Pi agent models.json content into ModelInfo array
  const parseModelJson = (content: string): ModelInfo[] => {
    try {
      const config = JSON.parse(content);
      const parsed: ModelInfo[] = [];

      // Pi agent format: { providers: { "name": { models: [...] } } }
      if (config.providers) {
        for (const [provider, pc] of Object.entries(config.providers as any)) {
          if (Array.isArray(pc.models)) {
            for (const m of pc.models) {
              parsed.push({
                id: m.id || m.name,
                name: m.name || m.id,
                provider,
                reasoning: m.reasoning ?? false,
              });
            }
          }
        }
      }

      return parsed;
    } catch {
      return [];
    }
  };

  // Fetch models: try agent RPC, then fallback to ~/.pi/agent/models.json
  const fetchModels = async (projectPath?: string) => {
    try {
      const models = await window.electronAPI.agentGetModels();
      if (models && models.length > 0) {
        setAvailableModels(models);
        const currentState = useChatStore.getState();
        const savedModel = currentState.currentModel;
        
        // Check if saved model is still available
        if (savedModel) {
          const isModelAvailable = models.some(
            (m) => m.id === savedModel.id && m.provider === savedModel.provider
          );
          if (isModelAvailable) {
            // Use saved model
            setCurrentModel(savedModel);
          } else {
            // Saved model not available, use first model
            setCurrentModel(models[0]);
          }
        } else {
          // No saved model, use first model
          setCurrentModel(models[0]);
        }
        return;
      }
    } catch {
      // ignore
    }

    // Fallback: read ~/.pi/agent/models.json
    try {
      const homeDir = await window.electronAPI.getHomeDir();
      const result = await window.electronAPI.readFile(`${homeDir}/.pi/agent/models.json`);
      if (result.success && result.content) {
        const parsed = parseModelJson(result.content);
        if (parsed.length > 0) {
          setAvailableModels(parsed);
          const currentState = useChatStore.getState();
          const savedModel = currentState.currentModel;
          
          // Check if saved model is still available
          if (savedModel) {
            const isModelAvailable = parsed.some(
              (m) => m.id === savedModel.id && m.provider === savedModel.provider
            );
            if (isModelAvailable) {
              // Use saved model
              setCurrentModel(savedModel);
            } else {
              // Saved model not available, use first model
              setCurrentModel(parsed[0]);
            }
          } else {
            // No saved model, use first model
            setCurrentModel(parsed[0]);
          }
        }
      }
    } catch {
      // ignore
    }
  };
  fetchModelsRef.current = fetchModels;

  // Initial fetch on mount
  useEffect(() => {
    fetchModels();
  }, []);

  // Re-fetch when project changes - use activeProject directly in deps
  useEffect(() => {
    if (!activeProject) return;
    const p = activeProject.path;
    // Multiple attempts to catch async agent_ready
    const timers = [
      setTimeout(() => fetchModels(p), 500),
      setTimeout(() => fetchModels(p), 2000),
      setTimeout(() => fetchModels(p), 5000),
    ];
    return () => timers.forEach(clearTimeout);
  }, [activeProject?.id]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (thinkingRef.current && !thinkingRef.current.contains(e.target as Node)) setThinkingOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Auto-scroll to bottom only when user is already near bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isUserScrollingRef.current) return;
    // Check if already near bottom (within 100px)
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (atBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages, thinkingContent, activeTool]);

  // Instant scroll to bottom on session switch (no animation)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    isUserScrollingRef.current = false;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [activeSessionId]);

  // Persist messages to sessionMessages whenever messages change (for restart survival)
  useEffect(() => {
    if (activeSessionId && messages.length > 0) {
      loadSessionMessages(activeSessionId, messages);
    }
  }, [messages, activeSessionId]);

  // Subscribe to agent events
  useEffect(() => {
    const unsubscribe = window.electronAPI.onAgentEvent((event: any) => {
      switch (event.type) {
        case "stream_start":
          flushSync(() => {
            streamBufferRef.current = "";
            // Don't clear thinking content here - thinking_delta events arrive AFTER stream_start
            // Thinking is cleared in handleSend when user sends a new message
            setThinkingExpanded(true);
            setThinkingElapsed(0);
            thinkingStartTimeRef.current = 0;
            if (thinkingTimerRef.current) { clearInterval(thinkingTimerRef.current); thinkingTimerRef.current = null; }
            setActiveTool(null);
            setStreaming(true);
            if (activeSessionId) setAgentStatus(activeSessionId, "running");
          });
          // Don't create assistant message here - wait for first stream_delta
          break;
        case "stream_delta":
          // Create assistant message on first text delta (not during thinking)
          if (!streamBufferRef.current) {
            flushSync(() => {
              // Auto-collapse thinking when output starts
              setThinkingExpanded(false);
              addMessage({
                id: crypto.randomUUID(),
                role: "assistant",
                content: "",
                timestamp: Date.now(),
                isStreaming: true,
              });
            });
          }
          streamBufferRef.current += event.delta;
          useChatStore.getState().updateLastAssistant(streamBufferRef.current);
          break;
        case "thinking_delta":
          thinkingBufferRef.current += event.delta;
          flushSync(() => {
            setThinkingContent(thinkingBufferRef.current);
          });
          // Start timer on first thinking delta
          if (!thinkingStartTimeRef.current) {
            thinkingStartTimeRef.current = Date.now();
            thinkingTimerRef.current = setInterval(() => {
              setThinkingElapsed(Math.floor((Date.now() - thinkingStartTimeRef.current) / 1000));
            }, 1000);
          }
          break;
        case "stream_end":
        case "agent_end":
        case "agent_disconnected":
          if (thinkingTimerRef.current) { clearInterval(thinkingTimerRef.current); thinkingTimerRef.current = null; }
          // Attach thinking content to the last assistant message for persistence
          if (thinkingBufferRef.current) {
            useChatStore.getState().updateLastAssistantThinking(thinkingBufferRef.current);
          }
          setActiveTool(null);
          setStreaming(false);
          if (activeSessionId) setAgentStatus(activeSessionId, "completed");
          break;
        case "tool_start":
          setActiveTool(event.toolName || "tool");
          break;
        case "tool_end":
          setActiveTool(null);
          break;
        case "agent_ready":
          // Re-fetch models when agent becomes ready
          fetchModelsRef.current?.(activeProject?.path);
          break;
      }
    });
    return () => {
      unsubscribe();
      if (thinkingTimerRef.current) clearInterval(thinkingTimerRef.current);
    };
  }, []);

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && pendingImages.length === 0 && pendingFiles.length === 0) || isStreaming) return;

    // Build display content (short refs) and send content (full details)
    let displayContent = text;
    let sendContent = text;

    // Handle pending files - read content and build detailed message
    if (pendingFiles.length > 0) {
      const fileParts: string[] = [];
      const fileRefs: string[] = [];

      for (const pf of pendingFiles) {
        fileRefs.push(`[${pf.fileName}:${pf.startLine}-${pf.endLine}]`);
        try {
          const result = await window.electronAPI.readFile(pf.filePath);
          if (result.success && result.content) {
            const lines = result.content.split("\n");
            const selectedLines = lines.slice(pf.startLine - 1, pf.endLine);
            fileParts.push(
              `<file path="${pf.filePath}" lines="${pf.startLine}-${pf.endLine}">\n${selectedLines.join("\n")}\n</file>`
            );
          } else {
            fileParts.push(`[无法读取文件: ${pf.fileName}]`);
          }
        } catch {
          fileParts.push(`[无法读取文件: ${pf.fileName}]`);
        }
      }

      const fileRefStr = fileRefs.join(" ");
      displayContent = text ? `${text}\n${fileRefStr}` : fileRefStr;
      sendContent = text ? `${text}\n\n${fileParts.join("\n\n")}` : fileParts.join("\n\n");
    }

    // Handle pending images
    let agentImages: Array<{ type: string; data: string; mimeType: string }> | undefined;
    let messageImages: Array<{ id: string; src: string; name: string }> | undefined;
    if (pendingImages.length > 0) {
      // Don't add text refs to displayContent - images are shown visually
      messageImages = pendingImages.map((img) => ({ id: img.id, src: img.src, name: img.name }));
      agentImages = pendingImages.map((img) => ({
        type: "image",
        data: img.src.split(",")[1], // Remove data:image/...;base64, prefix
        mimeType: img.file.type || "image/png",
      }));
    }

    // Force synchronous render so "working..." appears before IPC call
    isUserScrollingRef.current = false; // Reset so auto-scroll follows new message
    flushSync(() => {
      addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: displayContent,
        timestamp: Date.now(),
        images: messageImages,
      });
      setInput("");
      setPendingImages([]);
      clearPendingFiles();
      setStreaming(true);
      // Clear thinking from previous response
      thinkingBufferRef.current = "";
      setThinkingContent("");
    });

    const result = await window.electronAPI.agentSendMessage(sendContent, agentImages);
    if (!result.success) {
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `发送失败: ${result.error || "请先在项目中启动 Agent"}`,
        timestamp: Date.now(),
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const shouldSend =
      (sendKey === "Ctrl+Enter" && e.key === "Enter" && e.ctrlKey) ||
      (sendKey === "Enter" && e.key === "Enter" && !e.ctrlKey);

    if (shouldSend) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Enter") {
      // Allow newline by inserting it manually (works reliably in controlled textarea)
      e.preventDefault();
      const ta = textareaRef.current;
      if (ta) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const newValue = input.substring(0, start) + "\n" + input.substring(end);
        setInput(newValue);
        // Restore cursor position after React re-render
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 1;
        });
      }
    }
  };

  const handleAbort = async () => {
    await window.electronAPI.agentAbort();
    setStreaming(false);
    setThinkingContent("");
    setActiveTool(null);
  };

  // Image handling
  const addPendingImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setPendingImages((prev) => [...prev, {
        id: crypto.randomUUID(),
        src: reader.result as string,
        name: file.name,
        file,
      }]);
    };
    reader.readAsDataURL(file);
  };

  const removePendingImage = (id: string) => {
    setPendingImages((prev) => prev.filter((img) => img.id !== id));
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addPendingImage(file);
        return;
      }
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      addPendingImage(file);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleSelectModel = async (model: ModelInfo) => {
    setCurrentModel(model);
    setModelOpen(false);
    await window.electronAPI.agentSetModel(model.provider, model.id);
  };

  const handleSelectThinking = async (levelId: string) => {
    setThinkingLevel(levelId);
    setThinkingOpen(false);
    await window.electronAPI.agentSetThinkingLevel(levelId);
  };

  const thinkingLevels = [
    { id: "off", label: "关闭" },
    { id: "minimal", label: "最低" },
    { id: "low", label: "低" },
    { id: "medium", label: "中" },
    { id: "high", label: "高" },
    { id: "xhigh", label: "极高" },
  ];
  const currentThinking = thinkingLevels.find((l) => l.id === thinkingLevel) || thinkingLevels[3];
  const modelProviders = [...new Set(availableModels.map((m) => m.provider))];

  // No project open - show placeholder
  if (!activeProject) {
    return (
      <div className="chat-panel">
        <div className="chat-empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ color: "var(--text-secondary)", marginBottom: 16, opacity: 0.5 }}>
            <path d="M4 6C4 4.89543 4.89543 4 6 4H10L12 7H18C19.1046 7 20 7.89543 20 9V18C20 19.1046 19.1046 20 18 20H6C4.89543 20 4 19.1046 4 18V6Z" strokeLinejoin="round" />
            <path d="M4 10H20" />
          </svg>
          <div className="chat-empty-title">未打开项目</div>
          <div className="chat-empty-desc">请在左侧创建或选择一个项目以开始对话</div>
          <button
            className="chat-empty-btn"
            onClick={() => triggerAddProject()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
            创建项目
          </button>
        </div>
      </div>
    );
  }

  // Project open but no session - show session selector hint
  if (!activeSession) {
    return (
      <div className="chat-panel">
        <div className="chat-header">
          <div className="chat-agent-dot" />
          <span className="chat-agent-name">{activeProject.name}</span>
        </div>
        <div className="chat-empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ color: "var(--text-secondary)", marginBottom: 16, opacity: 0.5 }}>
            <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7 8L10 11L7 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 14H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <div className="chat-empty-title">选择或创建会话</div>
          <div className="chat-empty-desc">点击项目卡片上的 Agent 按钮新建会话，或点击下方已有会话</div>
          {activeProject.sessions.length > 0 && (
            <div className="chat-session-list">
              {activeProject.sessions.map((session) => {
                const msgs = sessionMessages[session.id];
                const firstUserMsg = msgs?.find((m) => m.role === "user");
                return (
                  <button
                    key={session.id}
                    className="chat-session-item"
                    onClick={async () => {
                      await window.electronAPI.agentSwitchSession(session.id);
                      useProjectStore.getState().setActiveSession(session.id);
                      useChatStore.getState().switchSession(session.id);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M7 8L10 11L7 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M12 14H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    <span>{firstUserMsg ? (firstUserMsg.content.length > 30 ? firstUserMsg.content.substring(0, 30) + "..." : firstUserMsg.content) : session.title}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-agent-dot" />
        <span className="chat-agent-name">{activeProject.name}</span>
        <span className="chat-agent-tag">{activeAgentId === "pi" ? "Pi Agent" : activeAgentId}</span>
        <div style={{ flex: 1 }} />
        <div ref={userMsgHistoryRef} className="relative">
          <button
            className="chat-header-history-btn"
            onClick={() => setUserMsgHistoryOpen(!userMsgHistoryOpen)}
            title="发言记录"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </button>
          {userMsgHistoryOpen && (
            <div className="chat-user-history-popup">
              <div className="chat-user-history-header">发言记录</div>
              {messages.filter((m) => m.role === "user").length === 0 ? (
                <div className="chat-user-history-empty">暂无发言</div>
              ) : (
                <div className="chat-user-history-list">
                  {messages.filter((m) => m.role === "user").map((msg) => (
                    <div
                      key={msg.id}
                      className="chat-user-history-item"
                      onClick={() => scrollToMessage(msg.id)}
                    >
                      <span className="chat-user-history-text">{msg.content}</span>
                      <span className="chat-user-history-time">
                        {(() => {
                          const d = new Date(msg.timestamp);
                          const now = new Date();
                          const isToday = d.toDateString() === now.toDateString();
                          const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
                          if (isToday) return time;
                          const mm = String(d.getMonth() + 1).padStart(2, "0");
                          const dd = String(d.getDate()).padStart(2, "0");
                          return `${mm}/${dd} ${time}`;
                        })()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="chat-messages">
        {messages.length === 0 && !thinkingContent && (
          <div className="chat-empty">发送消息开始对话</div>
        )}
        {/* Working indicator: shown during gap between user message and thinking start */}
        {isStreaming && !thinkingContent && messages.length > 0 && messages[messages.length - 1].role === "user" && (
          <div className="chat-working">
            <div className="chat-working-spinner" />
            <span>working...</span>
          </div>
        )}
        {isStreaming && thinkingContent && messages.length === 0 && (
          <div className="chat-thinking">
            <button
              className="chat-thinking-toggle"
              onClick={() => setThinkingExpanded(!thinkingExpanded)}
            >
              <svg
                width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                style={{ transform: thinkingExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
              <span>Thought {thinkingElapsed}s</span>
            </button>
            {thinkingExpanded && (
              <div className="chat-thinking-content">{thinkingContent}</div>
            )}
          </div>
        )}
        {messages.map((msg, idx) => {
          const isLastMsg = idx === messages.length - 1;
          const showLiveThinking = isLastMsg && (msg.role === "assistant" || msg.role === "user") && thinkingContent;
          const showPersistedThinking = msg.role === "assistant" && msg.thinkingContent && !showLiveThinking;
          return (
            <div key={msg.id} data-msg-id={msg.id} className="chat-msg-wrapper">
              {showPersistedThinking && (
                <PersistedThinkingBlock thinkingContent={msg.thinkingContent} />
              )}
              {/* Live thinking: ABOVE assistant bubble, BELOW user bubble */}
              {showLiveThinking && msg.role === "assistant" && (
                <div className="chat-thinking">
                  <button
                    className="chat-thinking-toggle"
                    onClick={() => setThinkingExpanded(!thinkingExpanded)}
                  >
                    <svg
                      width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                      style={{ transform: thinkingExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                    <span>Thought {thinkingElapsed}s</span>
                  </button>
                  {thinkingExpanded && (
                    <div className="chat-thinking-content">{thinkingContent}</div>
                  )}
                </div>
              )}
              <div className={`chat-msg ${msg.role}`}>
                {msg.images && msg.images.length > 0 && (
                  <div className="chat-images">
                    {msg.images.map((img) => (
                      <img
                        key={img.id}
                        src={img.src}
                        alt={img.name}
                        className="chat-image"
                        onClick={() => setZoomImage(img.src)}
                      />
                    ))}
                  </div>
                )}
                <div className="chat-bubble-row">
                  {msg.content && (
                    <div className={`chat-bubble ${msg.role}`}>{msg.content}</div>
                  )}
                  {msg.role === "user" && (
                    <button
                      className="chat-copy-btn"
                      onClick={() => navigator.clipboard.writeText(msg.content)}
                      title="复制"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              {/* Live thinking: BELOW user bubble */}
              {showLiveThinking && msg.role === "user" && (
                <div className="chat-thinking">
                  <button
                    className="chat-thinking-toggle"
                    onClick={() => setThinkingExpanded(!thinkingExpanded)}
                  >
                    <svg
                      width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                      style={{ transform: thinkingExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                    <span>Thought {thinkingElapsed}s</span>
                  </button>
                  {thinkingExpanded && (
                    <div className="chat-thinking-content">{thinkingContent}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {isStreaming && activeTool && (
          <div className="chat-tool">
            <div className="chat-tool-spinner" />
            <span className="chat-tool-name">正在执行: {activeTool}</span>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="chat-input-area">
        {/* Combined preview bar for files and images */}
        {(pendingFiles.length > 0 || pendingImages.length > 0) && (
          <div className="chat-preview-bar">
            {pendingFiles.map((pf) => (
              <div key={pf.id} className="chat-file-card">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="chat-file-icon">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="chat-file-name">{pf.fileName}:{pf.startLine}-{pf.endLine}</span>
                <button className="chat-file-remove" onClick={() => removePendingFile(pf.id)}>×</button>
              </div>
            ))}
            {pendingImages.map((img) => (
              <div key={img.id} className="chat-image-card-inline">
                {img.file.type.startsWith("image/") ? (
                  <img src={img.src} alt={img.name} className="chat-image-thumb-inline" onClick={() => setZoomImage(img.src)} />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2" className="chat-file-icon">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                )}
                <span className="chat-file-name">{img.name}</span>
                <button className="chat-file-remove" onClick={() => removePendingImage(img.id)}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* Input container */}
        <div className="chat-input-container" onDrop={handleDrop} onDragOver={handleDragOver}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              Array.from(e.target.files || []).forEach(addPendingImage);
              e.target.value = "";
            }}
          />
          <div className="chat-input-actions-left">
            <button className="chat-input-btn" title="上传文件" onClick={() => fileInputRef.current?.click()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={sendKey === "Ctrl+Enter" ? "输入消息... (Ctrl+Enter 发送, Enter 换行, 粘贴图片)" : "输入消息... (Enter 发送, Ctrl+Enter 换行, 粘贴图片)"}
            rows={1}
            className="chat-textarea"
          />
          <button
            onClick={isStreaming ? handleAbort : handleSend}
            disabled={!isStreaming && !input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
            className={`chat-send-btn ${isStreaming ? "abort" : ""}`}
            title={isStreaming ? "停止" : "发送"}
          >
            {isStreaming ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13" />
                <path d="M22 2L15 22L11 13L2 9L22 2Z" />
              </svg>
            )}
          </button>
        </div>

        {/* Toolbar below input */}
        <div className="chat-input-toolbar">
          {/* Model selector */}
          <div ref={modelRef} className="relative">
            <button
              onClick={() => { setModelOpen(!modelOpen); setThinkingOpen(false); if (modelOpen) setExpandedProvider(null); }}
              className="chat-toolbar-select"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <circle cx="15.5" cy="8.5" r="1.5" />
                <path d="M8 14c0 0 1.5 2 4 2s4-2 4-2" />
              </svg>
              <span>{currentModel?.name || "选择模型"}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {modelOpen && (
              <div className="chat-dropdown">
                {modelProviders.length === 0 && (
                  <div className="chat-dropdown-empty">暂无可用模型</div>
                )}
                {modelProviders.map((provider) => {
                  const providerModels = availableModels.filter((m) => m.provider === provider);
                  const isExpanded = expandedProvider === provider;
                  const hasActiveModel = providerModels.some(
                    (m) => m.id === currentModel?.id && m.provider === currentModel?.provider
                  );
                  return (
                    <div key={provider}>
                      <div
                        className={`chat-dropdown-provider ${isExpanded ? "expanded" : ""} ${hasActiveModel ? "has-active" : ""}`}
                        onClick={() => setExpandedProvider(isExpanded ? null : provider)}
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
                        >
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                        <span>{provider}</span>
                        <span className="chat-dropdown-provider-count">{providerModels.length}</span>
                      </div>
                      {isExpanded && providerModels.map((model) => {
                        const isFav = favoriteModels.some((f) => f.id === model.id && f.provider === model.provider);
                        const isActive = currentModel?.id === model.id && currentModel?.provider === model.provider;
                        return (
                          <div
                            key={model.id}
                            className={`chat-dropdown-item ${isActive ? "active" : ""}`}
                            onClick={() => handleSelectModel(model)}
                          >
                            <span className="truncate">{model.name}</span>
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleFavorite(model); }}
                              className={`chat-dropdown-star ${isFav ? "fav" : ""}`}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill={isFav ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
                                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                              </svg>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Thinking level selector */}
          <div ref={thinkingRef} className="relative">
            <button
              onClick={() => { setThinkingOpen(!thinkingOpen); setModelOpen(false); }}
              className="chat-toolbar-select"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
                <path d="M10 21h4" />
              </svg>
              <span>思考: {currentThinking.label}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {thinkingOpen && (
              <div className="chat-thinking-dropdown">
                {thinkingLevels.map((level) => (
                  <button
                    key={level.id}
                    onClick={() => handleSelectThinking(level.id)}
                    className={`chat-thinking-option ${thinkingLevel === level.id ? "active" : ""}`}
                  >
                    {level.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Image zoom modal */}
      {zoomImage && (
        <div className="chat-image-zoom-overlay" onClick={() => setZoomImage(null)}>
          <img src={zoomImage} className="chat-image-zoom" onClick={(e) => e.stopPropagation()} />
          <button className="chat-image-zoom-close" onClick={() => setZoomImage(null)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
