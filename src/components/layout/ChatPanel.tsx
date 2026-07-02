import {
  memo,
  useState,
  useRef,
  useEffect,
  useCallback,
  type RefObject,
  type UIEvent as ReactUIEvent,
} from "react";
import { flushSync } from "react-dom";
import { ListCollapse } from "lucide-react";
import { useChatStore, type ChatMessage, type ModelInfo } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { useAppStore } from "@/stores/app-store";
import { getAgentName, getAgentPlanModeTooltip } from "@/lib/agents";
import { saveSessionModel, saveSessionThinking } from "@/hooks/useDataPersistence";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { FilePreview } from "@/components/shared/FilePreview";
import { ChatComposer } from "./ChatComposer";
import { ChatToolbar } from "./ChatToolbar";
import { DiffBlock } from "./DiffBlock";
import { ProcessBlock } from "./ProcessBlock";
import { QuestionnairePanel } from "./QuestionnairePanel";
import { useChatScroll } from "./useChatScroll";
import { useAgentEvents } from "./useAgentEvents";
import { usePendingImages } from "./usePendingImages";
import { usePendingUIResponse, usePendingUIResponseActions } from "./usePendingUIResponse";
import { useQuestionnaireResize } from "./useQuestionnaireResize";
import { useSessionModels } from "./useSessionModels";
import {
  asRecord,
  createProcessEntryId,
  getBooleanField,
  resetSessionRuntimeAfterTurn,
  type SessionRuntime,
} from "./agentEventUtils";
import "./ChatPanel.css";

const AGENT_SETTINGS_UPDATED_EVENT = "agent-settings-updated";

type ChatMessagesViewProps = {
  activeSessionId: string | null;
  activeSessionInitialized: boolean;
  currentSessionRunning: boolean;
  messages: ChatMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  showScrollBottom: boolean;
  onMessagesScroll: (event: ReactUIEvent<HTMLDivElement>) => void;
  onScrollToBottom: () => void;
  onEditMessage: (content: string) => void;
  onOpenImage: (src: string) => void;
  onOpenFile: (path: string) => void;
  onToggleAssistantProcess: (messageId: string, anchor?: HTMLElement | null) => void;
  onToggleAssistantProcessEntry: (messageId: string, entryId: string, anchor?: HTMLElement | null) => void;
  onPreserveScroll: (action: () => void, anchor?: HTMLElement | null) => void;
};

