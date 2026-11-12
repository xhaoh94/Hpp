import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("desktop general settings layout", () => {
  it("keeps shortcut and filter entry points inside general settings", () => {
    const source = readWorkspaceFile("src/components/sidebar/SettingsView.tsx");
    const quickActions = source.slice(
      source.indexOf('<div className="settings-quick-buttons">'),
      source.indexOf("{ showShortcutModal"),
    );
    const generalSettings = source.slice(source.indexOf("{ showGeneralModal"));

    expect(quickActions).toContain("Agent");
    expect(source).not.toContain("Agent 设置");
    expect(quickActions).toContain("远程访问");
    expect(quickActions).toContain("通用设置");
    expect(quickActions).not.toContain("快速操作");
    expect(quickActions).not.toContain("快捷键设置");
    expect(quickActions).not.toContain("过滤规则");
    expect(generalSettings).toContain("openShortcutSettings");
    expect(generalSettings).toContain("openFilterSettings");
    expect(generalSettings).not.toContain("上下文压缩");
    expect(generalSettings).toContain("编辑与文件");
    expect(generalSettings).toContain("图片与缓存");
    expect(generalSettings).toContain("存储");
    expect(generalSettings).toContain('aria-controls="general-settings-storage"');
    expect(source).toContain("getDiskUsage");
    expect(source).toContain("cleanupDiskCache");
    expect(generalSettings).toContain("清理无用数据");
    expect(generalSettings).toContain("settings-storage-list");
    expect(generalSettings).toContain('expandedGeneralSection === "appearance"');
    expect(generalSettings).toContain('aria-controls="general-settings-editing"');
    expect(generalSettings).toContain("settings-general-collapse-icon");
    expect(source).toContain('useState<GeneralSectionId | null>("appearance")');
    expect(source).toContain('setExpandedGeneralSection("appearance")');
    expect(source).toContain("onClick={openGeneralSettings}");
    expect(source).toContain("current === section ? null : section");
    expect(source).toContain("切换消息");
    expect(source).toContain('["previousMessage", "nextMessage"]');
    expect(source).toContain("SHORTCUTS_UPDATED_EVENT");
    const styles = readWorkspaceFile("src/components/sidebar/Settings.css");
    expect(styles).toContain("grid-template-columns: repeat(3, minmax(108px, 138px))");
  });

  it("offers an output detail level picker defaulting to detailed", () => {
    const source = readWorkspaceFile("src/components/sidebar/SettingsView.tsx");

    // 三档等级全部来自共享定义，避免 UI 与渲染层各写一套。
    expect(source).toContain("@shared/output-detail");
    expect(source).toContain("OUTPUT_DETAIL_LEVELS.map((level)");
    expect(source).toContain("updateOutputDetailLevel");
    expect(source).toContain("outputDetailLevel: normalized");
    expect(source).toContain('aria-label="输出内容详细等级"');
    expect(source).toContain("输出内容");
    // 默认「详细」。
    expect(source).toContain("useState<OutputDetailLevel>(DEFAULT_OUTPUT_DETAIL_LEVEL)");
    expect(source).toContain("outputDetailLevel: normalizeOutputDetailLevel(general.outputDetailLevel)");
    // 改动后必须广播事件，聊天面板才会立即重渲染。
    expect(source).toContain("detail: { outputDetailLevel: normalized }");

    const shared = readWorkspaceFile("shared/output-detail.ts");
    expect(shared).toContain('export type OutputDetailLevel = "concise" | "standard" | "detailed"');
    expect(shared).toContain('DEFAULT_OUTPUT_DETAIL_LEVEL: OutputDetailLevel = "detailed"');
    expect(shared).toContain("concise: \"思考与正文各自合并成一段，保留引导、问卷、子任务与变更\"");

    // 「输出内容」不再是独立分区，而是「应用行为」里的一行分段按钮。
    expect(source).not.toContain('expandedGeneralSection === "output"');
    expect(source).toContain('className="settings-segmented"');
    const styles = readWorkspaceFile("src/components/sidebar/Settings.css");
    expect(styles).toContain(".settings-segmented {");
    expect(styles).toContain(".settings-segmented-option.selected");
  });

  it("keeps the default workspace path out of general settings", () => {
    const source = readWorkspaceFile("src/components/sidebar/SettingsView.tsx");

    // 工作区目录只在项目卡片上改。设置页再放一份输入框就会造出第二个真源，
    // 保存其它通用设置时用旧值覆盖回去（历史上踩过）。
    expect(source).not.toContain("defaultWorkspacePath");
    expect(source).not.toContain("general-settings-workspace");
  });

  it("applies the output detail level to process rendering", () => {
    const panel = readWorkspaceFile("src/components/layout/ChatPanel.tsx");
    expect(panel).toContain('normalizeOutputDetailLevel(general.outputDetailLevel)');
    expect(panel).toContain("outputDetailLevel={outputDetailLevel}");
    // diff 面板属于“改了什么”的内容：任何等级都与详细档一样完整显示。
    expect(panel).toContain("const showDiffBlock = hasDiffs;");

    const block = readWorkspaceFile("src/components/layout/ProcessBlock.tsx");
    // 简洁：思考与正文各自合并；标准：按段合并——思考合成一块、命令/查看/修改合成一块。
    expect(block).toContain("if (outputDetailLevel === \"concise\") return getConciseProcessEntries(visibleEntries);");
    // 标准档默认收起；点击后展开原始操作条目。
    expect(block).toContain('if (outputDetailLevel === "standard") return collapseStandardProcessEntries(visibleEntries);');
    expect(block).toContain("operationSummary");
    expect(block).toContain("onToggleOperationSummary={toggleOperationSummary}");
    expect(block).toContain('entry.type === "thinking"');
    expect(block).toContain("shouldListChangedFiles(outputDetailLevel)");
    expect(block).not.toContain("chat-process-change-summary");
    // 底部 Todo 胶圈是浮层状态提示，不属于「处理过程条目」：三个等级都显示变更统计。
    expect(panel).not.toContain("showChangeSummary");
    expect(panel).toContain("{changeSummary && changeSummary.filesChanged > 0 && (");
  });

  it("no longer exposes a context-compaction entry in channel configuration", () => {
    const configModal = readWorkspaceFile("src/components/sidebar/AgentConfigModal.tsx");

    // 压缩一律走 Agent 自己的默认策略（启用、低思考等级），不再给用户配置入口。
    expect(configModal).not.toContain("上下文压缩");
    expect(configModal).not.toContain("AgentCompactionModal");
    expect(configModal).not.toContain("compactionModalOpen");
  });

  // 选择器通用 .input-field 规则在文件末尾、同为 0,2,0；搜索框的 padding-left
  // 必须多一层选择器才压得住，否则搜索图标会和占位文字重叠。
  it("模型选择弹窗的搜索框给图标留出内边距", () => {
    const styles = readWorkspaceFile("src/components/sidebar/Settings.css");
    expect(styles).toContain(".agent-model-picker-modal .agent-model-picker-search .input-field {");
    expect(styles).toContain("padding-left: 32px;");
  });

  it("hot-updates SubAgent settings before falling back to session reload", () => {
    const subagentModal = readWorkspaceFile("src/components/sidebar/AgentSubagentModal.tsx");
    expect(subagentModal).toContain("agentSetAgentSubagentConfig");
    expect(subagentModal).toContain("enablingFromDisabled");
    expect(subagentModal).toContain("agentReloadConfig");
    // 关闭时若还没保存，同样要自动应用而不是静默丢弃。
    expect(subagentModal).toContain("requestCloseRef");
    expect(subagentModal).toContain("if (dirtyRef.current && !(await saveRef.current())) return;");

    const preload = readWorkspaceFile("electron/preload.ts");
    expect(preload).toContain('ipcRenderer.invoke("agent:setAgentSubagentConfig", agentId, config)');

    const manager = readWorkspaceFile("electron/agents/agent-manager.ts");
    expect(manager).toContain('ipcMain.handle("agent:setAgentSubagentConfig"');
    expect(manager).toContain("setAgentSubagentConfig");

    // 运行中的 Pi worker 必须通过 getter 读取 SubAgent 配置，否则热更新
    // 只会改到内存里的死配置，下一次 subagent 调用仍用旧模型。
    const worker = readWorkspaceFile("electron/plugin-backends/pi/worker.mjs");
    expect(worker).toContain('case "setSubagentConfig"');
    expect(worker).toContain("getSubagentConfig: () => activeSubagentConfig");
  });
});

