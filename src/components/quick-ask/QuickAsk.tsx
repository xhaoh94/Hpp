import { useEffect, useRef, useState } from "react";
import type { QuickAskTarget } from "@shared/quick-ask";
import "./QuickAsk.css";

/**
 * 全局唤起的输入条。
 *
 * 目标会话固定为「上次选中的会话」——小窗里换会话要额外加载整个项目树，
 * 与 760×150 的定位不匹配；换会话说到底还是回主窗口做。
 */
export function QuickAsk() {
  const [target, setTarget] = useState<QuickAskTarget | null | undefined>(undefined);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const focusInput = () => {
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  useEffect(() => {
    void window.electronAPI.getQuickAskTarget()
      .then((next) => setTarget(next))
      .catch(() => setTarget(null));
  }, []);

  useEffect(() => window.electronAPI.onQuickAskFocus(focusInput), []);

  useEffect(() => {
    if (target) focusInput();
  }, [target]);

  const returnToMain = async () => {
    try {
      const result = await window.electronAPI.focusMainWindow();
      if (!result.ok) setError(result.error || "无法返回 Hpp。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const submit = async () => {
    const content = value.trim();
    if (sending) return;
    if (!target) {
      setError("没有可用的会话，请先在 Hpp 里打开一个");
      return;
    }
    if (!content) return;
    setSending(true);
    setError("");
    try {
      const result = await window.electronAPI.submitQuickAsk({
        sessionId: target.sessionId,
        content,
        clientMessageId: crypto.randomUUID(),
      });
      if (!result.ok) {
        setError(result.error || "发送失败。");
        setSending(false);
        return;
      }
      setValue("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    setSending(false);
  };

  return (
    <div className="quick-ask-shell">
      <div className="quick-ask-card">
        <div className="quick-ask-header">
          <span className="quick-ask-target">
            {target === undefined
              ? "读取当前会话…"
              : target
                ? <><span className="quick-ask-project">{target.projectName}</span><span className="quick-ask-sep">/</span>{target.sessionTitle}</>
                : "没有可用的会话，请先在 Hpp 里打开一个"}
          </span>
          <button type="button" className="quick-ask-close" onClick={() => void window.electronAPI.hideQuickAsk()} aria-label="关闭">×</button>
        </div>
        <textarea
          ref={inputRef}
          className="quick-ask-input"
          value={value}
          rows={2}
          placeholder={target ? "说点什么，Enter 发送，Shift+Enter 换行" : "暂无可发送的会话"}
          disabled={sending}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              void window.electronAPI.hideQuickAsk();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              // 空内容回车不是发送，而是收起输入条回到 Hpp 主窗口，
              // 让用户直接在主窗口的聊天输入框里继续写。
              if (!value.trim()) {
                void returnToMain();
                return;
              }
              void submit();
            }
          }}
        />
        <div className="quick-ask-footer">
          <span className={error ? "quick-ask-error" : "quick-ask-hint"}>{error || "Enter 发送；空内容 Enter 返回 Hpp 输入框"}</span>
          <span className="quick-ask-hint">Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
