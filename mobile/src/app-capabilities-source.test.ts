import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getActiveAssistantTurnId } from "../../shared/process-view";

const appSource = readFileSync(resolve(process.cwd(), "mobile/src/App.tsx"), "utf8");
const stylesSource = readFileSync(resolve(process.cwd(), "mobile/src/styles.css"), "utf8");

describe("mobile capability source constraints", () => {
  it("settles stale process animations when the session is no longer running", () => {
    expect(appSource).toContain("getActiveAssistantTurnId(selectedMessages");
    expect(appSource).toContain("normalizeProcessForView(message.process");
    expect(appSource).toContain("useProcessTicker(processRunning)");
    expect(appSource).toContain("running && item.isStreaming");
    expect(appSource).toContain("turnRunning={message.id === activeTurnMessageId}");
  });

  it("keeps the mobile process presentation as a bordered card", () => {
    expect(stylesSource).toContain(".process-block { min-width: 0; max-width: 100%; margin-top: 8px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface); }");
    expect(stylesSource).toContain(".process-block > summary { display: flex; min-height: 36px;");
    expect(stylesSource).toContain(".process-block > summary::-webkit-details-marker { display: none; }");
    expect(stylesSource).toContain(".process-block[open] > summary .expand-indicator,");
    expect(stylesSource).toContain(".command-group-item[open] > summary .expand-indicator { transform: rotate(180deg); }");
  });

  it("aligns intermediate and final assistant body text with the process content axis", () => {
    expect(stylesSource).toContain("--message-assistant-body-inset: 10px");
    expect(stylesSource).toContain(".message.assistant > .message-content,");
    expect(stylesSource).toContain(".message.assistant > .message-commentary,");
    expect(stylesSource).toContain(".message.assistant .message-commentary-item.message-content");
    expect(stylesSource).toContain(".message.assistant .process-block .message-commentary-item.message-content");
  });

  it("renders mobile thinking details as contained Markdown and keeps final text off the right edge", () => {
    expect(appSource).toContain('entry.type === "thinking"');
    expect(appSource).toContain('className="process-entry-detail message-content"');
    expect(stylesSource).toContain(".process-entry-detail { box-sizing: border-box; width: calc(100% - 10px);");
    expect(stylesSource).toContain("overflow-wrap: anywhere;");
    expect(stylesSource).toContain(".message.assistant .message-commentary-item.message-content { padding-left: var(--message-assistant-body-inset); padding-right: 5px; }");
    expect(stylesSource).toContain(".messages-view { width: 100%; height: 100%; min-height: 0; overflow-x: hidden;");
    expect(stylesSource).toContain(".process-entry > pre,");
    expect(stylesSource).toContain("white-space: pre-wrap;");
    expect(stylesSource).toContain("overflow-x: hidden;");
  });

  it("vertically centers the guidance label beside its message bubble", () => {
    expect(stylesSource).toContain(".process-guidance-content { display: flex; min-width: 0; max-width: 100%; align-items: center;");
  });

  it("does not keep a mobile process timer active after the final body is emitted", () => {
    expect(getActiveAssistantTurnId([{
      id: "mobile-final",
      role: "assistant",
      content: "最终正文",
      isStreaming: false,
      process: { endedAt: undefined },
      commentary: [{ content: "中间说明", isStreaming: true }],
    }], true)).toBeNull();
  });

  it("keeps the Agent action picker connected to drafts, sends, and message rendering", () => {
    expect(appSource).toContain('"session.actions.get"');
    expect(appSource).toContain('<WandSparkles size={15} /><span>技能</span>');
    expect(appSource).toContain("actionCount: pendingAction ? 1 : 0");
    expect(appSource).toContain("selectedAction={pendingAction}");
    expect(appSource).toContain("? draft?.action : undefined");
    expect(appSource).toContain("action,");
    expect(appSource).toContain("message.action &&");
  });

  it("uses model-specific thinking levels in the mobile picker", () => {
    expect(appSource).toContain("getModelThinkingLevels(selectedConfig?.model)");
    expect(appSource).toContain("levels={thinkingLevels}");
    expect(appSource).toContain('aria-label="思考等级"');
    expect(appSource).not.toContain("THINKING_LEVELS.map");
  });

  it("keeps model and thinking selectors available while an Agent is running", () => {
    expect(appSource).not.toContain('disabled={commandBusy || (!demoMode && selected.session.status === "running")}');
    expect(appSource).not.toContain('disabled={commandBusy || selected.session.status === "running"}');
  });

  it("centers configuration menus on their trigger while keeping them in the viewport", () => {
    expect(appSource).toContain("useAnchoredOverlay(open, rootRef, menuRef)");
    expect(appSource).toContain("style={menuStyle}");
  });

  it("truncates long session titles only on phone-sized screens", () => {
    expect(stylesSource).toContain("@media (max-width: 599px)");
    expect(stylesSource).toContain(".toolbar-title-row strong { max-width: 16em; }");
  });

  it("shows permission modes before the model picker when the Agent supports them", () => {
    expect(appSource).toContain("selectedAgent?.supportsPermissions === true");
    expect(appSource).toContain("<MobilePermissionPicker");
    expect(appSource).toContain('"settings.setPermissionMode"');
    expect(appSource.indexOf("<MobilePermissionPicker")).toBeLessThan(appSource.indexOf("<MobileModelPicker"));
  });

  it("matches the desktop permission menu colors", () => {
    expect(stylesSource).toContain(".permission-picker-trigger.danger { color: var(--yellow); }");
    expect(stylesSource).toContain(".permission-option.danger b { color: var(--yellow); }");
    expect(stylesSource).toContain(".permission-check { align-self: center; color: var(--accent); }");
    expect(stylesSource).toContain("background: var(--surface);");
  });

  it("keeps queued sends out of the chat until the desktop dispatches them", () => {
    expect(appSource).toContain('const result = await runCommand<{ queued?: boolean }>("session.send"');
    expect(appSource).toContain("queued = result.queued === true");
    expect(appSource).toContain("if (!queued) {");
  });

  it("keeps guided queue items until the desktop confirms the response started", () => {
    const guideSource = appSource.slice(
      appSource.indexOf("const guideQueuedMessage"),
      appSource.indexOf("const removeQueuedMessage"),
    );
    const successBranch = guideSource.slice(
      guideSource.indexOf("try {"),
      guideSource.indexOf("} catch (error)", guideSource.indexOf("try {")),
    );
    expect(successBranch).toContain('await runCommand("session.queue.guide"');
    expect(successBranch).toContain("showFloatingToast(\"已转为引导\")");
    expect(successBranch).not.toContain("filter((queued) => queued.id !== item.id)");
    expect(appSource).toContain('name === "session.queue.updated" && Array.isArray(data.queue)');
  });

  it("reloads stale sessions after reconnects and revision gaps", () => {
    expect(appSource).toContain("const staleSessionIdsRef = useRef(new Set<string>())");
    expect(appSource).toContain("staleSessionIdsRef.current.add(sessionId)");
    expect(appSource).toContain("staleSessionIdsRef.current.has(sessionId)");
    expect(appSource).toContain("if (sessionId) void loadSession(sessionId)");
  });

  it("does not let an in-flight stale session load suppress its required retry", () => {
    expect(appSource).toContain("const reloadAfterSessionLoadRef = useRef(new Set<string>())");
    expect(appSource).toContain("reloadAfterSessionLoadRef.current.add(sessionId)");
    expect(appSource).toContain("reload = reloadAfterSessionLoadRef.current.delete(sessionId)");
    expect(appSource).toContain("queueMicrotask(() => void loadSessionRef.current(sessionId))");
  });

  it("rejects session pages older than delivered remote events", () => {
    expect(appSource).toContain("const requiredSessionRevisionsRef = useRef<Record<string, number>>({})");
    expect(appSource).toContain("const sessionLoadGenerationsRef = useRef<Record<string, number>>({})");
    expect(appSource).toContain("page.revision,");
    expect(appSource).toContain("requiredRevision,");
    expect(appSource).toContain("sessionLoadGenerationsRef.current[sessionId] !== loadGeneration");
  });

  it("refreshes the complete session config whenever a session is opened", () => {
    expect(appSource).toContain('client.request<RemoteSessionConfig>("session.models.get", { sessionId })');
    expect(appSource).toContain("applySessionConfig(sessionId, config)");
    expect(appSource).toMatch(/const selectSession = useCallback\([\s\S]*?void loadSession\(sessionId\);[\s\S]*?\}, \[loadSession\]\);/);
  });

  it("shows open sessions in the main view before a session is selected", () => {
    expect(appSource).toContain('className="session-picker-view"');
    expect(appSource).toContain("选择会话");
    expect(appSource).toContain("openSessionCount === 0");
    expect(stylesSource).toContain(".session-picker-row");
  });

  it("navigates Android back from Agent to sessions and then to pairing", () => {
    expect(appSource).toContain('CapacitorApp.addListener("backButton"');
    expect(appSource).toContain("selectedSessionRef.current = null;");
    expect(appSource).toContain("setSelectedSessionId(null);");
    expect(appSource).toContain("leaveActiveHost();");
    expect(appSource).toContain("void CapacitorApp.exitApp();");
  });

  it("shows feedback after copying a message", () => {
    expect(appSource).toContain('showFloatingToast("已复制")');
    expect(appSource).toContain("onCopy={copyMessage}");
  });

  it("uses desktop-style insertion lines when reordering queued messages", () => {
    expect(appSource).toContain('const [dropPosition, setDropPosition] = useState<"before" | "after">("before")');
    expect(appSource).toContain("const insertAfter = event.clientY >= rect.top + rect.height / 2");
    expect(appSource).toContain("if (nextIndex === sourceIndex)");
    expect(appSource).toContain('`drop-target ${dropPosition}`');
    expect(stylesSource).toContain(".queue-item.drop-target::before");
    expect(stylesSource).toContain(".queue-item.drop-target.after::before");
  });

  it("caps the mobile queue width like the composer input shell", () => {
    // 输入框 .composer-input-shell 限制 max-width: 860px 并居中；
    // 消息队列 .queue-strip 在 .composer 内同样应限制最大宽度并居中，宽屏下与输入框对齐。
    const shellStyles = stylesSource.slice(
      stylesSource.indexOf(".composer-input-shell {"),
      stylesSource.indexOf(".composer-input-shell textarea"),
    );
    expect(shellStyles).toContain("max-width: 860px");
    expect(shellStyles).toContain("margin: 0 auto");
    const stripStyles = stylesSource.slice(
      stylesSource.indexOf(".queue-strip {"),
      stylesSource.indexOf(".queue-header {"),
    );
    expect(stripStyles).toContain("max-width: 860px");
    expect(stripStyles).toContain("margin: 0 auto 8px");
  });

  it("anchors the queue edit composer placeholder to the editor box", () => {
    // .inline-composer-placeholder 是 absolute 定位，必须由 .queue-edit-composer 提供定位祖先，
    // 否则空内容时占位文字（如“编辑消息内容”）会飘到界面左上角。
    const composerStyles = stylesSource.slice(
      stylesSource.indexOf(".queue-edit-composer {"),
      stylesSource.indexOf(".queue-edit-composer:focus-within"),
    );
    expect(composerStyles).toContain("position: relative");
  });

  it("pauses host availability polling while editing a desktop note", () => {
    expect(appSource).toContain("!hostsLoaded || activeHost || editingHostId || hosts.length === 0");
    expect(appSource).toContain("let probing = false");
    expect(appSource).toContain("if (disposed || probing) return;");
  });
});
