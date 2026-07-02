import { useState } from "react";
import type { FileDiff } from "@/stores/chat-store";

export function DiffBlock({ diffs }: { diffs: FileDiff[] }) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const toggleFile = (file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  return (
    <div className="chat-diffs">
      {diffs.map((diff, i) => {
        const isExpanded = expandedFiles.has(diff.file);
        return (
          <div key={`${diff.file}-${i}`} className="chat-diff-file">
            <button className="chat-diff-file-header" onClick={() => toggleFile(diff.file)}>
              <svg
                width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
              <span className="chat-diff-file-icon">
                {diff.status === "added" ? "+" : diff.status === "deleted" ? "-" : "~"}
              </span>
              <span className="chat-diff-file-name">{diff.file}</span>
              <span className="chat-diff-file-stats">
                {diff.additions > 0 && <span className="chat-diff-add">+{diff.additions}</span>}
                {diff.deletions > 0 && <span className="chat-diff-del">-{diff.deletions}</span>}
              </span>
            </button>
            {isExpanded && (
              <pre className="chat-diff-content">
                {diff.patch.split("\n").map((line, j) => {
                  let cls = "chat-diff-line";
                  if (line.startsWith("+")) cls += " chat-diff-add-line";
                  else if (line.startsWith("-")) cls += " chat-diff-del-line";
                  else if (line.startsWith("@@")) cls += " chat-diff-header-line";
                  return (
                    <span key={j} className={cls}>
                      {line}
                    </span>
                  );
                })}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
