import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("desktop general settings layout", () => {
  it("keeps shortcut and filter entry points inside general settings", () => {
    const source = readWorkspaceFile("src/components/sidebar/SettingsView.tsx");
    const quickActions = source.slice(
      source.indexOf('<div className="settings-quick-buttons">'),
      source.indexOf("{showShortcutModal"),
    );
    const generalSettings = source.slice(source.indexOf("{showGeneralModal"));

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

  it("moves Agent compaction into plugin-capability-driven channel configuration", () => {
    const configModal = readWorkspaceFile("src/components/sidebar/AgentConfigModal.tsx");
    const compactionModal = readWorkspaceFile("src/components/sidebar/AgentCompactionModal.tsx");
    const buttonIndex = configModal.indexOf("上下文压缩");
    const reloadIndex = configModal.indexOf("重新载入当前配置");

    expect(buttonIndex).toBeGreaterThan(-1);
    expect(buttonIndex).toBeLessThan(reloadIndex);
    expect(configModal).toContain('activeAgent?.capabilities.compaction');
    expect(configModal).toContain('compactionCapabilities !== "none"');
    expect(configModal).not.toContain('agentId === "pi"');
    expect(compactionModal).toContain("压缩思考等级");
    expect(compactionModal).toContain("当前 Agent 模型");
    expect(compactionModal).toContain("自定义模型");
    expect(compactionModal).toContain("Base URL");
    expect(compactionModal).toContain("模型 ID");
    expect(compactionModal).toContain("agentCompactionByAgent");
    expect(compactionModal).toContain("agentSetAgentCompactionConfig");
    expect(compactionModal).toContain('typeof applyConfig !== "function"');
    expect(compactionModal).toContain("完全退出并重启 Hpp 后将应用到该 Agent");

    const preload = readWorkspaceFile("electron/preload.ts");
    expect(preload).toContain("agentSetAgentCompactionConfig");
    expect(preload).toContain('ipcRenderer.invoke("agent:setAgentCompactionConfig", agentId, config)');

    const styles = readWorkspaceFile("src/components/sidebar/Settings.css");
    expect(styles).toContain(".settings-compaction-custom-model");
    expect(styles).toContain(".agent-compaction-modal-overlay");
    expect(styles).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  });
});
