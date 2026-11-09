import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import chatPanelSource from "../layout/ChatPanel.tsx?raw";
import messageFlowSource from "./ComposerMessageFlow.tsx?raw";
import mobileAppSource from "../../../mobile/src/App.tsx?raw";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/**
 * 用户发言里的短代码要显示成代码块，但普通文本必须继续按纯文本渲染
 * （用户消息刻意不走 Markdown）。这些断言锁住两条接线：
 * 渲染入口统一走 UserMessageText，折叠逻辑不再截断代码消息。
 */
describe("user message code blocks", () => {
  it("renders user text through the shared component in the desktop bubble", () => {
    expect(chatPanelSource).toContain("<UserMessageText");
    expect(chatPanelSource).toContain("plan={userMessageCodePlan ?? undefined}");
  });

  it("does not let the ten-line collapse cut a code message in half", () => {
    expect(chatPanelSource).toContain("const userMessageIsCode = userMessageCodePlan?.kind === \"segments\"");
    expect(chatPanelSource).toContain("const userMessageIsLong = !userMessageIsCode && userMessageLines.length > COLLAPSED_USER_MESSAGE_LINES");
  });

  it("only auto-detects code when the whole message is a single text node", () => {
    expect(messageFlowSource).toContain("const singleTextMessage = document.nodes.length === 1 && document.nodes[0].type === \"text\"");
    expect(messageFlowSource).toContain("planUserMessageCode(node.text, { autoDetect: singleTextMessage })");
    expect(messageFlowSource).toContain("<UserMessageText");
  });

  it("keeps the mobile bubble on the same component instead of raw <p>", () => {
    expect(mobileAppSource).toContain("<UserMessageText");
    expect(mobileAppSource).toContain('textClassName="message-content-text"');
  });

  it("re-indents pasted code before rendering it", () => {
    const source = readWorkspaceFile("src/components/shared/UserCodeBlock.tsx");
    expect(source).toContain("formatCodeForDisplay(code, language)");
  });

  it("ships the code-block styles for both shells", () => {
    const codeStyles = readWorkspaceFile("src/components/shared/UserCodeBlock.css");
    expect(codeStyles).toContain(".chat-user-code-block .md-code-scroll-wrapper");
    expect(codeStyles).toContain(".composer-message-flow.has-code");
    // 桌面气泡容器里的现有字号/行高不能被代码块继承。
    const chatPanelStyles = readWorkspaceFile("src/components/layout/ChatPanel.css");
    expect(chatPanelStyles).toContain(".chat-user-message-flow");
    const mobileStyles = readWorkspaceFile("mobile/src/styles.css");
    expect(mobileStyles).toContain(".message-content > .chat-user-code-flow");
  });
});
