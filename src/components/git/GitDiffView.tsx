import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { ParsedGitPatch } from "@shared/git-hunks";

interface Props {
  parsed: ParsedGitPatch;
  stagedView?: boolean;
  disabled?: boolean;
  onApplyHunk: (index: number) => void;
  onDiscardHunk: (index: number) => void;
}

type DiffRow =
  | { kind: "hunk"; hunkIndex: number; header: string }
  | { kind: "line"; hunkIndex: number; line: string; lineIndex: number };

/**
 * diff 面板：把 hunks 摊平成行做虚拟滚动。
 * 大文件（几千行）全量挂 DOM 会明显卡顿，只渲染视口附近的行。
 * 滚动容器复用外层的 .git-diff-content —— 它本来就有 overflow:auto，
 * 这里不能再套一个可滚容器，否则会出现内外两条滚动条。
 */
export function GitDiffView({ parsed, stagedView, disabled, onApplyHunk, onDiscardHunk }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  // rootRef 挂载后才能拿到父容器；用 state 触发一次重渲染，虚拟器才认得滚动元素。
  useEffect(() => {
    setScrollElement(rootRef.current?.parentElement ?? null);
  }, []);
  const rows = useMemo<DiffRow[]>(() => parsed.hunks.flatMap((hunk) => [
    { kind: "hunk" as const, hunkIndex: hunk.index, header: hunk.header },
    ...hunk.lines.map((line, lineIndex) => (
      { kind: "line" as const, hunkIndex: hunk.index, line, lineIndex }
    )),
  ]), [parsed]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    // 滚动发生在父容器 .git-diff-content 上，本组件只负责撑高度和渲染可见行。
    getScrollElement: () => scrollElement,
    estimateSize: (index) => rows[index]?.kind === "hunk" ? 32 : 20,
    overscan: 24,
  });

  return (
    <div className="git-diff-virtual" ref={rootRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          if (row.kind === "hunk") {
            return (
              <div
                key={item.key}
                className="git-hunk-header git-hunk-header-virtual"
                style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              >
                <code>{row.header}</code>
                <div className="git-hunk-actions">
                  <button type="button" onClick={() => onApplyHunk(row.hunkIndex)} disabled={disabled}>
                    {stagedView ? "移除此块" : "添加此块至待提交"}
                  </button>
                  {!stagedView && (
                    <button type="button" className="danger" onClick={() => onDiscardHunk(row.hunkIndex)} disabled={disabled}>
                      丢弃此块
                    </button>
                  )}
                </div>
              </div>
            );
          }
          return (
            <div
              key={item.key}
              className={`git-hunk-line ${row.line.startsWith("+") ? "add" : row.line.startsWith("-") ? "remove" : ""}`}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >{row.line || " "}</div>
          );
        })}
      </div>
    </div>
  );
}
