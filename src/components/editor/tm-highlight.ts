/**
 * TextMate 语法高亮 —— 主线程桥接。
 *
 * 通过 ViewPlugin + DecorationSet 把 worker 返回的 token 渲染为字符级 mark
 * decoration（class 形如 cm-tm-<cls>，颜色在 CSS 中按 Dark+/Light+ 定义）。
 *
 * 启用条件（由 EditorPane 在文件加载完成后决定）：
 * - 扩展名为 .lua / .cs
 * - 文件 ≤ MAX_TM_BYTES 且行数 ≤ MAX_TM_LINES（大文件回退 StreamLanguage）
 *
 * 启用后会清空语言 Compartment（移除 StreamLanguage），避免 tag 着色
 * （syntaxHighlighting）覆盖 TextMate decoration 的颜色。
 */
import { Compartment, EditorState, Extension, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { TmWorkerLine } from "./tm-highlight-worker";

/** 启用 TextMate 高亮的文件大小/行数上限（字节 / 行）。 */
export const MAX_TM_BYTES = 500 * 1024;
export const MAX_TM_LINES = 20000;

export type TextMateLanguage = "lua" | "cs";

/** 根据文件路径判断是否需要 TextMate 高亮及对应语言。 */
export function getTextMateLanguage(filePath: string): TextMateLanguage | null {
  const fileName = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const ext = fileName.split(".").pop() ?? "";
  if (ext === "lua") return "lua";
  if (ext === "cs") return "cs";
  return null;
}

/** 估算字符串的 UTF-8 字节数（用于文件大小阈值判断）。 */
export function estimateTextBytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

// ===== Worker 单例管理 =====

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

interface WorkerResponse {
  id: number;
  ok: boolean;
  tokens?: TmWorkerLine[];
  error?: string;
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./tm-highlight-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.tokens ?? []);
      else entry.reject(new Error(msg.error ?? "TextMate tokenize failed"));
    };
    worker.onerror = (event) => {
      for (const [, entry] of pending) {
        entry.reject(new Error(event.message || "TextMate worker error"));
      }
      pending.clear();
    };
  }
  return worker;
}

export function tokenizeTextMate(language: TextMateLanguage, lines: string[]): Promise<TmWorkerLine[]> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    getWorker().postMessage({ id, type: "tokenize", language, lines });
  });
}

// ===== StateEffect：EditorPane 加载完成后告知启用状态 =====

export interface TmEnablePayload {
  language: TextMateLanguage | null;
  enabled: boolean;
}

export const tmEnableEffect = StateEffect.define<TmEnablePayload>();

// ===== ViewPlugin =====

/** TextMate 高亮运行时状态（用于状态栏指示）。 */
export type TmStatus =
  | { kind: "idle" }
  | { kind: "on" }
  | { kind: "off"; reason: string }
  | { kind: "error"; reason: string };

export interface TmHighlightPluginOptions {
  language: TextMateLanguage | null;
  langCompartment: Compartment;
  /** worker 失败时的降级语言扩展（通常是原 StreamLanguage），恢复非空白高亮。 */
  fallbackLanguage: Extension[] | null;
  /** 运行时状态回调，用于状态栏指示。 */
  onStatus?: (status: TmStatus) => void;
}

const TM_TOKENIZE_DEBOUNCE_MS = 150;

