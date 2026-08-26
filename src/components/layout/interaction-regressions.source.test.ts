import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import chatComposerSource from "./ChatComposer.tsx?raw";
import chatPanelSource from "./ChatPanel.tsx?raw";
import fileSearchSource from "../shared/FileSearch.tsx?raw";
import fileMentionPickerSource from "./ComposerFileMentionPicker.tsx?raw";
import questionnaireSource from "./QuestionnairePanel.tsx?raw";
import confirmationSource from "./ConfirmationPanel.tsx?raw";
import permissionChoiceSource from "./PermissionChoicePanel.tsx?raw";
import pendingUIResponseSource from "./usePendingUIResponse.ts?raw";
import agentEventsSource from "./useAgentEvents.ts?raw";
import chatScrollSource from "./useChatScroll.ts?raw";
import chatVirtualizerSource from "./useChatVirtualizer.ts?raw";
import agentEventControllerSource from "./agentEventController.ts?raw";
import processBlockSource from "./ProcessBlock.tsx?raw";
import chatStoreSource from "../../stores/chat-store.ts?raw";

const chatPanelStyles = readFileSync(
  resolve(process.cwd(), "src/components/layout/ChatPanel.css"),
  "utf8",
);
const fileSearchStyles = readFileSync(
  resolve(process.cwd(), "src/components/shared/FileSearch.css"),
  "utf8",
);

