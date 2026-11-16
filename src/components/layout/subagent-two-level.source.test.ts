import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("chat subagent two-level expansion", () => {
  const block = readWorkspaceFile("src/components/layout/ProcessBlock.tsx");

  it("uses the task prompt as the first-level summary and keeps message for the detailed flow", () => {
    // 一级摘要读 prompt，退回 message 首行；二级详情才用完整 message。
    expect(block).toContain("expanded?.prompt?.trim()");
    expect(block).toContain("expandedText.split(/\\r?\\n/)");
    expect(block).toContain("chat-subagent-summary-text");
    expect(block).toContain("chat-subagent-flow");
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

  it("styles the summary card, status badge and detail toggle", () => {
    const css = readWorkspaceFile("src/components/layout/ChatPanel.css");
    expect(css).toContain(".chat-subagent-summary {");
    expect(css).toContain(".chat-subagent-status.status-completed");
    expect(css).toContain(".chat-subagent-detail-toggle");
    expect(css).toContain(".chat-subagent-flow {");
  });
});
