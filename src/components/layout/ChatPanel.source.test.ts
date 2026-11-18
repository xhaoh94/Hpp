import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("chat history never waits for the agent backend", () => {
  it("gates the message viewport on history readiness instead of backend initialization", () => {
    const source = readWorkspaceFile("src/components/layout/ChatPanel.tsx");

    // 后端还在唤醒时也必须渲染已经恢复的历史，只有“历史尚未读完”才允许遮罩。
    expect(source).toContain("{activeSessionId && !historyReady ? (");
    expect(source).not.toContain("!activeSessionInitialized ? (");
    expect(source).toContain("const activeSessionHistoryReady = !activeSessionId");
  });

  it("shows a spinner placeholder while a brand-new session is still initializing", () => {
    const source = readWorkspaceFile("src/components/layout/ChatPanel.tsx");
    const composerSource = readWorkspaceFile("src/components/layout/ChatComposer.tsx");
    const styles = readWorkspaceFile("src/components/layout/ChatPanel.css");

    // 不再用常驻横幅；但新建会话（无任何消息）且后端还在初始化时要显示转圈占位，
    // 否则用户会看到“发送消息开始对话”却发不出去。
    expect(source).not.toContain("chat-runtime-waking");
    expect(source).toContain("if (activeSessionInitializing) return;");
    expect(source).toContain("sessionInitializing={activeSessionInitializing}");
    expect(source).toContain("sessionInitializing ? (");
    expect(source).toContain("正在启动会话后端...");
    expect(composerSource).toContain("const sendDisabled = sessionInitializing");
    expect(styles).not.toContain(".chat-runtime-waking");
  });

  it("keeps the diff panel visible in every output level", () => {
    const source = readWorkspaceFile("src/components/layout/ChatPanel.tsx");
    const styles = readWorkspaceFile("src/components/layout/ChatPanel.css");

    // 变更文件面板（文件列表 + 审核入口）属于“改了什么”的内容，与输出等级无关：
    // 简洁/标准/详细都要完整显示，不能退化成一个数量文字。
    expect(source).toContain("const showDiffBlock = substantiveDiffs.length > 0;");
    expect(source).not.toContain("showChangedFilesSummary");
    expect(source).not.toContain("chat-diff-count-summary");
    expect(styles).not.toContain(".chat-diff-count-summary");
    // 气泡可见性回到直接用 hasDiffs（面板总是会渲染）。
    expect(source).toContain("!processRunning && (hasContent || hasImages || hasDiffs");
  });
});

describe("chat panel worktree workspace", () => {
  it("shows a fixed placeholder in an empty session on both desktop and mobile", () => {
    const desktop = readWorkspaceFile("src/components/layout/ChatPanel.tsx");
    const mobile = readWorkspaceFile("mobile/src/App.tsx");

    // 桌面：空会话显示固定文案，非空才渲染真实统计。
    expect(desktop).toContain('messages.length === 0 ? (');
    expect(desktop).toContain('className="chat-status-bar chat-status-bar-empty"');
    expect(desktop).toContain("暂无统计数据");
    // 手机：同样口径，selected 存在但无消息时显示占位。
    expect(mobile).toContain("selectedMessages.length === 0");
    expect(mobile).toContain('className="composer-status composer-status-empty"');
    expect(mobile).toContain("暂无统计数据");
  });

  it("routes file and diff paths through the active session workspace", () => {
    const source = readWorkspaceFile("src/components/layout/ChatPanel.tsx");
    const explorer = readWorkspaceFile("src/components/sidebar/FileExplorer.tsx");
    const composer = readWorkspaceFile("src/components/layout/ChatComposer.tsx");

    expect(source).toContain('const activeWorkspacePath = activeSession?.workspace?.rootPath || activeProject?.path || ""');
    expect(source).toContain("projectPath={activeWorkspacePath}");
    expect(source).toContain("<WorktreeControl");
    expect(explorer).toContain("const activeWorkspacePath = activeSession?.workspace?.rootPath || activeProject?.path || \"\"");
    expect(composer).toContain("const activeProjectPath = activeSession?.workspace?.rootPath || activeProject?.path || \"\"");
  });
});

describe("manual context compaction entry", () => {
  it("puts a compaction button in the context usage modal header for every agent", () => {
    const modal = readWorkspaceFile("src/components/layout/ContextUsageModal.tsx");
    const panel = readWorkspaceFile("src/components/layout/ChatPanel.tsx");
    const styles = readWorkspaceFile("src/components/layout/ContextUsageModal.css");

    // 按钮在「上下文用量」标题右侧，压缩中把文案就地换成「压缩中」。
    expect(modal).toContain("context-usage-compact");
    expect(modal).toContain("压缩中");
    expect(styles).toContain(".context-usage-compact");
    // 所有 Agent 都走同一条命令，不在前端按 agent 类型隐藏入口。
    expect(panel).toContain("handleCompactContext");
    expect(panel).toContain("onCompact={handleCompactContext}");
    expect(panel).toContain("window.electronAPI.agentCompactSession(activeSessionId)");
    expect(panel).not.toContain("supportsManualCompaction");
  });
});
