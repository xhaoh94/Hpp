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
import agentEventControllerSource from "./agentEventController.ts?raw";
import processBlockSource from "./ProcessBlock.tsx?raw";

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

  it("explains why sending is blocked while context compaction is running", () => {
    expect(chatComposerSource).toContain("if (compactionInProgress && hasPendingContent)");
    expect(chatComposerSource).toContain("Let ChatPanel verify whether compaction is still active in the backend.");
    expect(chatComposerSource).toContain("sendDisabled && !(compactionInProgress && hasPendingContent)");
    expect(chatComposerSource).toContain('aria-disabled={!showAbortButton && sendDisabled}');
    expect(chatPanelSource).toContain("SessionCommandCoordinator.getBackendSessionActivity(targetSessionId)");
    expect(chatPanelSource).toContain('backendActivity === "busy" || backendActivity === "unknown"');
    expect(chatPanelSource).toContain('showFloatingToastMessage("上下文正在压缩，请等待压缩完成后发送")');
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
      chatPanelStyles.indexOf(".chat-process-thinking-preview"),
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
    expect(chatPanelSource).toContain("turnRunning={msg.id === activeTurnId}");
    expect(chatPanelSource).toContain("running={processRunning}");
    expect(processBlockSource).toContain("normalizeProcessForView(process");
    expect(processBlockSource).toContain("useProcessTicker(processRunning)");
    expect(processBlockSource).toContain("visibleEntries.length > 0 || processRunning");
  });
});
