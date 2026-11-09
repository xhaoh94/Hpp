import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_PROJECT_ID,
  isDefaultWorkspaceProject,
  resolveDefaultWorkspacePath,
  withDefaultWorkspace,
} from "./default-workspace";
import type { Project } from "@/stores/project-store";

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: "project-1",
  name: "Project",
  path: "/work/project-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  agents: [],
  sessions: [],
  ...overrides,
});

describe("默认工作区路径解析", () => {
  it("没配置时回落到 <home>/hpp，并按 home 的分隔符拼接", () => {
    expect(resolveDefaultWorkspacePath("/home/xhaoh", "")).toBe("/home/xhaoh/hpp");
    expect(resolveDefaultWorkspacePath("C:\\Users\\xhaoh", undefined)).toBe("C:\\Users\\xhaoh\\hpp");
    // 末尾分隔符不能拼出双斜杠
    expect(resolveDefaultWorkspacePath("/home/xhaoh/", "")).toBe("/home/xhaoh/hpp");
  });

  it("配置了就用配置值，且去掉首尾空白", () => {
    expect(resolveDefaultWorkspacePath("/home/xhaoh", "  /data/work  ")).toBe("/data/work");
  });

  // 空路径的项目会让 agent 起进程时 ENOENT，宁可不注入卡片。
  it("拿不到 home 又没有配置时返回空串", () => {
    expect(resolveDefaultWorkspacePath("", "")).toBe("");
    expect(resolveDefaultWorkspacePath(undefined, undefined)).toBe("");
  });
});

describe("内置默认工作区卡片", () => {
  it("没有时插入到首位并带上固定 id 与名称", () => {
    const projects = [makeProject()];
    const next = withDefaultWorkspace(projects, "/data/default");

    expect(next[0].id).toBe(DEFAULT_WORKSPACE_PROJECT_ID);
    expect(next[0].name).toBe(DEFAULT_WORKSPACE_NAME);
    expect(next[0].path).toBe("/data/default");
    expect(next[1].id).toBe("project-1");
    expect(isDefaultWorkspaceProject(next[0])).toBe(true);
  });

  it("已存在时移到首位、保留会话，并按设置同步路径", () => {
    const builtin = makeProject({
      id: DEFAULT_WORKSPACE_PROJECT_ID,
      name: DEFAULT_WORKSPACE_NAME,
      path: "/old",
      sessions: [{
        id: "session-1",
        agentId: "codex",
        agentSessionId: "session-1",
        title: "Session",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    const next = withDefaultWorkspace([makeProject(), builtin], "/new");

    expect(next[0].id).toBe(DEFAULT_WORKSPACE_PROJECT_ID);
    expect(next[0].path).toBe("/new");
    expect(next[0].sessions.map((session) => session.id)).toEqual(["session-1"]);
    expect(next[0].createdAt).toBe(builtin.createdAt);
  });

  it("重建默认工作区时保留卡片偏好（如展开/收起记忆）", () => {
    const builtin = makeProject({
      id: DEFAULT_WORKSPACE_PROJECT_ID,
      name: DEFAULT_WORKSPACE_NAME,
      path: "/old",
      sessionsCollapsed: true,
    });
    const next = withDefaultWorkspace([makeProject(), builtin], "/new");

    expect(next[0].path).toBe("/new");
    // 只重建固定字段，sessionsCollapsed 这类持久化偏好不能被抹掉。
    expect(next[0].sessionsCollapsed).toBe(true);
  });

  it("路径为空时保留已有卡片，不把会话一起丢掉", () => {
    const builtin = makeProject({ id: DEFAULT_WORKSPACE_PROJECT_ID, name: DEFAULT_WORKSPACE_NAME, path: "/old" });
    const next = withDefaultWorkspace([builtin], "");

    expect(next[0].path).toBe("/old");
  });

  it("已经就位且路径未变时返回原数组，避免 store 无谓重渲染", () => {
    const builtin = makeProject({ id: DEFAULT_WORKSPACE_PROJECT_ID, name: DEFAULT_WORKSPACE_NAME, path: "/same" });
    const projects = [builtin, makeProject()];

    expect(withDefaultWorkspace(projects, "/same")).toBe(projects);
  });

  it("没有 home 也没有配置时不注入空路径卡片", () => {
    const projects = [makeProject()];
    expect(withDefaultWorkspace(projects, "")).toBe(projects);
  });
});
