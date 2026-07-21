import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/components/sidebar/AgentSettingsView.tsx"), "utf8");

describe("Agent settings plugin and runtime actions", () => {
  it("keeps plugin removal visible while an SDK runtime is missing", () => {
    expect(source).toContain("{agent.removable && (");
    expect(source).not.toContain("{isInstalled && agent.removable && (");
    expect(source.indexOf("{agent.removable && (")).toBeLessThan(source.indexOf("{agentStatus && (isInstallAction"));
  });

  it("seeds newly installed SDK plugins with a runtime status before refreshing", () => {
    expect(source).toContain('installedAgent.runtime === "sdk"');
    expect(source).toContain("createPendingSDKStatus()");
    expect(source).toContain("await refreshAgentStatus(installedAgent.id)");
    expect(source).toContain("isChecking || isAnyAgentUpdating || !agentStatus.canUpdate");
  });
});
