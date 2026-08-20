import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfigState, AgentProviderConfig } from "@/types";
import { resolvePreferredProviderId } from "./AgentConfigModal";

const modalSource = readFileSync(resolve(process.cwd(), "src/components/sidebar/AgentConfigModal.tsx"), "utf8");

const provider = (providerId: string): AgentProviderConfig => ({
  providerId,
  displayName: providerId,
  baseUrl: `https://${providerId}.example/v1`,
  apiKey: "key",
  endpoint: "responses",
  models: [{ id: `${providerId}-model`, name: providerId, reasoning: true, imageInput: false }],
});

describe("AgentConfigModal provider selection", () => {
  const state: AgentConfigState = {
    activeProviderId: "ylk",
    providers: [provider("ylk"), provider("wanzi"), provider("pixel")],
  };

  it("selects the current model provider before the active or first provider", () => {
    expect(resolvePreferredProviderId(state, "pixel")).toBe("pixel");
  });

  it("falls back to the active provider and then the first provider", () => {
    expect(resolvePreferredProviderId(state, "missing")).toBe("ylk");
    expect(resolvePreferredProviderId({ providers: state.providers }, "missing")).toBe("ylk");
  });

  it("uses a dedicated drag handle and preserves the source across Electron drag/drop timing", () => {
    expect(modalSource).toContain('className="agent-config-provider-drag"');
    expect(modalSource).toContain('className={`agent-config-provider-item ${selected ? "selected" : ""} ${active ? "active" : ""} ${dragging ? "dragging" : ""} ${dropTarget ? `drop-target ${dragOverProviderPosition}` : ""} ${reordering ? "reordering" : ""}`}');
    expect(modalSource).toContain('draggable={config.providers.length > 1 && !reorderingProviderId}');
    expect(modalSource).toContain("const dragProviderIdRef = useRef(\"\")");
    expect(modalSource).toContain("const sourceProviderId = event.dataTransfer.getData(\"text/plain\")");
    expect(modalSource).toContain("|| dragProviderIdRef.current");
    expect(modalSource).toContain("const commitProviderReorder = useCallback");
    expect(modalSource).toContain("某些 Electron 场景只派发 dragend，不派发 drop");
    expect(modalSource).toContain("if (sourceProviderId && targetProviderId && !dragReorderCommittedRef.current)");
    expect(modalSource).toContain("if (!result.config) {");
    expect(modalSource).toContain("渠道顺序已保存，但");
    expect(modalSource).toContain("event.preventDefault();");
    expect(modalSource).toContain('event.dataTransfer.dropEffect = "move"');
  });
});
