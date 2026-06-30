import type { BrowserWindow } from "electron";

type StreamEventType = "stream_delta" | "thinking_delta";
type AgentEvent = { type: string; [key: string]: unknown };

const STREAM_FLUSH_INTERVAL_MS = 50;
const MAX_BUFFERED_CHARS = 4000;

export class AgentEventBuffer {
  private window: BrowserWindow | null = null;
  private readonly hppSessionId: string;
  private queue: Array<{ type: StreamEventType; delta: string }> = [];
  private bufferedChars = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(hppSessionId: string) {
    this.hppSessionId = hppSessionId;
  }

  setWindow(win: BrowserWindow) {
    this.window = win;
  }

  send(data: unknown) {
    if (this.isStreamDelta(data)) {
      this.enqueueDelta(data.type, String(data.delta || ""));
      return;
    }

    this.flush();
    this.sendNow(data);
  }

  flush() {
    this.clearTimer();
    while (this.queue.length > 0) {
      const event = this.queue.shift()!;
      this.sendNow(event);
    }
    this.bufferedChars = 0;
  }

  clear() {
    this.clearTimer();
    this.queue = [];
    this.bufferedChars = 0;
  }

  private enqueueDelta(type: StreamEventType, delta: string) {
    if (!delta) return;

    const last = this.queue[this.queue.length - 1];
    if (last?.type === type) {
      last.delta += delta;
    } else {
      this.queue.push({ type, delta });
    }

    this.bufferedChars += delta.length;
    if (this.bufferedChars >= MAX_BUFFERED_CHARS) {
      this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), STREAM_FLUSH_INTERVAL_MS);
    }
  }

  private sendNow(data: unknown) {
    const payload =
      data && typeof data === "object"
        ? { ...(data as Record<string, unknown>), sessionId: this.hppSessionId }
        : data;
    this.window?.webContents.send("agent:event", payload);
  }

  private isStreamDelta(data: unknown): data is { type: StreamEventType; delta?: unknown } {
    if (!data || typeof data !== "object") return false;
    const type = (data as AgentEvent).type;
    return type === "stream_delta" || type === "thinking_delta";
  }

  private clearTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
