import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LoaderCircle } from "lucide-react";

import type { GitBlameLine } from "@shared/git-types";

interface Props {
  repoPath: string;
  file: string;
  onClose: () => void;
}

const formatDate = (seconds: number) => (seconds ? new Date(seconds * 1000).toLocaleDateString() : "");

/** 逐行追溯：每行显示提交、作者、时间和内容，长文件走虚拟滚动。 */
export function GitBlamePanel({ repoPath, file, onClose }: Props) {
  const [lines, setLines] = useState<GitBlameLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    setLoading(true);
    setError("");
    setLines([]);

    const blameApi = window.electronAPI?.gitBlame;
    // 主进程是旧的（没重启）时这里会是 undefined，直接调用会让 loading 永远转圈。
    if (typeof blameApi !== "function") {
      setLoading(false);
      setError("当前主进程还没有追溯接口，重启应用后再试。");
      return;
    }

    const finish = (apply: () => void) => {
      if (cancelled || settled) return;
      settled = true;
      window.clearTimeout(timer);
      setLoading(false);
      apply();
    };

    const timer = window.setTimeout(() => {
      finish(() => setError("追溯超时（30 秒）：文件过大或仓库历史过深。"));
    }, 30_000);

    blameApi(repoPath, file).then((result) => {
      finish(() => {
        if (!result.success) {
          setError(result.error || "读取追溯信息失败。");
          return;
        }
        setLines(result.lines || []);
        setTruncated(!!result.truncated);
      });
    }).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      finish(() => setError(
        /no handler registered/i.test(message)
          ? "主进程还没加载追溯接口，重启应用后再试。"
          : `追溯失败：${message}`,
      ));
    });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [file, repoPath]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 24,
  });

  return (
    <div className="git-blame">
      <div className="git-blame-bar">
        <span>
          追溯 {file}
          {lines.length > 0 ? ` · ${lines.length} 行` : ""}
          {truncated ? "（已截断）" : ""}
        </span>
        <button type="button" onClick={onClose}>返回 diff</button>
      </div>
      {loading ? (
        <div className="git-diff-empty"><LoaderCircle className="spin" size={15} /> 追溯中…</div>
      ) : error ? (
        <div className="git-diff-empty">{error}</div>
      ) : (
        <div className="git-blame-rows persistent-scroll" ref={scrollRef}>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const line = lines[item.index];
              return (
                <div
                  key={item.key}
                  className="git-blame-row"
                  style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                  title={`${line.hash} · ${line.summary}`}
                >
                  <span className="git-blame-no">{item.index + 1}</span>
                  <span className="git-blame-hash">{line.hash.slice(0, 8)}</span>
                  <span className="git-blame-author">{line.author}</span>
                  <span className="git-blame-date">{formatDate(line.time)}</span>
                  <span className="git-blame-text">{line.text || " "}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
