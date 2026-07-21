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
});
