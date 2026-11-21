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
    expect(modalSource).toContain("context-usage-empty");
    expect(modalSource).toContain("无明细");
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

  it("states the usage precision instead of a single estimate flag", () => {
    expect(modalSource).toContain("SOURCE_NOTES[usage.source]");
    // 后端上报值与完成独立测量的精确值不是一回事，文案要分开说。
    expect(modalSource).toContain("后端上报");
    expect(modalSource).toContain("精确统计");
    // 只认 usage.estimated 会把官方上报值也当成"只是估算"，所以按来源逐条说清。
    expect(modalSource).not.toContain("usage.estimated");
    // 没有窗口时才说明「模型未提供」；模型目录里有窗口（fallback）就不该冒充缺失。
    expect(modalSource).toContain('{!contextWindow ? " · 窗口未知" : ""}');
  });

  it("falls back to the model catalog window before any usage event arrives", () => {
    expect(modalSource).toContain("fallbackContextWindow?: number");
    expect(modalSource).toContain("const contextWindow = usage?.contextWindow ?? fallbackContextWindow;");
    // 没有用量时不要用破折号堆成「全是横杠」，改用文字空态。
    expect(modalSource).not.toContain('usageRatio === undefined ? "—"');
    expect(modalSource).toContain("暂无用量");
    expect(modalSource).toContain("上下文窗口 ");
    // 调用侧传模型目录里的窗口，新会话也能看到总量。
    const panel = readFileSync(resolve(process.cwd(), "src/components/layout/ChatPanel.tsx"), "utf8");
    expect(panel).toContain("fallbackContextWindow={currentModel?.contextWindow}");
  });

  it("stores the threshold per channel and model instead of globally", () => {
    expect(modalSource).toContain("model?: { provider: string; id: string } | null");
    // 当前选择优先，用量事件里的模型兜底（模型目录还没回来时也能确定作用域）。
    expect(modalSource).toContain("const thresholdModel = model ?? usage?.model ?? null;");
    expect(modalSource).toContain("loadContextCompactionThreshold(thresholdModel)");
    expect(modalSource).toContain("saveContextCompactionThreshold(thresholdModel, normalized, { sessionId })");
    // 切换模型要重新读阈值，不能沿用上一个模型的值。
    expect(modalSource).toContain("[thresholdModel?.provider, thresholdModel?.id]");
    // 模型未确定时没有保存作用域：拖动直接禁用，避免“拖了又变回去”。
    expect(modalSource).toContain("const thresholdEditable = !!thresholdModel?.provider && !!thresholdModel?.id;");
    expect(modalSource).toContain("if (!thresholdEditable) return;");
    expect(modalSource).toContain("上下文上限 · 约 ");

    const panel = readFileSync(resolve(process.cwd(), "src/components/layout/ChatPanel.tsx"), "utf8");
    expect(panel).toContain("{ provider: currentModel.provider, id: currentModel.id }");
    expect(panel).toContain("sessionId={activeSessionId}");
  });
});
