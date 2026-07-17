import { describe, expect, it } from "vitest";
import chatPanelSource from "@/components/layout/ChatPanel.tsx?raw";
import projectCardSource from "@/components/sidebar/ProjectCard.tsx?raw";
import remoteCommandsSource from "@/lib/remote-session-commands.ts?raw";

const forbiddenAgentCommands = /window\.electronAPI\.agent(?:CreateSession|SwitchSession|RemoveSession|SendMessage|SendGuidance|ForkSession|SetModel|SetThinkingLevel|ReloadConfig)\b/;

describe("session command ownership", () => {
  it.each([
    ["ChatPanel", chatPanelSource],
    ["ProjectCard", projectCardSource],
    ["Remote Bridge", remoteCommandsSource],
  ])("keeps Agent command IPC out of %s", (_name, source) => {
    expect(source).not.toMatch(forbiddenAgentCommands);
  });
});