describe("chat interaction regression constraints", () => {
  it("does not leave persisted-message debug payloads in the production render path", () => {
    expect(chatPanelSource).not.toContain("title={JSON.stringify({");
    expect(chatPanelSource).not.toContain("doc: sourceComposerDocument?.nodes.map");
  });

  it("virtualizes expensive message subtrees with measured rows", () => {
    expect(chatPanelSource).toContain("useChatVirtualizer");
    expect(chatPanelSource).toContain("getVirtualItems()");
    expect(chatPanelSource).toContain("chat-virtual-row");
    expect(chatPanelSource).toContain("estimateChatMessageHeight");
    expect(chatPanelSource).toContain("onContentChange();");
    expect(chatVirtualizerSource).toContain("useVirtualizer");
    expect(chatVirtualizerSource).toContain("anchorTo = \"end\"");
    expect(chatVirtualizerSource).toContain("rangeExtractor");
    expect(chatVirtualizerSource).toContain("scrollToEnd");
  });

  it("keeps switched sessions at the bottom while virtual row measurements settle", () => {
    const settlingSource = chatScrollSource.slice(
      chatScrollSource.indexOf("const bottomLockSessionRef"),
      chatScrollSource.indexOf("const scrollToBottom ="),
    );
    expect(settlingSource).toContain("bottomLockSessionRef.current = activeSessionId");
    expect(settlingSource).toContain("if (isBottomLocked())");
    expect(settlingSource).toContain("const observer = new ResizeObserver(scheduleKeepAtBottom)");
    expect(settlingSource).toContain("observer.observe(content)");
    expect(settlingSource).toContain('el.addEventListener("wheel", releaseBottomLock');
    expect(settlingSource).toContain('el.addEventListener("pointerdown", releaseBottomLock');
    expect(settlingSource).not.toContain("setTimeout");
  });

  it("keeps history jumps stable while virtual rows are materialized", () => {
    const scrollToMessageSource = chatScrollSource.slice(
      chatScrollSource.indexOf("const scrollToMessage"),
      chatScrollSource.indexOf("const preserveScrollDuringLayoutChange"),
    );
    expect(scrollToMessageSource).toContain("autoFollowBottomRef.current = false");
    expect(scrollToMessageSource).toContain("suppressAutoScrollUntilRef.current");
    expect(scrollToMessageSource).toContain('querySelector<HTMLElement>(".chat-bubble.user")');
    expect(scrollToMessageSource).toContain("scrollTargetToTop");
  });

  it("virtualizes the user message history popup with anchored rows", () => {
    expect(chatPanelSource).toContain("chat-user-history-list");
    expect(chatPanelSource).toContain("historyVirtualizer.getTotalSize()");
    expect(chatPanelSource).toContain("historyVirtualizer.getVirtualItems()");
    expect(chatPanelSource).toContain('className="chat-virtual-row chat-user-history-item"');
    expect(chatPanelSource).toContain("USER_HISTORY_ITEM_ESTIMATED_HEIGHT");
    expect(chatPanelSource).toContain("anchorTo: \"start\"");
  });

  it("keeps virtualized overlays pinned while their popover is open", () => {
    expect(chatPanelSource).toContain("pinnedMessageIndex");
    expect(chatPanelSource).toContain("onDiffOpenChange");
    expect(chatVirtualizerSource).toContain("pinnedIndexes");
  });

  it("does not let portaled sticky process controls shrink the top scroll range", () => {
    const portaledStickyStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-process-sticky-layer > .chat-process-sticky"),
      chatPanelStyles.indexOf(".chat-process-sticky-inner"),
    );
    expect(portaledStickyStyles).toContain("margin-bottom: 0");
  });

  it("shows one global sticky button that jumps to the previous user bubble", () => {
    // 返回按钮从“每个处理过程”改为全局一个，常驻吸顶；目标按主消息行的真实几何位置计算。
    expect(chatPanelSource).toContain("chat-sticky-previous-message");
    expect(chatPanelSource).toContain("refreshPreviousUserTarget");
    expect(chatPanelSource).toContain("chat-message-virtual-content");
    expect(chatPanelSource).toContain("visibleSpeechIndex");
    expect(chatPanelSource).toContain("resolvePreviousUserTargetIndex");
    expect(chatPanelSource).toContain("返回我的上一条发言");
    // 处理过程吸顶条不再携带返回按钮/跳转目标，避免每个处理过程各渲染一个按钮。
    expect(processBlockSource).not.toContain("previousUserMessageId");
    expect(processBlockSource).not.toContain("onScrollToMessage");
    expect(processBlockSource).not.toContain("scrollToPreviousUserMessage");
  });

  it("shows the previous user message text in the global sticky toggle tooltip", () => {
    // 悬浮提示（title）显示上一条用户发言内容，而非处理耗时。
    expect(chatPanelSource).toContain("previousUserTargetPreview");
    expect(chatPanelSource).toContain("getChatMessagePreviewText(previousUserTarget)");
  });

  it("reserves a rail below the global sticky button for thinking locators", () => {
    expect(chatPanelStyles).toContain(".chat-sticky-previous-message");
    expect(chatPanelStyles).toContain("--chat-previous-message-rail-height");
  });

  it("excludes UI responses (questionnaire submissions) from speech history and the previous-speech button", () => {
    // 发言记录与「返回上一条发言」按钮只统计用户真实发言，问卷/UI 应答不参与。
    expect(chatStoreSource).toContain("export const isUserSpeechMessage");
    expect(chatStoreSource).toContain("message.role === \"user\" && !message.uiGenerated");
    expect(chatPanelSource).toContain("state.messages.filter((message) => isUserSpeechMessage(message))");
    expect(chatPanelSource).toContain("const speechIndexes = messages.reduce<number[]>(");
    expect(chatPanelSource).toContain("isUserSpeechMessage(message)");
    expect(pendingUIResponseSource).toContain("uiGenerated: true");
  });

  it("clears questionnaire options and custom text in both directions", () => {
    expect(questionnaireSource).toContain('setCustomText((current) => ({ ...current, [questionIndex]: "" }))');
    expect(questionnaireSource).toContain('setSingleChoice((current) => ({ ...current, [questionIndex]: "" }))');
    expect(questionnaireSource).toContain('setMultiChoice((current) => ({ ...current, [questionIndex]: [] }))');
  });

  it("renders confirm interactions as explicit allow or reject actions", () => {
    expect(confirmationSource).toContain(">拒绝</button>");
    expect(confirmationSource).toContain(">允许</button>");
    expect(pendingUIResponseSource).toContain('const isConfirmation = normalizedMethod === "confirm"');
    expect(chatPanelSource).toContain("<ConfirmationPanel");
  });

  it("renders permission choices separately from questionnaires", () => {
    expect(pendingUIResponseSource).toContain('normalizedMethod.includes("permission")');
    expect(pendingUIResponseSource).toContain("activePermissionChoice");
    expect(permissionChoiceSource).toContain("question?.options || []");
    expect(permissionChoiceSource).toContain("onClick={() => onSelect(option)}");
    expect(chatPanelSource).toContain("<PermissionChoicePanel");
  });

  it("notifies once per questionnaire when the window is in the background", () => {
    // 问卷弹出时发系统通知（后台才弹，与任务完成通知一致）；按 key 去重避免重复提醒。
    expect(chatPanelSource).toContain("notifiedQuestionnaireKeysRef");
    expect(chatPanelSource).toContain(
      'document.visibilityState === "visible" && document.hasFocus()',
    );
    expect(chatPanelSource).toContain('window.electronAPI.showNotification({');
    expect(chatPanelSource).toContain('title: "有新的问题需要你回答"');
    expect(chatPanelSource).toContain(
      'notifiedQuestionnaireKeysRef.current.has(questionnaireResetKey)',
    );
  });

  it("settles renderer state when an abort request throws", () => {
    const failureBranch = agentEventsSource.slice(agentEventsSource.indexOf("} catch (error) {"));
    expect(failureBranch).toContain("finishManualAbort(sessionId)");
  });

  it("shows message copy feedback", () => {
    expect(chatPanelSource).toContain('showFloatingToastMessage("已复制")');
    expect(chatPanelSource).toContain("copyMessageText(msg.content)");
  });

  it("opens explicit local Markdown links according to their real type", () => {
    expect(chatPanelSource).toContain("getLocalMarkdownFilePath");
    expect(chatPanelSource).toContain('target.closest<HTMLAnchorElement>("a.md-link")');
    expect(chatPanelSource).toContain("window.electronAPI.statPath(resolvedPath)");
    expect(chatPanelSource).toContain("onClick={handleMessageMarkdownLinkClick}");
    expect(chatPanelSource).toContain('preview: result.attachment.kind === "file"');
  });

  it("keeps inline paths clickable without guessing paths from fenced code blocks", () => {
    const markdownRendererSource = readFileSync(resolve(process.cwd(), "src/components/shared/MarkdownRenderer.tsx"), "utf8");
    expect(markdownRendererSource).toContain('md-inline-code${localPath ? " md-path-reference" : ""}');
    expect(markdownRendererSource).not.toContain('code className={`${className || ""}${localPath');
    expect(chatPanelSource).toContain('code.md-inline-code.md-path-reference');
  });

  it("allows @ mentions to attach files and folders", () => {
    expect(chatComposerSource).not.toContain("includeDirectories: false");
    expect(chatComposerSource).toContain('kind: item.isDirectory ? "folder" : "file"');
    expect(fileMentionPickerSource).toContain("item.isDirectory");
    expect(fileMentionPickerSource).toContain("<Folder");
    expect(fileMentionPickerSource).toContain('aria-label="选择要引用的文件或文件夹"');
  });

  it("keeps mention icons unchanged when an item is selected", () => {
    expect(chatPanelStyles).toContain(".chat-file-mention-item.folder > svg");
    expect(chatPanelStyles).not.toContain(".chat-file-mention-item.selected > svg");
  });

  it("coalesces file searches and keeps result versions attached to their rows", () => {
    expect(chatComposerSource).toContain("scheduleAbortableTask");
    expect(chatComposerSource).toContain("FILE_MENTION_SEARCH_DEBOUNCE_MS = 100");
    expect(chatComposerSource).toContain("fileMentionResultState.query !== fileMention.query");
    expect(fileSearchSource).toContain("scheduleAbortableTask");
    expect(fileSearchSource).toContain("FILE_SEARCH_DEBOUNCE_MS = 100");
    expect(fileSearchSource).toContain("resultState.query !== query");
    expect(fileSearchSource).toContain('searchError ? "无法读取项目内容"');
    expect(fileSearchSource).toContain('<Folder className="fs-item-icon folder" size={15} strokeWidth={1.8}');
    expect(fileSearchSource).toContain('<FileText className="fs-item-icon" size={15} strokeWidth={1.8}');
    expect(fileSearchStyles).toContain(".fs-item-icon.folder");
    expect(fileSearchStyles).toContain("color: #DCAB5F");
  });

  it("does not subscribe the full chat panel to draft text keystrokes", () => {
    expect(chatPanelSource).toContain("pendingPathAttachments: draft.pendingPathAttachments");
    expect(chatPanelSource).toContain("useChatStore.getState().sessionDrafts[activeSessionId]?.text");
  });

  it("allows sending during context compaction and admits the message through the queue", () => {
    expect(chatComposerSource).toContain("if (compactionInProgress && hasPendingContent)");
    expect(chatComposerSource).toContain("SessionCommandCoordinator perform authoritative admission");
    expect(chatComposerSource).toContain("(currentSessionRunning || compactionInProgress)");
    expect(chatComposerSource).toContain('placeholder={placeholder}');
    expect(chatComposerSource).not.toContain("sendDisabled && !(compactionInProgress && hasPendingContent)");
    expect(chatPanelSource).toContain("queueIfRunning: true");
    expect(chatPanelSource).toContain("canGuide && !compactionInProgress && !item.action");
    expect(chatPanelSource).not.toContain('showFloatingToastMessage("上下文正在压缩，请等待压缩完成后发送")');
  });

  it("keeps the queue edit dialog composer contained and its placeholder anchored to the editor", () => {
    // 队列编辑弹窗使用 Lexical contenteditable（InlineComposerEditor），
    // 旧的 `> textarea` 规则不生效：必须给实际渲染的 .inline-composer-editor
    // 补齐尺寸、换行与纵向滚动，并让 .inline-composer-placeholder 相对输入框定位，
    // 避免占位文字飘到标题区域形成“重影”。
    const queueComposerStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-queue-edit-composer {"),
      chatPanelStyles.indexOf(".chat-queue-edit-section {"),
    );
    expect(queueComposerStyles).toContain("position: relative");
    expect(queueComposerStyles).toContain(".chat-queue-edit-composer > .inline-composer-editor");
    expect(queueComposerStyles).toContain("overflow-y: auto");
    expect(queueComposerStyles).toContain("overflow-x: hidden");
    expect(queueComposerStyles).toContain("overflow-wrap: anywhere");
    expect(queueComposerStyles).toContain(".chat-queue-edit-composer .inline-composer-placeholder");
    // 主输入框（ChatComposer）传入 className="chat-textarea"，编辑器根自身即定位祖先，
    // 占位文字锚定到输入框内部，不会飘到视口左上角。
    const mainComposerStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-textarea.inline-composer-editor {"),
      chatPanelStyles.indexOf(".chat-textarea.inline-composer-editor:focus-within"),
    );
    expect(mainComposerStyles).toContain("position: relative");
  });

  it("moves a still-running compaction below the final response body", () => {
    expect(agentEventControllerSource).toContain("promoteContextCompactionToDivider(currentSessionId)");
    expect(agentEventControllerSource).toContain("removeLastAssistantProcessEntries([compactionId], sessionId)");
    expect(agentEventControllerSource).toContain('appendContextCompactionDivider(compactionId, sessionId, "running")');
    expect(agentEventControllerSource).toContain("runtime.activeCompactionId || eventId");
  });

  it("rechecks compaction before dispatching an existing queued message", () => {
    const dispatcherSource = chatPanelSource.slice(
      chatPanelSource.indexOf("const MessageQueueDispatcher"),
      chatPanelSource.indexOf("const ChatMessagesViewport"),
    );
    expect(dispatcherSource).toContain("compactingSessions[sessionId]");
    expect(dispatcherSource).toContain("queueIfRunning: true");
    expect(dispatcherSource).toContain("clientMessageId: nextItem.id");
    expect(dispatcherSource).toContain("if (result.queued)");
    expect(dispatcherSource).toContain("scheduleQueueRetry(sessionId)");
    expect(dispatcherSource).toContain("Renderer lifecycle events can be delayed or lost");
    expect(dispatcherSource).toContain("if (!isOpenQueueSession(sessionId))");
    const beforeBackendAdmission = dispatcherSource.slice(0, dispatcherSource.indexOf("void sendPayloadNow"));
    expect(beforeBackendAdmission).not.toContain("removeQueuedMessage(sessionId, nextItem.id)");
  });

  it("preserves the visible reading anchor when the process auto-collapses", () => {
    expect(chatScrollSource).toContain("preserveScrollDuringAutoLayoutChange");
    expect(chatScrollSource).toContain("document.elementFromPoint");
    expect(chatScrollSource).toContain('candidate.closest<HTMLElement>(".chat-process-output")');
    expect(chatScrollSource).toContain('querySelector<HTMLElement>(".chat-bubble-content")');
    expect(chatScrollSource).toContain("targetY - responseAnchor.viewportY");
    expect(chatScrollSource).toContain("anchor.getBoundingClientRect().top - anchorTop");
    expect(chatPanelSource).toContain("preserveAssistantProcessCollapse");
    expect(agentEventsSource).toContain("preserveAssistantProcessCollapse: (sessionId, action)");
  });

  it("keeps the final response on the same horizontal reading axis as process narration", () => {
    expect(chatPanelStyles).toContain("--chat-assistant-body-inset: 2px");
    expect(chatPanelStyles).toContain("padding: 6px 0 4px var(--chat-assistant-body-inset)");
    expect(chatPanelStyles).toContain("padding-left: var(--chat-assistant-body-inset)");
    expect(chatPanelStyles).toContain(".chat-commentary-item {");
    expect(chatPanelStyles).toContain(".chat-process-toggle > span:first-child {");
    expect(chatPanelStyles).toContain("padding-left: 2px;");
  });

  it("aligns the composer and message stream to the same centered content column", () => {
    expect(chatPanelSource).toContain('<div className="chat-input-content">');
    expect(chatPanelStyles).toContain("--chat-content-horizontal-gutter: 104px");
    expect(chatPanelStyles).toContain("width: calc(100% - var(--chat-content-horizontal-gutter))");
    expect(chatPanelStyles).not.toContain("--chat-content-max-width");
    expect(chatPanelStyles).toContain(".chat-input-content {");
    expect(chatPanelStyles).toContain(".chat-msg-wrapper {");
  });

  it("keeps thinking Markdown gray and regular-weight even when it contains emphasis", () => {
    const thinkingStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-process-thinking-output {"),
      chatPanelStyles.indexOf(".chat-process-entry.thinking .chat-process-entry-detail"),
    );
    expect(thinkingStyles).toContain("color: var(--text-secondary)");
    expect(thinkingStyles).toContain("font-weight: 400");
    expect(thinkingStyles).toContain(":is(strong, b)");
    expect(thinkingStyles).toContain("color: inherit");
    expect(thinkingStyles).toContain("font-weight: inherit");
  });

  it("keeps the user-message history popup isolated from the conversation scroller", () => {
    expect(chatPanelSource).not.toContain('className="chat-user-history-header"');
    expect(chatPanelSource).toContain('onWheel={(event) => event.stopPropagation()}');
    const popupStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-user-history-popup {"),
      chatPanelStyles.indexOf(".chat-header-history-anchor .chat-user-history-popup")
    );
    const listStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-user-history-list {"),
      chatPanelStyles.indexOf(".chat-user-history-item")
    );
    expect(popupStyles).toContain("pointer-events: auto");
    expect(popupStyles).toContain("overscroll-behavior: contain");
    expect(listStyles).toContain("overflow-y: auto");
    expect(listStyles).toContain("max-height: 400px");
    expect(listStyles).toContain("overscroll-behavior-y: contain");
  });

  it("contains long thinking code lines without widening the conversation scroller", () => {
    const messageScrollerStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-messages {"),
      chatPanelStyles.indexOf(".chat-messages-area.has-todo-summary"),
    );
    const processContentStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-process-content {"),
      chatPanelStyles.indexOf(".chat-process-guidance-row"),
    );
    const thinkingBodyStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-process-thinking-body {"),
      chatPanelStyles.indexOf(".chat-process-thinking-preview {\n  min-width: 0"),
    );
    expect(messageScrollerStyles).toContain("overflow-x: hidden");
    expect(processContentStyles).toContain("min-width: 0");
    expect(processContentStyles).toContain("max-width: 100%");
    expect(thinkingBodyStyles).toContain("min-width: 0");
    expect(thinkingBodyStyles).toContain("max-width: 100%");
    expect(thinkingBodyStyles).toContain("overflow: hidden");
  });

  it("vertically centers the guidance label beside its message bubble", () => {
    const guidanceStyles = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-process-guidance-content {"),
      chatPanelStyles.indexOf(".chat-process-guidance-label {"),
    );
    expect(guidanceStyles).toContain("align-items: center");
    expect(guidanceStyles).not.toContain("align-items: flex-end");
  });

  it("keeps pending interactions isolated by session across desktop and remote clients", () => {
    expect(chatPanelSource).toContain("usePendingUIResponse(activeSessionId, openSessionIds)");
    expect(chatPanelSource).toContain("pendingInteractions: pendingUIResponses");
    expect(chatPanelSource).toContain("getPendingInteraction: getPendingUIResponse");
    expect(chatPanelSource).toContain("clearPendingInteraction: clearPendingUIResponse");
    expect(pendingUIResponseSource).toContain("retainPendingUIResponses(next, openSessionIds)");
  });

  it("uses the desktop lifecycle settlement for remote interaction responses", () => {
    expect(chatPanelSource).toContain("preparePendingQuestionContinuation(sessionId, sessionRuntimeRef)");
    expect(chatPanelSource).toContain("onInteractionResponseAccepted: refreshSessionWatchdog");
    expect(chatPanelSource).toContain("settleFailedPendingQuestionTurn(");
    expect(chatPanelSource).toContain("onInteractionResponseFailed: settleRemoteInteractionResponseFailure");
  });

  it("stops stale process timers and running decorations after the session settles", () => {
    expect(chatPanelSource).toContain("getActiveAssistantTurnId(messages, currentSessionRunning)");
    expect(chatPanelSource).toContain("turnRunning={message.id === activeTurnId}");
    expect(chatPanelSource).toContain("running={processRunning}");
    expect(processBlockSource).toContain("normalizeProcessForView(process");
    expect(processBlockSource).toContain("useProcessTicker(processRunning)");
    expect(processBlockSource).toContain("visibleEntries.length > 0 || processRunning");
  });

  it("shows the current native todo title without the completed-total counter", () => {
    expect(chatPanelSource).toContain("const getCurrentTodoStep = (steps: AgentProcessStep[])");
    expect(chatPanelSource).toContain('steps.find((step) => step.status === "running")');
    expect(chatPanelSource).toContain('className={`chat-todo-summary-dot ${currentStep?.status || ""}`}');
    expect(chatPanelSource).toContain('className="chat-todo-summary-text" title={currentStep?.title || "任务处理中"}');
    expect(chatPanelSource).toContain('className="chat-diff-add"');
    expect(chatPanelSource).toContain('className="chat-diff-del"');
    expect(chatPanelSource).not.toContain("步骤 {completedCount}/{steps.length}");
    expect(chatPanelStyles).toContain(".chat-todo-summary-dot.running {");
    expect(chatPanelStyles).toContain("animation: chat-todo-summary-spin 850ms linear infinite, chat-agent-dot-pulse 1.6s ease-in-out infinite;");
    expect(chatPanelStyles).toContain(".chat-todo-summary-dot.completed {");
    expect(chatPanelStyles).toContain(".chat-todo-summary-dot.failed {");
    expect(chatPanelStyles).toContain(".chat-todo-summary-dot.cancelled {");
    expect(chatPanelStyles).toContain("align-items: center;");
    expect(chatPanelStyles).not.toContain(".chat-todo-summary-dot.completed::after");
    expect(chatPanelStyles).toContain(".chat-todo-summary-text {");
    expect(chatPanelStyles).toContain("text-overflow: ellipsis;");
  });
});
