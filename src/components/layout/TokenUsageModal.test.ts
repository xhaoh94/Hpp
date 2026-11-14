import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const modalSource = readFileSync(resolve(process.cwd(), "src/components/layout/TokenUsageModal.tsx"), "utf8");
const modalStyles = readFileSync(resolve(process.cwd(), "src/components/layout/TokenUsageModal.css"), "utf8");
const chatPanelSource = readFileSync(resolve(process.cwd(), "src/components/layout/ChatPanel.tsx"), "utf8");
const chatPanelStyles = readFileSync(resolve(process.cwd(), "src/components/layout/ChatPanel.css"), "utf8");

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

  it("breaks the totals down by channel and by model id", () => {
    expect(modalSource).toContain('title="按渠道"');
    expect(modalSource).toContain('title="按模型 ID"');
    expect(modalSource).toContain("summarizeTokenUsage");
    expect(modalSource).toContain("byChannel");
    expect(modalSource).toContain("byModel");
    // 旧消息没有记录渠道/模型 ID 时要如实标注，而不是伪造分组。
    expect(modalSource).toContain("旧消息未记录渠道时归入");
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
    expect(modalSource).toContain("hasOlderSessionMessages(sessionId)");
    expect(modalSource).toContain("loadSessionMessages");
    expect(modalSource).toContain("parsePersistedChatMessage");
    expect(modalSource).toContain("已合并完整历史消息");
  });

  it("places the entry in the session header next to the context ring", () => {
    expect(chatPanelSource).toContain("chat-header-token-usage");
    expect(chatPanelSource).toContain("title=\"Token 统计（输入 / 输出 / 缓存）\"");
    expect(chatPanelSource).toContain("<TokenUsageModal");
    expect(chatPanelStyles).toContain(".chat-header-token-usage");
  });
});
