import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ioSource = readFileSync(resolve(process.cwd(), "src/components/sidebar/AgentConfigIO.tsx"), "utf8");
const settingsStyles = readFileSync(resolve(process.cwd(), "src/components/sidebar/Settings.css"), "utf8");

describe("Agent config import/export dialog", () => {
  it("notifies the host and shows a result toast after an import", () => {
    expect(ioSource).toContain("onImported?: (agentIds: string[]) => void;");
    // 导入写盘后必须回调宿主刷新渠道列表与模型目录，并给出可见提示。
    expect(ioSource).toContain("if (imported > 0) onImported?.(importedAgents);");
    expect(ioSource).toContain("const summary = formatAgentConfigImportSummary({");
    expect(ioSource).toContain("showFloatingToastMessage(summary);");
    // 成功导入后关闭弹窗并清掉冲突决策，避免下次导入沿用上一轮选择。
    expect(ioSource).toContain("setImportDecisions({});");
  });

  it("keeps the channel list scrollable inside the fixed-height dialog", () => {
    expect(settingsStyles).toContain("height: min(78vh, 680px);");
    expect(settingsStyles).toContain(".agent-config-io-scroll > * {");
    const scrollChildrenRule = settingsStyles.slice(
      settingsStyles.indexOf(".agent-config-io-scroll > * {"),
      settingsStyles.indexOf("}", settingsStyles.indexOf(".agent-config-io-scroll > * {")),
    );
    // 滚动容器是 flex 列：子项若可收缩，展开的渠道行会被压扁并被卡片 overflow 裁掉。
    expect(scrollChildrenRule).toContain("flex: 0 0 auto;");
    const scrollRule = settingsStyles.slice(
      settingsStyles.indexOf(".agent-config-io-scroll {"),
      settingsStyles.indexOf("}", settingsStyles.indexOf(".agent-config-io-scroll {")),
    );
    expect(scrollRule).toContain("flex: 1 1 auto;");
    expect(scrollRule).not.toContain("min(54vh, 460px)");
  });
});
