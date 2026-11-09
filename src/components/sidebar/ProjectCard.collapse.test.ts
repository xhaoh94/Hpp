import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectCard } from "./ProjectCard";
import type { Project } from "@/stores/project-store";

const makeProject = (over: Partial<Project> = {}): Project => ({
  id: "ux-game",
  name: "UxGame",
  path: "C:/Project/UxGame",
  createdAt: "2026-01-01T00:00:00.000Z",
  agents: ["pi"],
  sessions: [],
  ...over,
});

const render = (project: Project, initialSessionsCollapsed: boolean) =>
  renderToStaticMarkup(createElement(ProjectCard, { project, initialSessionsCollapsed }));

describe("项目卡片展开状态的应用", () => {
  it("持久化的是展开(false)时，即使启动默认是折叠也要展开", () => {
    const html = render(makeProject({ sessionsCollapsed: false }), true);
    expect(html).not.toContain("sessions-collapsed");
  });

  it("持久化的是折叠(true)时，即使启动默认是展开也要折叠", () => {
    const html = render(makeProject({ sessionsCollapsed: true }), false);
    expect(html).toContain("sessions-collapsed");
  });

  it("没有持久化字段时回落到启动默认", () => {
    expect(render(makeProject(), true)).toContain("sessions-collapsed");
    expect(render(makeProject(), false)).not.toContain("sessions-collapsed");
  });
});
