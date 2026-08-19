import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronDown, ChevronRight, FileCode, Replace } from "lucide-react";
import { applyPreserveCase } from "@/lib/file-preview-code";

export interface ExpandSearchResult {
  path: string;
  name: string;
  relPath: string;
  dirPath: string;
  lineNumber: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

export interface ExpandSearchGroup {
  path: string;
  name: string;
  relPath: string;
  dirPath: string;
  matches: ExpandSearchResult[];
}

export const EXPAND_SEARCH_ROW_HEIGHT = 22;
export const EXPAND_SEARCH_HEADER_HEIGHT = 27;
// Worker 单文件最多返回 200 条；阈值必须低于该上限，否则自动折叠永远不会触发。
export const EXPAND_SEARCH_AUTO_COLLAPSE_THRESHOLD = 100;
const EXPAND_SEARCH_OVERSCAN_PX = 900;
const EXPAND_SEARCH_WINDOW_GUARD_PX = 220;
const EXPAND_SEARCH_PREVIEW_CONTEXT_CHARS = 160;

type ExpandSearchRow =
  | {
      kind: "header";
      key: string;
      group: ExpandSearchGroup;
      top: number;
      height: number;
      collapsed: boolean;
    }
  | {
      kind: "match";
      key: string;
      group: ExpandSearchGroup;
      match: ExpandSearchResult;
      top: number;
      height: number;
    };

export interface ExpandSearchRows {
  rows: ExpandSearchRow[];
  totalHeight: number;
}

export function buildExpandSearchRows(
  groups: ExpandSearchGroup[],
  collapsed: Record<string, boolean>,
): ExpandSearchRows {
  const rows: ExpandSearchRow[] = [];
  let top = 0;

  for (const group of groups) {
    const collapsedNow = collapsed[group.path] ?? group.matches.length >= EXPAND_SEARCH_AUTO_COLLAPSE_THRESHOLD;
    rows.push({
      kind: "header",
      key: `h:${group.path}`,
      group,
      top,
      height: EXPAND_SEARCH_HEADER_HEIGHT,
      collapsed: collapsedNow,
    });
    top += EXPAND_SEARCH_HEADER_HEIGHT;

    if (collapsedNow) continue;
    for (let index = 0; index < group.matches.length; index++) {
      const match = group.matches[index];
      rows.push({
        kind: "match",
        key: `m:${group.path}:${match.lineNumber}:${index}`,
        group,
        match,
        top,
        height: EXPAND_SEARCH_ROW_HEIGHT,
      });
      top += EXPAND_SEARCH_ROW_HEIGHT;
    }
  }

  return { rows, totalHeight: top };
}

export function getExpandSearchVisibleRows(
  model: ExpandSearchRows,
  scrollTop: number,
  viewportHeight: number,
  overscan = EXPAND_SEARCH_OVERSCAN_PX,
): ExpandSearchRow[] {
  const { rows, totalHeight } = model;
  if (rows.length === 0) return [];

  const safeViewportHeight = Math.max(1, viewportHeight);
  const maxScrollTop = Math.max(0, totalHeight - safeViewportHeight);
  const safeScrollTop = Math.min(Math.max(0, scrollTop), maxScrollTop);
  const visibleTop = Math.max(0, safeScrollTop - Math.max(0, overscan));
  const visibleBottom = Math.min(
    totalHeight,
    safeScrollTop + safeViewportHeight + Math.max(0, overscan),
  );

  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const row = rows[middle];
    if (row.top + row.height <= visibleTop) low = middle + 1;
    else high = middle;
  }

  const visible: ExpandSearchRow[] = [];
  for (let index = low; index < rows.length; index++) {
    const row = rows[index];
    if (row.top >= visibleBottom) break;
    visible.push(row);
  }
  return visible;
}

export interface ExpandSearchPreviewParts {
  before: string;
  matched: string;
  after: string;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
}

export function getExpandSearchPreviewParts(match: ExpandSearchResult): ExpandSearchPreviewParts {
  const safeStart = Math.min(Math.max(0, match.matchStart), match.preview.length);
  const safeEnd = Math.min(Math.max(safeStart, match.matchEnd), match.preview.length);
  const previewStart = Math.max(0, safeStart - EXPAND_SEARCH_PREVIEW_CONTEXT_CHARS);
  const previewEnd = Math.min(match.preview.length, safeEnd + EXPAND_SEARCH_PREVIEW_CONTEXT_CHARS);
  return {
    before: match.preview.slice(previewStart, safeStart),
    matched: match.preview.slice(safeStart, safeEnd),
    after: match.preview.slice(safeEnd, previewEnd),
    truncatedBefore: previewStart > 0,
    truncatedAfter: previewEnd < match.preview.length,
  };
}

