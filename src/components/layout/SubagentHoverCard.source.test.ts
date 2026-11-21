import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("subagent hover card", () => {
  it("renders the subagent output as markdown instead of a raw native tooltip", () => {
    const card = read("src/components/layout/SubagentHoverCard.tsx");
    // 正文必须走 MarkdownRenderer：之前原生 title 会把 ### / ```lua 原样摊开。
    expect(card).toContain('import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer"');
    expect(card).toContain("<MarkdownRenderer content={output} projectPath={projectPath} deferHighlight />");
    // 浮层是 portal 出来的 fixed 卡片，不能挤在消息流里。
    expect(card).toContain("createPortal(");
    const css = read("src/components/layout/SubagentHoverCard.css");
    expect(css).toContain("position: fixed");
    expect(css).toContain("max-height: min(560px, 62vh)");
  });

  it("opens on chip hover and survives the pointer crossing the gap", () => {
    const block = read("src/components/layout/ProcessBlock.tsx");
    expect(block).toContain('import { SubagentHoverCard, useSubagentHoverCard } from "./SubagentHoverCard"');
    expect(block).toContain("onMouseEnter={(event) => openHoverCard(subagent, event.currentTarget)}");
    expect(block).toContain("onMouseLeave={hoverCard.scheduleClose}");
    expect(block).toContain("onPointerEnter={hoverCard.cancelClose}");
    expect(block).toContain("onPointerLeave={hoverCard.scheduleClose}");

    const hook = read("src/components/layout/SubagentHoverCard.tsx");
    // 聊天列表是虚拟滚动的：一滚锚点就失效，宁可收起也不要飘在错误位置。
    expect(hook).toContain('window.addEventListener("scroll", dismiss, true)');
    // 悬停卡只记 id，渲染时取最新快照，运行中的输出才会跟着长。
    expect(hook).toContain("subagentId: string;");
  });
});
