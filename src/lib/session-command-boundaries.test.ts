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

  it("lets the coordinator decide whether a remote send should be queued", () => {
    const sendCommand = remoteCommandsSource.slice(
      remoteCommandsSource.indexOf("async function sendRemoteMessage"),
      remoteCommandsSource.indexOf("async function setRemoteModel"),
    );
    expect(sendCommand).not.toContain("initializeSession");
  });

  it("does not initialize or reconfigure a session before a remote abort", () => {
    const abortCase = remoteCommandsSource.slice(
      remoteCommandsSource.indexOf('case "session.abort"'),
      remoteCommandsSource.indexOf('case "session.reload"'),
    );
    expect(abortCase).not.toContain("initializeSession");
  });
});