const ExpandSearchResultRow = memo(function ExpandSearchResultRow({
  row,
  replaceOpen,
  replaceQuery,
  preserveCase,
  onGoto,
  onReplace,
  onToggleCollapse,
}: {
  row: ExpandSearchRow;
  replaceOpen: boolean;
  replaceQuery: string;
  preserveCase: boolean;
  onGoto: (path: string, lineNumber: number) => void;
  onReplace: (match: ExpandSearchResult) => void;
  onToggleCollapse: (path: string, autoCollapsed: boolean) => void;
}) {
  const rowStyle = {
    position: "absolute" as const,
    top: row.top,
    left: 0,
    right: 0,
    height: row.height,
  };

  if (row.kind === "header") {
    return (
      <div className="editor-expand-search-vrow" style={rowStyle}>
        <button
          type="button"
          className="editor-expand-search-group-head"
          style={{ height: row.height }}
          onClick={() =>
            onToggleCollapse(
              row.group.path,
              row.group.matches.length >= EXPAND_SEARCH_AUTO_COLLAPSE_THRESHOLD,
            )
          }
          aria-expanded={!row.collapsed}
          title={row.group.path}
        >
          {row.collapsed ? (
            <ChevronRight size={12} strokeWidth={2} className="editor-expand-search-chevron" />
          ) : (
            <ChevronDown size={12} strokeWidth={2} className="editor-expand-search-chevron" />
          )}
          <FileCode size={14} strokeWidth={2} className="editor-expand-search-fileicon" />
          <span className="editor-expand-search-name">{row.group.name}</span>
          <span className="editor-expand-search-count">{row.group.matches.length}</span>
          <span className="editor-expand-search-path">{row.group.dirPath}</span>
        </button>
      </div>
    );
  }

  const preview = getExpandSearchPreviewParts(row.match);
  return (
    <div className="editor-expand-search-vrow" style={rowStyle}>
      <div className="editor-expand-search-match-item">
        <button
          type="button"
          className="editor-expand-search-match"
          style={{ height: row.height }}
          onClick={() => onGoto(row.group.path, row.match.lineNumber)}
          title={`跳转到第 ${row.match.lineNumber} 行`}
        >
          <span className="editor-expand-search-match-line">:{row.match.lineNumber}</span>
          <span className="editor-expand-search-match-preview">
            {replaceOpen ? (
              <>
                {preview.truncatedBefore && "..."}
                {preview.before}
                <del className="editor-expand-search-replace-old">{preview.matched}</del>
                <ins className="editor-expand-search-replace-new">
                  {preserveCase ? applyPreserveCase(preview.matched, replaceQuery) : replaceQuery}
                </ins>
                {preview.after}
                {preview.truncatedAfter && "..."}
              </>
            ) : (
              <>
                {preview.truncatedBefore && "..."}
                {preview.before}
                <mark className="editor-expand-search-mark">{preview.matched}</mark>
                {preview.after}
                {preview.truncatedAfter && "..."}
              </>
            )}
          </span>
        </button>
        {replaceOpen && (
          <button
            type="button"
            className="editor-expand-search-replace-btn"
            onClick={(event) => {
              event.stopPropagation();
              onReplace(row.match);
            }}
            title="替换此匹配"
            aria-label="替换此匹配"
          >
            <Replace size={12} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
});

export function ExpandSearchList({
  groups,
  replaceOpen,
  replaceQuery,
  preserveCase,
  onGoto,
  onReplace,
}: {
  groups: ExpandSearchGroup[];
  replaceOpen: boolean;
  replaceQuery: string;
  preserveCase: boolean;
  onGoto: (path: string, lineNumber: number) => void;
  onReplace: (match: ExpandSearchResult) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 1 });
  const model = useMemo(() => buildExpandSearchRows(groups, collapsed), [collapsed, groups]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const readViewport = () => {
      const next = { scrollTop: element.scrollTop, height: Math.max(1, element.clientHeight) };
      setViewport((current) =>
        current.scrollTop === next.scrollTop && current.height === next.height ? current : next,
      );
    };

    readViewport();
    const resizeObserver = new ResizeObserver(readViewport);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [model.totalHeight]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const nextScrollTop = element.scrollTop;
    const nextHeight = Math.max(1, element.clientHeight);
    const renderedTop = Math.max(0, viewport.scrollTop - EXPAND_SEARCH_OVERSCAN_PX);
    const renderedBottom = Math.min(
      model.totalHeight,
      viewport.scrollTop + viewport.height + EXPAND_SEARCH_OVERSCAN_PX,
    );
    const viewportStillBuffered =
      nextHeight === viewport.height
      && nextScrollTop >= renderedTop + (renderedTop > 0 ? EXPAND_SEARCH_WINDOW_GUARD_PX : 0)
      && nextScrollTop + nextHeight
        <= renderedBottom - (renderedBottom < model.totalHeight ? EXPAND_SEARCH_WINDOW_GUARD_PX : 0);
    if (viewportStillBuffered) return;

    // 大跨度拖动必须同步换窗，避免视口越过已渲染区域；普通逐行滚动由 overscan
    // 缓冲直接承接，不触发 React 更新。
    flushSync(() => {
      setViewport((current) =>
        current.scrollTop === nextScrollTop && current.height === nextHeight
          ? current
          : { scrollTop: nextScrollTop, height: nextHeight },
      );
    });
  }, [model.totalHeight, viewport.height, viewport.scrollTop]);

  const toggleCollapse = useCallback((path: string, autoCollapsed: boolean) => {
    setCollapsed((current) => {
      const explicit = current[path];
      return { ...current, [path]: explicit === undefined ? !autoCollapsed : !explicit };
    });
  }, []);

  const visibleRows = useMemo(
    () => getExpandSearchVisibleRows(model, viewport.scrollTop, viewport.height),
    [model, viewport.height, viewport.scrollTop],
  );

  return (
    <div ref={scrollRef} className="editor-expand-search-list" onScroll={handleScroll}>
      <div className="editor-expand-search-virtual" style={{ height: model.totalHeight }}>
        {visibleRows.map((row) => (
          <ExpandSearchResultRow
            key={row.key}
            row={row}
            replaceOpen={replaceOpen}
            replaceQuery={replaceQuery}
            preserveCase={preserveCase}
            onGoto={onGoto}
            onReplace={onReplace}
            onToggleCollapse={toggleCollapse}
          />
        ))}
      </div>
    </div>
  );
}
