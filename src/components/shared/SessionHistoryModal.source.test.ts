import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("desktop session deletion affordances", () => {
  it("distinguishes closing a session from permanently deleting its stored data", () => {
    const modalSource = readWorkspaceFile("src/components/shared/SessionHistoryModal.tsx");
    const projectSource = readWorkspaceFile("src/components/sidebar/ProjectCard.tsx");
    const settingsSource = readWorkspaceFile("src/components/sidebar/SettingsView.tsx");
    const cleanupDialogSource = settingsSource.slice(
      settingsSource.indexOf("const cleanupDiskUsage"),
      settingsSource.indexOf("const storageOpen"),
    );

    expect(modalSource).toContain("彻底删除全部");
    expect(modalSource).toContain("会话、消息与草稿快照会从本机删除");
    expect(modalSource).toContain("await onDeleteAll()");
    expect(projectSource).toContain("关闭并移到历史会话");
    expect(projectSource).toContain("await purgeDeletedSessionData(uniqueSessionIds)");
    expect(cleanupDialogSource).toContain("其中 ${closedSessionCount} 个在历史中");
    expect(cleanupDialogSource).toContain("删除会话只会减少“会话与快照”");
    expect(cleanupDialogSource).toContain("浏览器缓存会在使用或重启后重新生成");
    expect(settingsSource).not.toContain("settings-storage-session-count");
    expect(settingsSource).not.toContain("settings-storage-hint");
    expect(settingsSource).toContain("DISK_USAGE_INVALIDATED_EVENT");
  });
});
