import { describe, expect, it } from "vitest";
import chatPanelSource from "./ChatPanel.tsx?raw";
import questionnaireSource from "./QuestionnairePanel.tsx?raw";
import agentEventsSource from "./useAgentEvents.ts?raw";

describe("chat interaction regression constraints", () => {
  it("clears questionnaire options and custom text in both directions", () => {
    expect(questionnaireSource).toContain('setCustomText((current) => ({ ...current, [questionIndex]: "" }))');
    expect(questionnaireSource).toContain('setSingleChoice((current) => ({ ...current, [questionIndex]: "" }))');
    expect(questionnaireSource).toContain('setMultiChoice((current) => ({ ...current, [questionIndex]: [] }))');
  });

  it("settles renderer state when an abort request throws", () => {
    const failureBranch = agentEventsSource.slice(agentEventsSource.indexOf("} catch (error) {"));
    expect(failureBranch).toContain("finishManualAbort(sessionId)");
  });

  it("shows message copy feedback", () => {
    expect(chatPanelSource).toContain('showFloatingToastMessage("已复制")');
    expect(chatPanelSource).toContain("copyMessageText(msg.content)");
  });
});
