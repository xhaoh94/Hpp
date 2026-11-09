import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ClipboardType, Copy, Download, X } from "lucide-react";
import { getComposerPasteStats } from "@shared/composer-document";
import { getPastedTextPreview } from "@/lib/paste-fold";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import {
  getComposerPasteChipLabel,
  getComposerPastePreviewTitle,
  getComposerPasteTruncatedNotice,
  uiText,
} from "@/i18n/text";
import "./ComposerPasteChip.css";

const VIEWPORT_GAP = 12;
const ANCHOR_GAP = 8;
/** 悬停后延迟一点再弹，避免鼠标扫过标签就闪出一大块文本。 */
const OPEN_DELAY_MS = 220;
/** 移出后延迟关闭，留出走位到浮层（复制 / 另存为按钮）的时间。 */
const CLOSE_DELAY_MS = 260;

type ComposerPasteChipProps = {
  text: string;
  /** 输入框里显示删除按钮；消息气泡里不传。 */
  onRemove?: () => void;
  /** `message` 用在聊天气泡/处理面板里，间距更紧。 */
  variant?: "composer" | "message";
  className?: string;
};

/**
 * 粘贴文本标签：输入框与消息气泡共用。
 *
 * 文本本身不进 DOM 正文（否则 500 行日志会把气泡撑开），只显示体量摘要；
 * 悬停（触屏为点击）弹出只读浮层，浮层里可以复制全文或另存为 txt。
 * 浮层用 portal 挂到 body 上，避免被输入框/虚拟列表的 overflow 裁掉。
 */
