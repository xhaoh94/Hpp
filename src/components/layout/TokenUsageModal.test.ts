import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const modalSource = readFileSync(resolve(process.cwd(), "src/components/layout/TokenUsageModal.tsx"), "utf8");
const modalStyles = readFileSync(resolve(process.cwd(), "src/components/layout/TokenUsageModal.css"), "utf8");
const chatPanelSource = readFileSync(resolve(process.cwd(), "src/components/layout/ChatPanel.tsx"), "utf8");
const chatPanelStyles = readFileSync(resolve(process.cwd(), "src/components/layout/ChatPanel.css"), "utf8");
const historyHookSource = readFileSync(resolve(process.cwd(), "src/hooks/useFullSessionMessages.ts"), "utf8");
const entrySource = readFileSync(resolve(process.cwd(), "src/components/layout/ChatTokenUsageItem.tsx"), "utf8");

describe("token usage modal", () => {
  it("shows input, output, cache, cache rate and the overall summary", () => {
    expect(modalSource).toContain("Token 统计");
    expect(modalSource).toContain("<span>输入</span>");
    expect(modalSource).toContain("<span>输出</span>");
    expect(modalSource).toContain("<span>缓存</span>");
    expect(modalSource).toContain("<span>缓存率</span>");
    expect(modalSource).toContain("formatContextTokenAmount");
    expect(modalSource).toContain("formatTokenCacheRate");
    expect(modalSource).toContain("累计 ");
  });

  it("lists one table by model id with the channel next to it", () => {
    // 只剩一张表，不再渲染分区标题。
    expect(modalSource).not.toContain("按模型 ID");
    expect(modalSource).not.toContain("token-usage-section-head");
    expect(modalSource).not.toContain("byChannel");
    // 汇总逻辑抽到 hook 里，弹窗和输入框下方的状态条共用
    expect(historyHookSource).toContain("summarizeTokenUsage");
    expect(modalSource).toContain("byModel");
    // 模型名下面要标出渠道。
    expect(modalSource).toContain("group.detail");
  });

  it("anchors the panel next to the header button and closes predictably", () => {
    expect(modalSource).toContain("useAnchoredOverlay(true, anchorRef, modalRef");
    expect(modalSource).toContain("anchorRef: RefObject<HTMLElement | null>");
    expect(modalSource).toContain("style={overlayStyle}");
    expect(modalSource).toContain('event.key === "Escape"');
    expect(modalSource).toContain("onMouseDown={onClose}");
    expect(modalStyles).toContain(".token-usage-overlay");
    expect(modalStyles).toContain(".token-usage-summary");
  });

  it("reads the full persisted history when only a page is loaded", () => {
    expect(historyHookSource).toContain("hasOlderSessionMessages(sessionId)");
    expect(historyHookSource).toContain("loadSessionMessages");
    expect(historyHookSource).toContain("parsePersistedChatMessage");
    expect(modalSource).toContain("已合并完整历史消息");
  });

  it("puts the token summary into the status bar under the composer", () => {
    expect(chatPanelSource).toContain("chat-status-bar");
    expect(chatPanelSource).toContain("<ChatTokenUsageItem");
    expect(chatPanelSource).toContain("<TokenUsageModal");
    // 入口自己订阅消息，避免整块 ChatPanel 跟着流式重渲染
    expect(entrySource).toContain("chat-header-token-usage");
    expect(entrySource).toContain("sessionMessages[sessionId]");
    expect(chatPanelStyles).toContain(".chat-header-token-usage");
    expect(chatPanelStyles).toContain(".chat-status-bar");
  });
});
