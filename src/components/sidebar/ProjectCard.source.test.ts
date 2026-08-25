import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import projectCardSource from "./ProjectCard.tsx?raw";
import projectViewSource from "./ProjectView.tsx?raw";

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

  it("captures the remembered session project once and leaves later card state user-controlled", () => {
    expect(projectViewSource).toContain("projectDataHydrated && startupCollapseStateRef.current === null");
    expect(projectViewSource).toContain("project.id !== rememberedProjectId");
    expect(projectViewSource).toContain("initialSessionsCollapsed={startupCollapseStateRef.current?.get(project.id) ?? false}");
    expect(projectCardSource).toContain("useState(initialSessionsCollapsed)");
    expect(projectCardSource).not.toContain("setSessionsCollapsed(project.id");
  });

  it("does not evaluate message-local debug variables while rendering the project list", () => {
    expect(projectCardSource).not.toContain("JSON.stringify(firstUserMsg");
    expect(projectCardSource).toContain('className="terminal-child-title"');
  });

  it("derives session tab titles from ordered composer messages", () => {
    expect(projectCardSource).toContain("getChatMessagePreviewText(firstUserMsg)");
    expect(projectCardSource).not.toContain("content={firstUserMsg.content}");
  });

  it("uses one explicit title typography for command and file process summaries", () => {
    const titleRule = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-process-entry-title {"),
      chatPanelStyles.indexOf(".chat-process-idle-duration {"),
    );
    expect(titleRule).toContain("font-size: 12px");
    expect(titleRule).toContain("font-weight: 400");
    expect(titleRule).toContain("line-height: 18px");
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
});
