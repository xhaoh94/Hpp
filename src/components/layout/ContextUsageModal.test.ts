import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const modalSource = readFileSync(resolve(process.cwd(), "src/components/layout/ContextUsageModal.tsx"), "utf8");
const modalStyles = readFileSync(resolve(process.cwd(), "src/components/layout/ContextUsageModal.css"), "utf8");

describe("context usage modal", () => {
  it("shows the used ratio, total window and per-category breakdown", () => {
    expect(modalSource).toContain('className="context-usage-summary"');
    expect(modalSource).toContain("已使用 ");
    expect(modalSource).toContain("formatContextTokenAmount");
    // 分段进度条与分类列表：每段颜色与列表色点一一对应。
    expect(modalSource).toContain('className="context-usage-bar-segment"');
    expect(modalSource).toContain('className="context-usage-list"');
    expect(modalSource).toContain('className="context-usage-dot"');
    // 拿不到分类明细的后端要如实说明，而不是显示空列表。
    expect(modalSource).toContain("当前 Agent 未提供上下文构成明细");
  });

  it("anchors the panel next to the header ring instead of the window corner", () => {
    expect(modalSource).toContain("useAnchoredOverlay(true, anchorRef, modalRef");
    expect(modalSource).toContain("anchorRef: RefObject<HTMLElement | null>");
    expect(modalSource).toContain("style={overlayStyle}");
    // 弹窗自身用 fixed + 内联坐标，不能再用 overlay 的 flex 贴左上角。
    expect(modalStyles).not.toContain("justify-content: flex-start");
  });

  it("closes on escape and uses a themed overlay", () => {
    expect(modalSource).toContain('event.key === "Escape"');
    expect(modalSource).toContain("onMouseDown={onClose}");
    expect(modalStyles).toContain(".context-usage-overlay");
    expect(modalStyles).toContain(".context-usage-bar-segment");
    expect(modalStyles).toContain(".context-usage-dot");
  });
});