export function ComposerPasteChip({
  text,
  onRemove,
  variant = "composer",
  className = "",
}: ComposerPasteChipProps) {
  const chipRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const stats = useMemo(() => getComposerPasteStats(text), [text]);
  const preview = useMemo(() => getPastedTextPreview(text), [text]);
  const label = useMemo(() => getComposerPasteChipLabel(stats), [stats]);
  const canSaveToDisk = typeof window !== "undefined" && !!window.electronAPI?.saveTextFile;

  const clearTimers = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const openCard = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(true);
  }, []);

  const scheduleOpen = useCallback(() => {
    if (open || openTimerRef.current) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, OPEN_DELAY_MS);
  }, [open]);

  const scheduleClose = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  }, []);

  const closeCard = useCallback(() => {
    clearTimers();
    setOpen(false);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  // 关闭后清掉定位，下次打开重新按当前滚动位置计算。
  useEffect(() => {
    if (open) return;
    setPosition(null);
    setSaved(false);
  }, [open]);

  /**
   * 根据当前滚动位置重算浮层坐标。
   * 返回 false 表示锚点已经滚出视口（或者卡片不存在），调用方决定是否关闭。
   */
  const updatePosition = useCallback(() => {
    const anchorElement = chipRef.current;
    const card = cardRef.current;
    if (!anchorElement || !card) return true;
    const anchor = anchorElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    // 锚点整体滑出视口后浮层已经没有参照物了。
    if (anchor.bottom < 0 || anchor.top > viewportHeight) return false;
    const rect = card.getBoundingClientRect();
    // 输入框位于窗口底部，优先向上弹；上方也放不下时退回锚点下方。
    const fitsAbove = anchor.top - ANCHOR_GAP - rect.height >= VIEWPORT_GAP;
    const fitsBelow = anchor.bottom + ANCHOR_GAP + rect.height <= viewportHeight - VIEWPORT_GAP;
    const top = fitsAbove
      ? anchor.top - ANCHOR_GAP - rect.height
      : fitsBelow
        ? anchor.bottom + ANCHOR_GAP
        : Math.max(VIEWPORT_GAP, Math.min(
          anchor.bottom + ANCHOR_GAP,
          viewportHeight - rect.height - VIEWPORT_GAP,
        ));
    const left = Math.max(
      VIEWPORT_GAP,
      Math.min(anchor.left, viewportWidth - rect.width - VIEWPORT_GAP),
    );
    setPosition((previous) => (
      previous && previous.left === left && previous.top === top ? previous : { left, top }
    ));
    return true;
  }, []);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (chipRef.current?.contains(target)) return;
      if (cardRef.current?.contains(target)) return;
      closeCard();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeCard();
    };
    // 窗口尺寸变化让锚点彻底失效，直接关掉比错位显示更稳。
    const handleResize = () => closeCard();
    let scrollFrame = 0;
    const handleScroll = (event: Event) => {
      const target = event.target as Node | null;
      // 浮层自己内部的滚动（pre 的 overflow / 拖动滚动条）绝不能让浮层关掉，
      // 否则长文本根本滚不动。
      if (target && cardRef.current?.contains(target)) return;
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        // 外层滚动时跟随重定位；锚点滚出视口再关闭。
        if (!updatePosition()) closeCard();
      });
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleResize);
    // capture 阶段拿得到虚拟列表/输入框内部的滚动（它们不冒泡到 window）。
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [closeCard, open, updatePosition]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, preview.text, updatePosition]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      showFloatingToastMessage(uiText.chatComposer.pasteCopied);
    } catch {
      showFloatingToastMessage("复制失败，请手动选择文本");
    }
  }, [text]);

  const handleSave = useCallback(async () => {
    const saveTextFile = window.electronAPI?.saveTextFile;
    if (!saveTextFile) return;
    try {
      const result = await saveTextFile(text, "pasted-text.txt");
      if (result.canceled) return;
      if (!result.success) {
        showFloatingToastMessage(`${uiText.chatComposer.pasteSaveFailed}: ${result.error || ""}`.trim());
        return;
      }
      setSaved(true);
      showFloatingToastMessage(result.path
        ? `${uiText.chatComposer.pasteSaved}: ${result.path}`
        : uiText.chatComposer.pasteSaved);
    } catch (error) {
      showFloatingToastMessage(`${uiText.chatComposer.pasteSaveFailed}: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }, [text]);

  const card = open
    ? createPortal(
      <div
        ref={cardRef}
        className="composer-paste-card"
        role="dialog"
        aria-label={uiText.chatComposer.pastePreviewTitle}
        data-composer-paste-card=""
        style={position
          ? { left: position.left, top: position.top }
          : { left: 0, top: 0, visibility: "hidden" }}
        onPointerEnter={openCard}
        onPointerLeave={scheduleClose}
        // 浮层在输入框正上方，任何按下都不该让编辑器抢焦点或触发选区变化。
        onMouseDown={(event) => event.preventDefault()}
      >
        <div className="composer-paste-card-header">
          <span className="composer-paste-card-title">{uiText.chatComposer.pastePreviewTitle}</span>
          <span className="composer-paste-card-stats">{getComposerPastePreviewTitle(stats)}</span>
          <div className="composer-paste-card-actions">
            <button type="button" onClick={() => void handleCopy()} title={uiText.chatComposer.pasteCopy}>
              <Copy size={13} strokeWidth={2} />
              <span>{uiText.chatComposer.pasteCopy}</span>
            </button>
            {canSaveToDisk && (
              <button
                type="button"
                className={saved ? "saved" : undefined}
                onClick={() => void handleSave()}
                title={uiText.chatComposer.pasteSave}
              >
                {saved
                  ? <Check size={13} strokeWidth={2.2} />
                  : <Download size={13} strokeWidth={2} />}
                <span>{saved ? uiText.chatComposer.pasteSaved : uiText.chatComposer.pasteSave}</span>
              </button>
            )}
            <button type="button" onClick={closeCard} title="关闭" aria-label="关闭预览">
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        </div>
        <pre className="composer-paste-card-content">{preview.text}</pre>
        {preview.truncated && (
          <div className="composer-paste-card-more">
            {getComposerPasteTruncatedNotice(preview.totalLines, preview.text.split(/\r?\n/).length)}
          </div>
        )}
      </div>,
      document.body,
    )
    : null;
  return (
    <>
      <span
        ref={chipRef}
        className={`composer-paste-chip ${variant}${className ? ` ${className}` : ""}`.trim()}
        data-composer-paste-chip=""
        title={uiText.chatComposer.pasteExpandHint}
        onPointerEnter={scheduleOpen}
        onPointerLeave={scheduleClose}
        // 在 Lexical 装饰节点里：按下不能把焦点从编辑器挪走，否则后续删除/插入会走丢。
        onMouseDown={(event) => event.preventDefault()}
      >
        <button
          type="button"
          className="composer-paste-chip-body"
          aria-expanded={open}
          aria-label={label}
          onClick={() => (open ? closeCard() : openCard())}
          onFocus={openCard}
          onBlur={scheduleClose}
        >
          <ClipboardType size={13} strokeWidth={2} className="composer-paste-chip-icon" />
          <span className="composer-paste-chip-label">{label}</span>
        </button>
        {onRemove && (
          <button
            type="button"
            className="composer-paste-chip-remove"
            title={uiText.chatComposer.pasteRemove}
            aria-label={uiText.chatComposer.pasteRemove}
            onClick={onRemove}
            onFocus={scheduleClose}
          >
            <X size={11} />
          </button>
        )}
      </span>
      {card}
    </>
  );
}