const ChatMessagesView = memo(function ChatMessagesView({
  activeSessionId,
  activeSessionInitialized,
  currentSessionRunning,
  messages,
  scrollRef,
  showScrollBottom,
  onMessagesScroll,
  onScrollToBottom,
  onEditMessage,
  onOpenImage,
  onOpenFile,
  onToggleAssistantProcess,
  onToggleAssistantProcessEntry,
  onPreserveScroll,
}: ChatMessagesViewProps) {
  return (
    <div className="chat-messages-area">
      <div ref={scrollRef} className="chat-messages" onScroll={onMessagesScroll}>
        {activeSessionId && !activeSessionInitialized ? (
          <div className="chat-loading-agent">
            <div className="chat-working-spinner" />
            <span>正在初始化 Agent 会话...</span>
          </div>
        ) : (
          <>
            {messages.length === 0 && (
              <div className="chat-empty">发送消息开始对话</div>
            )}
            {messages.map((msg) => {
              if (msg.role === "system" && msg.systemType === "context_compaction") {
                return (
                  <div key={msg.id} data-msg-id={msg.id} className="chat-context-divider">
                    <span className="chat-context-divider-line" />
                    <span className="chat-context-divider-label">
                      <ListCollapse size={15} strokeWidth={1.8} />
                      <span>{msg.content || "上下文已自动压缩"}</span>
                    </span>
                    <span className="chat-context-divider-line" />
                  </div>
                );
              }

              const processRunning = msg.role === "assistant" && !!msg.process && !msg.process.endedAt;
              const hasImages = !!msg.images?.length;
              const hasDiffs = !!msg.diffs?.length && !processRunning;
              const hasContent = msg.content.trim().length > 0;
              const hasVisibleBubble =
                msg.role === "assistant" ? !processRunning && (hasContent || hasImages || hasDiffs) : hasContent || hasImages || hasDiffs;

              return (
                <div key={msg.id} data-msg-id={msg.id} className="chat-msg-wrapper">
                  {msg.role === "assistant" && msg.process && (
                    <ProcessBlock
                      messageId={msg.id}
                      process={msg.process}
                      onToggle={onToggleAssistantProcess}
                      onToggleEntry={onToggleAssistantProcessEntry}
                      onOpenFile={onOpenFile}
                      onPreserveScroll={onPreserveScroll}
                    />
                  )}
                  {hasVisibleBubble && (
                    <div className={`chat-msg ${msg.role}`}>
                      {hasImages && msg.images && (
                        <div className="chat-images">
                          {msg.images.map((img) => (
                            <img
                              key={img.id}
                              src={img.src}
                              alt={img.name}
                              className="chat-image"
                              onClick={() => onOpenImage(img.src)}
                            />
                          ))}
                        </div>
                      )}
                      {hasContent && (
                        <div className="chat-bubble-row">
                          <div className={`chat-bubble ${msg.role}`}>
                            {msg.role === "assistant" ? (
                              <MarkdownRenderer content={msg.content} />
                            ) : (
                              msg.content
                            )}
                          </div>
                          {msg.role === "user" && (
                            <div className="chat-msg-actions">
                              <button
                                className="chat-copy-btn"
                                onClick={() => onEditMessage(msg.content)}
                                title="编辑"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                </svg>
                              </button>
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
                            </div>
                          )}
                        </div>
                      )}
                      {hasDiffs && msg.diffs && (
                        <DiffBlock diffs={msg.diffs} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {currentSessionRunning && messages.length > 0 && messages[messages.length - 1].role === "user" && (
              <div className="chat-working">
                <div className="chat-working-spinner" />
                <span>正在处理您的请求...</span>
              </div>
            )}
          </>
        )}
      </div>

      {showScrollBottom && (
        <button className="chat-scroll-bottom" onClick={onScrollToBottom} title="返回底部">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M19 12l-7 7-7-7" />
          </svg>
        </button>
      )}
    </div>
  );
});

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
    sessionMessages,
    toggleAssistantProcess,
    toggleAssistantProcessEntry,
  } = useChatStore();

  const { activeProjectId, projects, activeSessionId, agentStatuses, isSessionInitialized } = useProjectStore();
  const { triggerAddProject } = useAppStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const activeSession = activeProject?.sessions.find((s) => s.id === activeSessionId);
  const activeSessionInitialized = activeSessionId ? isSessionInitialized(activeSessionId) : false;

  const inputValueRef = useRef("");
  const inputHasTextRef = useRef(false);
  const [inputHasText, setInputHasText] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [userMsgHistoryOpen, setUserMsgHistoryOpen] = useState(false);
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const userMsgHistoryRef = useRef<HTMLDivElement>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const sessionRuntimeRef = useRef<Record<string, SessionRuntime>>({});
  const {
    pendingImages,
    attachmentError,
    addPendingImage,
    removePendingImage,
    clearPendingImages,
    clearAttachmentError,
    handlePaste,
    handleDrop,
    handleDragOver,
  } = usePendingImages();
  const {
    pendingUIResponse,
    pendingUIResponseRef,
    setPendingUIResponseState,
    isAwaitingUIResponse,
    activeQuestionnaire,
  } = usePendingUIResponse(activeSessionId);
  const currentSessionRunning = activeSessionId ? agentStatuses[activeSessionId] === "running" : isStreaming;
  const questionnaireResetKey = activeQuestionnaire
    ? `${activeQuestionnaire.sessionId}:${activeQuestionnaire.requestId || ""}:${activeQuestionnaire.entryId || ""}`
    : null;
  const {
    questionnairePaneHeight,
    handleQuestionnaireResizeStart,
  } = useQuestionnaireResize({
    panelRef: chatPanelRef,
    enabled: !!activeQuestionnaire,
    resetKey: questionnaireResetKey,
  });
  const {
    scrollRef,
    showScrollBottom,
    handleMessagesScroll,
    scrollToBottom,
    scrollToBottomNow,
    scrollToMessage: scrollToMessageElement,
    preserveScrollDuringLayoutChange,
    enableAutoFollow,
  } = useChatScroll({
    messages,
    activeSessionId,
    activeSessionInitialized,
    questionnairePaneHeight,
  });

  const resizeTextarea = useCallback((textarea = textareaRef.current) => {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
  }, []);

  const syncInputValue = useCallback((value: string) => {
    inputValueRef.current = value;
    const hasText = value.trim().length > 0;
    if (inputHasTextRef.current !== hasText) {
      inputHasTextRef.current = hasText;
      setInputHasText(hasText);
    }
  }, []);

  const setComposerInput = useCallback((value: string) => {
    syncInputValue(value);
    const textarea = textareaRef.current;
    if (textarea && textarea.value !== value) {
      textarea.value = value;
    }
    resizeTextarea(textarea);
  }, [resizeTextarea, syncInputValue]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.loadData("settings").then((data) => {
      const settings = asRecord(data);
      const general = asRecord(settings.general);
      if (!cancelled) setPlanModeEnabled(!!getBooleanField(general, "planModeEnabled"));
    });

    const handleAgentSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ planModeEnabled?: boolean }>).detail;
      if (typeof detail?.planModeEnabled === "boolean") {
        setPlanModeEnabled(detail.planModeEnabled);
      }
    };
    window.addEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
    };
  }, []);

  const savePlanModeEnabled = async (nextPlanModeEnabled: boolean) => {
    setPlanModeEnabled(nextPlanModeEnabled);
    setModelOpen(false);
    setThinkingOpen(false);
    setExpandedProvider(null);
    const data = await window.electronAPI.loadData("settings");
    const currentSettings = asRecord(data);
    const currentGeneral = asRecord(currentSettings.general);
    const nextSettings = {
      ...currentSettings,
      general: {
        ...currentGeneral,
        planModeEnabled: nextPlanModeEnabled,
      },
    };
    await window.electronAPI.saveData("settings", nextSettings);
    window.dispatchEvent(new CustomEvent(AGENT_SETTINGS_UPDATED_EVENT, {
      detail: { planModeEnabled: nextPlanModeEnabled },
    }));
  };

  // Auto-resize textarea after layout changes; typing resizes directly in onChange.
  useEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, activeQuestionnaire]);

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

  const scrollToMessage = useCallback((msgId: string) => {
    scrollToMessageElement(msgId);
    setUserMsgHistoryOpen(false);
  }, [scrollToMessageElement]);

  const handleToggleAssistantProcess = useCallback((messageId: string, anchor?: HTMLElement | null) => {
    preserveScrollDuringLayoutChange(() => toggleAssistantProcess(messageId), anchor);
  }, [preserveScrollDuringLayoutChange, toggleAssistantProcess]);

  const handleToggleAssistantProcessEntry = useCallback((messageId: string, entryId: string, anchor?: HTMLElement | null) => {
    preserveScrollDuringLayoutChange(() => toggleAssistantProcessEntry(messageId, entryId), anchor);
  }, [preserveScrollDuringLayoutChange, toggleAssistantProcessEntry]);

  const { switchToSession } = useSessionModels({
    activeSessionId,
    activeSessionAgentId: activeSession?.agentId,
    activeSessionInitialized,
    setAvailableModels,
    setCurrentModel,
    setThinkingLevel,
  });

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (thinkingRef.current && !thinkingRef.current.contains(e.target as Node)) setThinkingOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Persist messages to sessionMessages whenever messages change (for restart survival)
  useEffect(() => {
    if (
      activeSessionId &&
      messages.length > 0 &&
      sessionMessages[activeSessionId] !== messages
    ) {
      loadSessionMessages(activeSessionId, messages);
    }
  }, [messages, activeSessionId, sessionMessages, loadSessionMessages]);

  useAgentEvents({
    activeAgentId,
    sessionRuntimeRef,
    pendingUIResponseRef,
    setPendingUIResponseState,
    setStreaming,
  });

  const {
    handleSendUIResponse,
    handleSubmitQuestionnaire,
    handleCancelQuestionnaire,
  } = usePendingUIResponseActions({
    activeQuestionnaire,
    addMessage,
    enableAutoFollow,
    inputValueRef,
    pendingUIResponse,
    sessionRuntimeRef,
    setComposerInput,
    setPendingUIResponseState,
  });

  const handleSend = async () => {
    if (activeQuestionnaire) return;

    if (isAwaitingUIResponse) {
      await handleSendUIResponse();
      return;
    }

    const text = inputValueRef.current.trim();
    const targetSessionId = useProjectStore.getState().activeSessionId;
    if (!targetSessionId || (!text && pendingImages.length === 0 && pendingFiles.length === 0)) return;

    const existingRuntime = sessionRuntimeRef.current[targetSessionId];
    if (existingRuntime?.processActive || agentStatuses[targetSessionId] === "running") {
      setStreaming(true);
      useProjectStore.getState().setAgentStatus(targetSessionId, "running");
      return;
    }

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
    enableAutoFollow(); // New outgoing messages should keep the latest turn visible.
    flushSync(() => {
      addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: displayContent,
        timestamp: Date.now(),
        images: messageImages,
      }, targetSessionId);
      setComposerInput("");
      clearPendingImages();
      clearPendingFiles();
      setStreaming(true);
      useProjectStore.getState().setAgentStatus(targetSessionId, "running");
      const runtime = sessionRuntimeRef.current[targetSessionId];
      if (runtime) {
        if (runtime.streamWatchdog) {
          clearTimeout(runtime.streamWatchdog);
          runtime.streamWatchdog = null;
        }
        runtime.streamBuffer = "";
        runtime.thinkingBuffer = "";
        runtime.thinkingEntryId = null;
        runtime.streamIdleNoticeEntryId = null;
        runtime.autoAbortReason = null;
      }
    });

    // Scroll to bottom immediately after sending (user wants to see their message)
    scrollToBottomNow();

    const result = await window.electronAPI.agentSendMessage(sendContent, agentImages, targetSessionId, { planModeEnabled });
    if (!result.success) {
      const runtime = sessionRuntimeRef.current[targetSessionId];
      if (/Codex is already running/i.test(result.error || "")) {
        const latestStatus = useProjectStore.getState().agentStatuses[targetSessionId];
        if (runtime?.processActive || latestStatus === "running") {
          setStreaming(true);
          useProjectStore.getState().setAgentStatus(targetSessionId, "running");
          return;
        }
      }
      if (runtime?.streamWatchdog) {
        clearTimeout(runtime.streamWatchdog);
        runtime.streamWatchdog = null;
      }
      useChatStore.getState().finishLastAssistantProcess(Date.now(), "completed", targetSessionId);
      if (runtime) {
        resetSessionRuntimeAfterTurn(runtime);
      }
      setStreaming(false);
      useProjectStore.getState().setAgentStatus(targetSessionId, "idle");
      addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content: `发送失败: ${result.error || "请先在项目中启动 Agent"}`,
        timestamp: Date.now(),
      }, targetSessionId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    const shouldSend =
      (sendKey === "Ctrl+Enter" && e.key === "Enter" && e.ctrlKey) ||
      (sendKey === "Enter" && e.key === "Enter" && !e.ctrlKey);

    if (shouldSend) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const ta = textareaRef.current;
      if (ta) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const currentValue = inputValueRef.current;
        const newValue = currentValue.substring(0, start) + "\n" + currentValue.substring(end);
        setComposerInput(newValue);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 1;
        });
      }
    }
  };

  const handleAbort = () => {
    const currentSessionId = useProjectStore.getState().activeSessionId;
    if (!currentSessionId) return;
    const runtime = sessionRuntimeRef.current[currentSessionId];
    if (runtime?.streamWatchdog) {
      clearTimeout(runtime.streamWatchdog);
      runtime.streamWatchdog = null;
    }
    useChatStore.getState().appendLastAssistantProcessEntry({
      id: createProcessEntryId(),
      timestamp: Date.now(),
      type: "status",
      title: "用户已手动中断",
      state: "interrupted",
      expanded: false,
    }, currentSessionId);
    useChatStore.getState().finishLastAssistantProcess(Date.now(), "interrupted", currentSessionId);
    if (runtime) {
      resetSessionRuntimeAfterTurn(runtime);
      runtime.autoAbortReason = null;
    }
    setPendingUIResponseState((current) => current?.sessionId === currentSessionId ? null : current);
    setStreaming(false);
    useProjectStore.getState().setAgentStatus(currentSessionId, "idle");

    void window.electronAPI.agentAbort(currentSessionId).catch((err) => {
      console.error("[agent] abort failed:", err);
    });
  };

  const handleSelectModel = async (model: ModelInfo) => {
    setCurrentModel(model);
    setModelOpen(false);
    // Save model selection for this session
    const sessionId = useProjectStore.getState().activeSessionId;
    if (sessionId) saveSessionModel(sessionId, model);
    await window.electronAPI.agentSetModel(model.provider, model.id);
  };

  const handleSelectThinking = async (levelId: string) => {
    setThinkingLevel(levelId);
    setThinkingOpen(false);
    // Save thinking level for this session
    const sessionId = useProjectStore.getState().activeSessionId;
    if (sessionId) saveSessionThinking(sessionId, levelId);
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
  const flattenModelList = activeSession?.agentId === "codex" || activeAgentId === "codex";

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
          {(() => {
            const openSessions = activeProject.sessions.filter((s) => !s.closed);
            if (openSessions.length === 0) return null;
            return (
            <div className="chat-session-list">
              {openSessions.map((session) => {
                const msgs = sessionMessages[session.id];
                const firstUserMsg = msgs?.find((m) => m.role === "user");
                return (
                  <button
                    key={session.id}
                    className="chat-session-item"
                    onClick={() => switchToSession(activeProject, session)}
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
            );
          })()}
        </div>
      </div>
    );
  }

  return (
    <div ref={chatPanelRef} className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-agent-dot" />
        <span className="chat-agent-name">{activeProject.name}</span>
        <span className="chat-agent-tag">{getAgentName(activeAgentId)}</span>
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
                  {messages.filter((m) => m.role === "user").slice().reverse().map((msg) => (
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
      <ChatMessagesView
        activeSessionId={activeSessionId}
        activeSessionInitialized={activeSessionInitialized}
        currentSessionRunning={currentSessionRunning}
        messages={messages}
        scrollRef={scrollRef}
        showScrollBottom={showScrollBottom}
        onMessagesScroll={handleMessagesScroll}
        onScrollToBottom={scrollToBottom}
        onEditMessage={setComposerInput}
        onOpenImage={setZoomImage}
        onOpenFile={setPreviewFile}
        onToggleAssistantProcess={handleToggleAssistantProcess}
        onToggleAssistantProcessEntry={handleToggleAssistantProcessEntry}
        onPreserveScroll={preserveScrollDuringLayoutChange}
      />

      {activeQuestionnaire && (
        <div
          className="chat-questionnaire-resizer"
          role="separator"
          aria-label="调整问卷面板高度"
          aria-orientation="horizontal"
          title="拖动调整问卷高度"
          onPointerDown={handleQuestionnaireResizeStart}
        />
      )}

      {/* Input area */}
      <div
        className={`chat-input-area${activeQuestionnaire ? " questionnaire-active" : ""}${activeQuestionnaire && questionnairePaneHeight !== null ? " questionnaire-resized" : ""}`}
        style={activeQuestionnaire && questionnairePaneHeight !== null ? { height: questionnairePaneHeight } : undefined}
      >
        {activeQuestionnaire && (
          <QuestionnairePanel
            questions={activeQuestionnaire.questions || []}
            onSubmit={handleSubmitQuestionnaire}
            onCancel={handleCancelQuestionnaire}
          />
        )}

        <ChatComposer
          activeQuestionnaire={!!activeQuestionnaire}
          currentSessionRunning={currentSessionRunning}
          attachmentError={attachmentError}
          isAwaitingUIResponse={isAwaitingUIResponse}
          inputHasText={inputHasText}
          pendingFiles={pendingFiles}
          pendingImages={pendingImages}
          sendKey={sendKey}
          fileInputRef={fileInputRef}
          textareaRef={textareaRef}
          onAddPendingImage={addPendingImage}
          onClearAttachmentError={clearAttachmentError}
          onRemovePendingFile={removePendingFile}
          onRemovePendingImage={removePendingImage}
          onOpenImage={setZoomImage}
          onSyncInputValue={syncInputValue}
          onResizeTextarea={resizeTextarea}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onSend={handleSend}
          onAbort={handleAbort}
        />

        <ChatToolbar
          activeAgentId={activeAgentId}
          activeSessionAgentId={activeSession?.agentId}
          availableModels={availableModels}
          currentModel={currentModel}
          currentThinking={currentThinking}
          expandedProvider={expandedProvider}
          favoriteModels={favoriteModels}
          flattenModelList={flattenModelList}
          modelOpen={modelOpen}
          modelProviders={modelProviders}
          planModeEnabled={planModeEnabled}
          thinkingLevel={thinkingLevel}
          thinkingLevels={thinkingLevels}
          thinkingOpen={thinkingOpen}
          modelRef={modelRef}
          thinkingRef={thinkingRef}
          getPlanModeTooltip={getAgentPlanModeTooltip}
          onExpandedProviderChange={setExpandedProvider}
          onModelOpenChange={setModelOpen}
          onThinkingOpenChange={setThinkingOpen}
          onPlanModeChange={savePlanModeEnabled}
          onSelectModel={handleSelectModel}
          onSelectThinking={handleSelectThinking}
          onToggleFavorite={toggleFavorite}
        />
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
      <FilePreview filePath={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
}
