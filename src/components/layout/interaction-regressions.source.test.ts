import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import chatComposerSource from "./ChatComposer.tsx?raw";
import chatPanelSource from "./ChatPanel.tsx?raw";
import fileSearchSource from "../shared/FileSearch.tsx?raw";
import fileMentionPickerSource from "./ComposerFileMentionPicker.tsx?raw";
import questionnaireSource from "./QuestionnairePanel.tsx?raw";
import agentEventsSource from "./useAgentEvents.ts?raw";

const chatPanelStyles = readFileSync(
  resolve(process.cwd(), "src/components/layout/ChatPanel.css"),
  "utf8",
);
const fileSearchStyles = readFileSync(
  resolve(process.cwd(), "src/components/shared/FileSearch.css"),
  "utf8",
);

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

  it("allows @ mentions to attach files and folders", () => {
    expect(chatComposerSource).not.toContain("includeDirectories: false");
    expect(chatComposerSource).toContain('kind: item.isDirectory ? "folder" : "file"');
    expect(fileMentionPickerSource).toContain("item.isDirectory");
    expect(fileMentionPickerSource).toContain("<Folder");
    expect(fileMentionPickerSource).toContain('aria-label="选择要引用的文件或文件夹"');
  });

  it("keeps mention icons unchanged when an item is selected", () => {
    expect(chatPanelStyles).toContain(".chat-file-mention-item.folder > svg");
    expect(chatPanelStyles).not.toContain(".chat-file-mention-item.selected > svg");
  });

  it("coalesces file searches and keeps result versions attached to their rows", () => {
    expect(chatComposerSource).toContain("scheduleAbortableTask");
    expect(chatComposerSource).toContain("FILE_MENTION_SEARCH_DEBOUNCE_MS = 100");
    expect(chatComposerSource).toContain("fileMentionResultState.query !== fileMention.query");
    expect(fileSearchSource).toContain("scheduleAbortableTask");
    expect(fileSearchSource).toContain("FILE_SEARCH_DEBOUNCE_MS = 100");
    expect(fileSearchSource).toContain("resultState.query !== query");
    expect(fileSearchSource).toContain('searchError ? "无法读取项目内容"');
    expect(fileSearchSource).toContain('<Folder className="fs-item-icon folder" size={15} strokeWidth={1.8}');
    expect(fileSearchSource).toContain('<FileText className="fs-item-icon" size={15} strokeWidth={1.8}');
    expect(fileSearchStyles).toContain(".fs-item-icon.folder");
    expect(fileSearchStyles).toContain("color: #DCAB5F");
  });

  it("does not subscribe the full chat panel to draft text keystrokes", () => {
    expect(chatPanelSource).toContain("pendingPathAttachments: draft.pendingPathAttachments");
    expect(chatPanelSource).toContain("useChatStore.getState().sessionDrafts[activeSessionId]?.text");
  });
});
