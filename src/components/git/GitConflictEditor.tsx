import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, LoaderCircle } from "lucide-react";

import { buildResolvedContent, parseConflictFile } from "@shared/git-conflicts";
import type { GitConflictFileResult } from "@shared/git-types";

interface Props {
  repoPath: string;
  file: string;
  disabled: boolean;
  /** 必须是稳定引用（传 setState 本身），否则会反复重新拉取。 */
  onError: (message: string) => void;
  onResolved: () => void;
}

const replaceAt = (list: string[], index: number, value: string) => {
  const next = [...list];
  next[index] = value;
  return next;
};

export function GitConflictEditor({ repoPath, file, disabled, onError, onResolved }: Props) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<GitConflictFileResult | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    setValues([]);
    void window.electronAPI.gitConflictFile(repoPath, file).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.success) {
        onError(result.error || "读取冲突文件失败。");
        return;
      }
      setData(result);
      setValues(parseConflictFile(result.content || "").blocks.map((block) => block.ours));
    });
    return () => { cancelled = true; };
  }, [file, onError, repoPath]);

  const parsed = useMemo(() => parseConflictFile(data?.content || ""), [data?.content]);

  const applyAll = (choice: "ours" | "theirs") => {
    setValues(parsed.blocks.map((block) => (choice === "ours" ? block.ours : block.theirs)));
  };

  const save = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    const content = buildResolvedContent(parsed, values);
    const result = await window.electronAPI.gitWriteConflictFile(repoPath, file, content, true);
    setSaving(false);
    if (!result.success) {
      onError(result.error || "保存冲突文件失败。");
      return;
    }
    onResolved();
  }, [data, file, onError, onResolved, parsed, repoPath, values]);

  if (loading) {
    return <div className="git-diff-empty"><LoaderCircle className="spin" size={15} /> 读取冲突内容…</div>;
  }
  if (!data) {
    return <div className="git-diff-empty"><AlertTriangle size={15} /> 无法读取冲突内容。</div>;
  }
  if (data.binary) {
    return (
      <div className="git-conflict-editor">
        <div className="git-conflict-editor-note">
          二进制文件无法按块合并，只能用文件列表里的「当前 / 对方」二选一。
        </div>
      </div>
    );
  }
  if (parsed.blocks.length === 0) {
    return (
      <div className="git-conflict-editor">
        <div className="git-conflict-editor-bar">
          <span>
            <AlertTriangle size={13} />
            {data.missing
              ? "工作区里已经没有这个文件（另一侧删除了它），只能用列表里的「当前 / 对方」选择保留哪一版。"
              : "文件里没有冲突标记，可能已被手动解决。"}
          </span>
          {!data.missing && (
            <button type="button" className="git-primary-btn" onClick={() => void save()} disabled={disabled || saving}>
              <Check size={13} /> 标记为已解决
            </button>
          )}
        </div>
        {data.content ? <pre className="git-conflict-plain">{data.content}</pre> : null}
      </div>
    );
  }

  return (
    <div className="git-conflict-editor">
      <div className="git-conflict-editor-bar">
        <span><AlertTriangle size={13} /> {parsed.blocks.length} 处冲突</span>
        <div className="git-conflict-editor-actions">
          <button type="button" onClick={() => applyAll("ours")} disabled={disabled || saving}>全部用当前</button>
          <button type="button" onClick={() => applyAll("theirs")} disabled={disabled || saving}>全部用对方</button>
          <button type="button" className="git-primary-btn" onClick={() => void save()} disabled={disabled || saving}>
            {saving ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />} 保存并暂存
          </button>
        </div>
      </div>

      <div className="git-conflict-blocks persistent-scroll">
        {parsed.blocks.map((block, index) => (
          <div className="git-conflict-block" key={`${file}-${index}`}>
            <div className="git-conflict-block-head">
              <span>冲突 #{index + 1}</span>
              <div className="git-conflict-block-actions">
                <button type="button" onClick={() => setValues((current) => replaceAt(current, index, block.ours))} disabled={disabled || saving}>用当前</button>
                <button type="button" onClick={() => setValues((current) => replaceAt(current, index, `${block.ours}${block.theirs}`))} disabled={disabled || saving}>两边都要</button>
                <button type="button" onClick={() => setValues((current) => replaceAt(current, index, block.theirs))} disabled={disabled || saving}>用对方</button>
              </div>
            </div>
            <div className="git-conflict-compare">
              <div className="git-conflict-side ours">
                <span>{block.labels.ours || "当前分支"}</span>
                <pre>{block.ours || "(空)"}</pre>
              </div>
              <div className="git-conflict-side theirs">
                <span>{block.labels.theirs || "对方分支"}</span>
                <pre>{block.theirs || "(空)"}</pre>
              </div>
            </div>
            {block.base !== null && (
              <details className="git-conflict-base">
                <summary>展开共同祖先版本</summary>
                <pre>{block.base || "(空)"}</pre>
              </details>
            )}
            <label className="git-conflict-result">
              <span>合并结果</span>
              <textarea
                rows={Math.min(14, Math.max(3, values[index]?.split("\n").length || 3))}
                value={values[index] ?? ""}
                onChange={(event) => setValues((current) => replaceAt(current, index, event.target.value))}
                disabled={disabled || saving}
              />
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
