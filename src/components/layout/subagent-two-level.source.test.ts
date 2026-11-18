import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("chat subagent two-level expansion", () => {
  const block = readWorkspaceFile("src/components/layout/ProcessBlock.tsx");

  it("shows a one-line task title at the first level and keeps message for the detailed flow", () => {
    // 胶囊/面板用极简标题；一级展开用多一句摘要，两者刻意不同。
    expect(block).toContain("getSubagentSummaryText(fullPrompt, expandedText)");
    // 胶囊仍用极简标题，和一级摘要刻意不同——两个 import 都要在。
    expect(block).toContain("{subagent.title || getSubagentTitle(subagent.prompt, subagent.label)}");
    expect(block).toContain("getSubagentSummaryText, getSubagentTitle");
    expect(block).toContain('title={fullPrompt || undefined}');
    expect(block).toContain("chat-subagent-summary-text");
    expect(block).toContain("chat-subagent-flow");
    const css = readWorkspaceFile("src/components/layout/ChatPanel.css");
    const summaryRule = css.slice(css.indexOf(".chat-subagent-summary-text {"), css.indexOf("}", css.indexOf(".chat-subagent-summary-text {")));
    expect(summaryRule).toContain("-webkit-line-clamp: 3");
    expect(summaryRule).not.toContain("white-space: nowrap");
    expect(css).not.toContain("chat-subagent-summary-text.collapsed");
  });

  it("keeps two independent levels: selecting a chip resets the detail level", () => {
    expect(block).toContain("const [expandedId, setExpandedId] = useState<string | null>(null)");
    expect(block).toContain("const [detailOpen, setDetailOpen] = useState(false)");
    // 切换胶囊 / 同一条再点都重置第二级。
    expect(block).toContain("setDetailOpen(false)");
    expect(block.match(/setDetailOpen\(false\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(block).toContain("() => setDetailOpen((open) => !open)");
    // 两级展开都走 preserveScroll，锚点取当前点击元素，行为与展开思考一致。
    expect(block.match(/onPreserveScroll\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(block).toContain("event.currentTarget");
  });

  it("only renders the full markdown flow behind the second-level toggle", () => {
    // MarkdownRenderer 只在 detailOpen 分支里出现，不能一展开胶囊就直接铺流程。
    const flowIndex = block.indexOf("chat-subagent-flow");
    const mdIndex = block.indexOf("<MarkdownRenderer content={expandedText}", flowIndex);
    expect(flowIndex).toBeGreaterThan(-1);
    expect(mdIndex).toBeGreaterThan(flowIndex);
    expect(block).toContain("{detailOpen && expandedText && (");
  });

  it("labels the subagent elapsed time as 运行时间, not 已运行", () => {
    expect(block).toContain("`运行时间 ${formatProcessDuration(");
    expect(block).not.toContain("`已运行 ${formatProcessDuration(");
  });

  it("shows the running model next to token usage in the first-level card", () => {
    expect(block).toContain('{formatSubagentModel(expanded.model)}');
    expect(block).toContain("chat-subagent-usage-meta");
    const css = readWorkspaceFile("src/components/layout/ChatPanel.css");
    expect(css).toContain(".chat-subagent-model {");
    expect(css).toContain(".chat-subagent-usage-meta {");
    // 模型名是 token 行的纯文本，不套胶囊（无边框/背景/圆角）。
    const modelRule = css.slice(css.indexOf(".chat-subagent-model {"), css.indexOf("}", css.indexOf(".chat-subagent-model {")));
    expect(modelRule).not.toContain("border");
    expect(modelRule).not.toContain("background");
    expect(modelRule).not.toContain("border-radius");
  });

  it("styles the summary card, status badge and detail toggle", () => {
    const css = readWorkspaceFile("src/components/layout/ChatPanel.css");
    expect(css).toContain(".chat-subagent-summary {");
    expect(css).toContain(".chat-subagent-status.status-completed");
    expect(css).toContain(".chat-subagent-detail-toggle");
    expect(css).toContain(".chat-subagent-flow {");
  });
});