export function tmHighlightPlugin(options: TmHighlightPluginOptions) {
  return ViewPlugin.fromClass(
    class TmHighlight {
      decorations: DecorationSet = Decoration.none;

      private language: TextMateLanguage | null = options.language;
      private enabled = false;
      private timer: ReturnType<typeof setTimeout> | null = null;
      private dirty = false;
      private disposed = false;
      private requestedLines = 0;
      private tokens: TmWorkerLine[] | null = null;

      constructor(private view: EditorView) {
        if (!options.language) {
          options.onStatus?.({ kind: "off", reason: "仅 .lua / .cs 启用" });
        } else {
          options.onStatus?.({ kind: "idle" });
        }
      }

      update(update: ViewUpdate) {
        for (const tr of update.transactions) {
          for (const effect of tr.effects) {
            if (effect.is(tmEnableEffect)) {
              const payload = effect.value;
              if (payload.enabled && payload.language) {
                if (!this.enabled) {
                  // 首次启用：清空语言 Compartment，移除 StreamLanguage 的 tag 着色，
                  // 让 TextMate decoration 独占颜色。
                  // 注意：CodeMirror 禁止在 update() 回调内再次 dispatch（会抛
                  // "Calls to EditorView.update are not allowed while an update is
                  // in progress"），必须推迟到当前更新完成之后再执行。
                  queueMicrotask(() => {
                    if (!this.disposed) {
                      this.view.dispatch({ effects: options.langCompartment.reconfigure([]) });
                    }
                  });
                }
                this.enabled = true;
                this.language = payload.language;
                options.onStatus?.({ kind: "on" });
                this.scheduleTokenize();
              } else {
                this.enabled = false;
                this.tokens = null;
                this.decorations = Decoration.none;
                if (this.timer) clearTimeout(this.timer);
                this.timer = null;
                options.onStatus?.({
                  kind: "off",
                  reason: payload.enabled
                    ? "缺少语言"
                    : "文件超过 500KB / 20000 行，已回退内置高亮",
                });
              }
            }
          }
        }
        if (update.docChanged && this.enabled) {
          this.dirty = true;
          this.scheduleTokenize();
        }
      }

      destroy() {
        this.disposed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
      }

      private scheduleTokenize() {
        if (!this.enabled || !this.language) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.runTokenize();
        }, TM_TOKENIZE_DEBOUNCE_MS);
      }

      private async runTokenize() {
        if (!this.enabled || !this.language || this.disposed) return;
        const language = this.language;
        const lines = this.view.state.doc.toString().split("\n");
        if (lines.length > MAX_TM_LINES) return;
        this.requestedLines = lines.length;
        this.dirty = false;
        let tokens: TmWorkerLine[];
        try {
          tokens = await tokenizeTextMate(language, lines);
        } catch (err) {
          // worker 失败（如 wasm 加载失败）：恢复原 StreamLanguage 高亮，不打扰用户。
          console.error("[TextMate] tokenize 失败，已回退内置高亮:", err);
          this.enabled = false;
          this.view.dispatch({
            effects: options.langCompartment.reconfigure(options.fallbackLanguage ?? []),
          });
          options.onStatus?.({
            kind: "error",
            reason: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        if (this.disposed || !this.enabled || this.language !== language) return;
        // 文档在 tokenize 期间又发生了变化：重新排队。
        if (this.dirty || this.view.state.doc.lines !== this.requestedLines) {
          this.scheduleTokenize();
          return;
        }
        this.tokens = tokens;
        this.decorations = buildTmDecorations(this.view.state, tokens);
        // 空事务触发重新渲染 decorations。
        this.view.dispatch();
      }
    },
    { decorations: (view) => view.decorations },
  );
}

function buildTmDecorations(state: EditorState, tokens: TmWorkerLine[]): DecorationSet {
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];
  const doc = state.doc;
  const lineCount = Math.min(doc.lines, tokens.length);
  for (let index = 0; index < lineCount; index += 1) {
    const line = doc.line(index + 1);
    const lineTokens = tokens[index];
    if (!lineTokens || lineTokens.length === 0) continue;
    for (const token of lineTokens) {
      const from = line.from + token.from;
      const to = line.from + Math.min(token.to, line.length);
      if (from >= to) continue;
      ranges.push({
        from,
        to,
        deco: Decoration.mark({ class: "cm-tm-" + token.cls }),
      });
    }
  }
  if (ranges.length === 0) return Decoration.none;
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(
    ranges.map((r) => r.deco.range(r.from, r.to)),
    true,
  );
}