describe("remote bridge output detail level propagation", () => {
  const bridgeSource = readWorkspaceFile("src/hooks/useRemoteBridge.ts");

  it("includes the level in every session config it publishes", () => {
    expect(bridgeSource).toContain("outputDetailLevel: OutputDetailLevel = DEFAULT_OUTPUT_DETAIL_LEVEL");
    expect(bridgeSource).toContain("outputDetailLevel,");
    // 所有发布路径都必须带上等级，否则部分会话会回落成「详细」。
    expect(bridgeSource).toContain("buildSessionConfig(session.id, planModeEnabled, permissionMode, outputDetailLevel)");
    expect(bridgeSource).toContain("buildSessionConfig(session.id, planModeRef.current, permissionModeRef.current, outputDetailLevelRef.current)");
    expect(bridgeSource).toContain("buildSessionConfig(sessionId, planModeRef.current, permissionModeRef.current, outputDetailLevelRef.current)");
    expect(bridgeSource).toContain("buildSessionConfig(state.activeSessionId, planModeRef.current, permissionModeRef.current, outputDetailLevelRef.current)");
  });

  it("republishes configs immediately when the level changes on the desktop", () => {
    // 事件名收在 @/lib/app-events，避免三处硬编码漂移。
    expect(bridgeSource).toContain("window.addEventListener(GENERAL_SETTINGS_UPDATED_EVENT, onGeneralSettings)");
    expect(bridgeSource).toContain("window.removeEventListener(GENERAL_SETTINGS_UPDATED_EVENT, onGeneralSettings)");
    expect(bridgeSource).toContain("outputDetailLevelRef.current = normalizeOutputDetailLevel(general.outputDetailLevel)");
    expect(bridgeSource).toContain("if (nextLevel === outputDetailLevelRef.current) return;");
    // 事件先到、loadData 后到时不能用旧值覆盖。
    expect(bridgeSource).toContain("if (cancelled || overriddenByEvent) return;");
  });

  it("carries the level over the wire in the shared protocol type", () => {
    const protocol = readWorkspaceFile("shared/remote-protocol.ts");
    expect(protocol).toContain("outputDetailLevel?: OutputDetailLevel;");
    expect(protocol).toContain('import type { OutputDetailLevel } from "./output-detail";');

    const commands = readWorkspaceFile("src/lib/remote-session-commands.ts");
    expect(commands).toContain("normalizeOutputDetailLevel(settings?.general?.outputDetailLevel)");
  });
});
