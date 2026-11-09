import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import inlineComposerSource from "./InlineComposerEditor.tsx?raw";
import messageFlowSource from "./ComposerMessageFlow.tsx?raw";
import pasteChipSource from "./ComposerPasteChip.tsx?raw";
import chatComposerSource from "../layout/ChatComposer.tsx?raw";
import sessionPayloadSource from "../../lib/session-message-payload.ts?raw";
import remoteCommandsSource from "../../lib/remote-session-commands.ts?raw";
import remoteProtocolSource from "../../../shared/remote-protocol.ts?raw";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/**
 * 这些断言锁住「粘贴块」的几处关键接线，避免后续重构悄悄把它们拿掉：
 * 折叠插件必须比「复制发言气泡」的拦截优先级低、发送载荷必须带全文、
 * 远程协议必须认识这个节点类型。
 */
describe("pasted-text chips", () => {
  it("folds large pastes at a lower priority than the copied-bubble restore", () => {
    const restoreIndex = inlineComposerSource.indexOf("ComposerClipboardPastePlugin");
    const foldIndex = inlineComposerSource.indexOf("ComposerLargeTextPastePlugin");
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(foldIndex).toBeGreaterThan(-1);
    // 「复制气泡」用 CRITICAL 拦截，粘贴折叠用 NORMAL：前者必须先手。
    expect(inlineComposerSource).toContain("COMMAND_PRIORITY_CRITICAL,");
    expect(inlineComposerSource).toContain("COMMAND_PRIORITY_NORMAL,");
    expect(inlineComposerSource).toContain("shouldFoldPastedText(text)");
    expect(inlineComposerSource).toContain("isPastedTextTooLarge(text)");
  });

  it("renders the chip in both the composer and the message bubble", () => {
    expect(inlineComposerSource).toContain("ComposerPasteChip");
    expect(messageFlowSource).toContain('<ComposerPasteChip key={node.id} text={node.text} variant="message" />');
  });

  it("floats the preview in a portal so the input/virtual list cannot clip it", () => {
    expect(pasteChipSource).toContain("createPortal(");
    expect(pasteChipSource).toContain("document.body");
    // 悬停展开 + 点击展开都要有（触屏没有 hover）。
    expect(pasteChipSource).toContain("onPointerEnter={scheduleOpen}");
    expect(pasteChipSource).toContain("onClick={() => (open ? closeCard() : openCard())}");
  });

  it("keeps the preview open while the user scrolls inside it", () => {
    // 回归：曾经把 capture 阶段的 scroll 一律当成「外部滚动」直接关闭，
    // 导致浮层里的长文本根本滚不动。
    expect(pasteChipSource).toContain('window.addEventListener("scroll", handleScroll, true)');
    expect(pasteChipSource).toContain("cardRef.current?.contains(target)");
    expect(pasteChipSource).toContain("if (!updatePosition()) closeCard();");
  });

  it("offers copy / save-as-txt from the preview and hides save off Electron", () => {
    expect(pasteChipSource).toContain("navigator.clipboard.writeText(text)");
    expect(pasteChipSource).toContain("window.electronAPI?.saveTextFile");
  });

  it("keeps the full pasted text in the send payload but labels in the display content", () => {
    const pasteBranch = sessionPayloadSource.indexOf('if (node.type === "paste")');
    const snippetFallback = sessionPayloadSource.indexOf("files.push({");
    expect(pasteBranch).toBeGreaterThan(-1);
    expect(snippetFallback).toBeGreaterThan(-1);
    // 粘贴块必须在 snippet 兜底之前处理，否则会被拼成畸形的 <file> 载荷。
    expect(pasteBranch).toBeLessThan(snippetFallback);
    expect(sessionPayloadSource).toContain("sendParts.push(node.text)");
    expect(sessionPayloadSource).toContain("getComposerFullText(document)");
  });

  it("keeps the composer's send button lit when only a paste is present", () => {
    expect(chatComposerSource).toContain("documentHasContent: composerDocumentHasContent(composerDocument)");
    expect(chatComposerSource).toContain("onPasteBlocked={onPasteBlocked}");
  });

  it("lets the remote protocol and its sanitizer carry paste nodes", () => {
    expect(remoteProtocolSource).toContain('z.literal("paste")');
    expect(remoteCommandsSource).toContain('if (node.type === "paste")');
  });

  it("keeps the chip styles available for both desktop and mobile shells", () => {
    const chipStyles = readWorkspaceFile("src/components/shared/ComposerPasteChip.css");
    // 颜色变量必须带移动端兜底，否则移动端 webview 里会掉成透明底。
    expect(chipStyles).toContain("var(--border-color, var(--border");
    expect(chipStyles).toContain(".composer-paste-card");
    expect(chipStyles).toContain(".inline-composer-paste.selected");
    // 气泡里的标签必须自己定尺寸（不能用输入框芯片的 26px 把单行气泡抬高）。
    // 具体数值由设计决定，这里只锁「结构」：高度自适应 + 三个尺寸属性存在。
    const messageVariant = chipStyles.slice(chipStyles.indexOf(".composer-paste-chip.message {"));
    expect(messageVariant).toContain("height: auto");
    expect(messageVariant).toMatch(/\bpadding:\s/);
    expect(messageVariant).toMatch(/\bfont-size:\s/);
    expect(messageVariant).toMatch(/\bborder-radius:\s/);
    // 边框/底色保持中性（不蹭附件的 accent 色），只对齐尺寸与垂直对齐。
    expect(messageVariant).not.toContain("color-mix(");
    const mobileStyles = readWorkspaceFile("mobile/src/styles.css");
    expect(mobileStyles).toContain(".composer-paste-chip");
  });
});
