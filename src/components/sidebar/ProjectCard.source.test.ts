import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import projectCardSource from "./ProjectCard.tsx?raw";
import projectViewSource from "./ProjectView.tsx?raw";
import newSessionSource from "./NewSessionModal.tsx?raw";

const chatPanelStyles = readFileSync(new URL("../layout/ChatPanel.css", import.meta.url), "utf8");
const sidebarStyles = readFileSync(new URL("./Sidebar.css", import.meta.url), "utf8");

describe("ProjectCard lifecycle regression constraints", () => {
  it("waits for every backend close and preserves the project when any close truly fails", () => {
    const deleteHandler = projectCardSource.slice(
      projectCardSource.indexOf("const handleDeleteProject"),
      projectCardSource.indexOf("const handleResumeSession"),
    );

    expect(deleteHandler).toContain("Promise.allSettled");
    expect(deleteHandler).toContain('result.status === "rejected"');
    expect(deleteHandler).toContain("if (failures.length > 0)");
    expect(deleteHandler).toContain("项目未删除");
    expect(deleteHandler.indexOf("if (failures.length > 0)"))
      .toBeLessThan(deleteHandler.indexOf("removeProject(project.id)"));
    expect(deleteHandler).not.toContain(".finally(() =>");
  });

  it("treats a removed backend cleanup warning as a completed close", () => {
    const deleteHandler = projectCardSource.slice(
      projectCardSource.indexOf("const handleDeleteProject"),
      projectCardSource.indexOf("const handleResumeSession"),
    );

    expect(deleteHandler).toContain('result.status === "fulfilled" && result.value.warning');
    expect(deleteHandler).toContain("project sessions closed with cleanup warnings");
    expect(deleteHandler).toContain("deleteSessionsMessages(sessionIds)");
    expect(deleteHandler).toContain("purgeDeletedSessionData(sessionIds, [project.id])");
  });

  it("starts initialized-session activation without holding the tab click handler open", () => {
    const activationHandler = projectCardSource.slice(
      projectCardSource.indexOf("const handleSelectSession"),
      projectCardSource.indexOf("const handleCloseSession"),
    );

    expect(activationHandler).not.toContain("async (session");
    expect(activationHandler).toContain("void SessionCommandCoordinator.initializeSession");
  });

  // 空对话关闭后不该留下历史条目，而且必须先关后端再删 —— 后端还活着时把会话
  // 从列表抹掉会漏掉一个 CLI 进程。
  it("discards an empty session on close instead of archiving it", () => {
    const closeHandler = projectCardSource.slice(
      projectCardSource.indexOf("const handleCloseSession"),
      projectCardSource.indexOf("const handleDeleteProject"),
    );

    expect(closeHandler).toContain("await hasNoSessionMessages(sessionId)");
    expect(closeHandler).toContain("await discardSessionsCompletely([sessionId])");
    expect(closeHandler.indexOf("await SessionCommandCoordinator.closeSession(sessionId)"))
      .toBeLessThan(closeHandler.indexOf("if (empty) await discardSessionsCompletely"));
  });

  it("purges messages, session entry and disk rows in one permanent-delete routine", () => {
    const discardSource = readFileSync(new URL("../../lib/session-discard.ts", import.meta.url), "utf8");

    expect(discardSource).toContain("deleteSessionsMessages(uniqueSessionIds)");
    expect(discardSource).toContain("projectState.removeSession(owner.id, sessionId)");
    expect(discardSource).toContain("await purgeDeletedSessionData(uniqueSessionIds)");
    expect(discardSource).toContain("uniqueSessionIds.length === 0");
  });

  it("still limits the history modal to closed sessions", () => {
    const historyDeletion = projectCardSource.slice(
      projectCardSource.indexOf("const handleDeleteHistorySessions"),
      projectCardSource.indexOf("const handleDeleteHistorySession ="),
    );

    expect(historyDeletion).toContain("session.closed");
    expect(historyDeletion).toContain("await discardSessionsCompletely(targets)");
    expect(historyDeletion).toContain("if (targets.length === 0) return;");
  });

  it("remembers each card's expanded state across restarts", () => {
    // 启动默认只对“从未手动切换过”的项目生效：默认展开当前会话所在的项目。
    expect(projectViewSource).toContain("projectDataHydrated && startupCollapseStateRef.current === null");
    expect(projectViewSource).toContain("project.id !== rememberedProjectId");
    expect(projectViewSource).toContain("project.sessionsCollapsed");
    // 手动切换后写回项目本身（随 projects.json 持久化），下次启动沿用。
    expect(projectCardSource).toContain("project.sessionsCollapsed ?? initialSessionsCollapsed");
    expect(projectCardSource).toContain("setProjectSessionsCollapsed(project.id, next)");
    // 不再每次渲染都把卡片状态重置成启动默认。
    expect(projectCardSource).not.toContain("useState(initialSessionsCollapsed)");
  });

  it("opens the add-project form as a centered modal without pushing the project list", () => {
    expect(projectViewSource).toContain("createPortal(");
    expect(projectViewSource).toContain('className="project-modal-overlay"');
    expect(projectViewSource).toContain('className="project-form project-modal"');
    expect(projectViewSource).toContain('role="dialog"');
    expect(projectViewSource).toContain('aria-modal="true"');
    expect(projectViewSource).toContain('aria-labelledby="add-project-title"');
    expect(projectViewSource).toContain('event.key !== "Escape"');
    expect(projectViewSource).toContain("document.body");
  });

  it("does not evaluate message-local debug variables while rendering the project list", () => {
    expect(projectCardSource).not.toContain("JSON.stringify(firstUserMsg");
    expect(projectCardSource).toContain('className="terminal-child-title"');
  });

  it("derives session tab titles from ordered composer messages", () => {
    expect(projectCardSource).toContain("getSessionPreviewLabel(firstUserMsg)");
    expect(projectCardSource).not.toContain("content={firstUserMsg.content}");
  });

  // 页签标题被 CSS + maxLength={30} 双重截断，悬浮 tips 必须是未截断的完整
  // 首条内容，否则长提示语的会话之间没法区分。
  it("shows the untruncated first message as the session tab tooltip", () => {
    const tabBlock = projectCardSource.slice(
      projectCardSource.indexOf("{openSessions.map((session) => {"),
      projectCardSource.indexOf("{(session.forkedFrom || session.forkContext) && ("),
    );

    expect(tabBlock).toContain("getSessionPreviewLabel(firstUserMsg)");
    expect(tabBlock).toContain("session.preview || \"\"");
    expect(tabBlock).toContain("const tabLabel = tabPreview || session.title;");
    expect(tabBlock).toContain("title={tabLabel}");
    // 展示仍用 30 字符截断版本，只有 tips 是完整的
    expect(tabBlock).toContain("maxLength={30}");
    expect(tabBlock).not.toContain("title={tabPreview.slice(0, 30)}");
  });

  it("uses one explicit title typography for command and file process summaries", () => {
    const titleRule = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-process-entry-title {"),
      chatPanelStyles.indexOf(".chat-subagent-entry {"),
    );
    expect(titleRule).toContain("font-size: 14px");
    expect(titleRule).toContain("font-weight: 400");
    expect(titleRule).toContain("line-height: 21px");
  });

  it("keeps the project bar scrollable while hiding its scrollbar completely", () => {
    const sidebarContentRule = sidebarStyles.slice(
      sidebarStyles.indexOf(".sidebar-content {"),
      sidebarStyles.indexOf(".project-list {"),
    );
    expect(sidebarContentRule).toContain("overflow-y: auto");
    expect(sidebarContentRule).toContain("scrollbar-width: none");
    expect(sidebarContentRule).toContain("-ms-overflow-style: none");
    expect(sidebarContentRule).toContain(".sidebar-content::-webkit-scrollbar");
    expect(sidebarContentRule).toContain("display: none");
  });

  it("prevents the hidden max-content Agent measurement row from creating horizontal overflow", () => {
    const sidebarContentRule = sidebarStyles.slice(
      sidebarStyles.indexOf(".sidebar-content {"),
      sidebarStyles.indexOf("}\n\n.placeholder-text"),
    );
    const terminalRule = sidebarStyles.slice(
      sidebarStyles.indexOf(".project-terminals {"),
      sidebarStyles.indexOf("}\n\n.project-terminal-measurements"),
    );
    expect(sidebarContentRule).toContain("overflow-x: hidden");
    expect(terminalRule).toContain("overflow-x: hidden");
    expect(terminalRule).toContain("overflow-y: visible");
  });

  it("opens the same add-project modal styling for editing name and path", () => {
    const editModal = readFileSync(new URL("./ProjectEditModal.tsx", import.meta.url), "utf8");

    expect(projectCardSource).toContain("setShowEdit(true)");
    expect(projectCardSource).toContain("<ProjectEditModal");
    expect(projectCardSource).toContain("updateProject(project.id, { name, path })");
    expect(editModal).toContain('className="project-form project-modal"');
    expect(editModal).toContain('className="input-field path-input"');
    expect(editModal).toContain("window.electronAPI.openDirectory()");
  });

  // 默认工作区是内置卡片：路径只能存在设置里，否则两处各存一份、重启后互相覆盖。
  it("keeps the built-in default workspace path in settings and hides its delete button", () => {
    const saveHandler = projectCardSource.slice(
      projectCardSource.indexOf("const handleSaveProjectEdit"),
      projectCardSource.indexOf("const handleDeleteProject"),
    );
    expect(saveHandler).toContain("saveDefaultWorkspacePath(path)");
    expect(saveHandler).toContain("syncDefaultWorkspace(path)");
    expect(projectCardSource).toContain("{!isDefaultWorkspace && (");
    expect(projectViewSource).toContain("defaultWorkspaceProject");
    expect(projectViewSource).toContain("draggableProjects = projects.filter");
  });
});

describe("ProjectCard worktree session option", () => {
  it("asks for the workspace mode per new session", () => {
    expect(projectCardSource).toContain("const [newSessionAgent, setNewSessionAgent]");
    expect(projectCardSource).toContain("setNewSessionAgent(agent)");
    expect(projectCardSource).toContain("<NewSessionModal");
    expect(projectCardSource).toContain("workspaceMode");
    expect(newSessionSource).toContain("worktreeProbe(project.path)");
    expect(newSessionSource).toContain("{!defaultWorkspace && (");
    expect(newSessionSource).toContain("useWorktree && canUseWorktree ? \"worktree\" : \"shared\"");
    expect(sidebarStyles).toContain(".new-session-worktree");
    expect(sidebarStyles).toContain(".terminal-child-worktree-badge");
  });

  it("opens the Git workspace from the project card and dirty new-session modal", () => {
    expect(projectCardSource).toContain("<GitWorkspaceModal");
    expect(projectCardSource).toContain("打开 Git 工作台");
    expect(newSessionSource).toContain("onOpenGit");
    expect(newSessionSource).toContain("打开 Git 工作台");
  });
});
