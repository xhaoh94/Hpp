type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (timer: TimerHandle) => void;

export type PersistenceTimerKey =
  | "models"
  | "projects"
  | "messages"
  | "streamingMessages";

export class PersistenceFlushScheduler {
  private timers = new Map<PersistenceTimerKey, TimerHandle>();

  constructor(
    private readonly setTimer: SetTimer = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    private readonly clearTimer: ClearTimer = (timer) => globalThis.clearTimeout(timer)
  ) {}

  has(key: PersistenceTimerKey) {
    return this.timers.has(key);
  }

  clear(key: PersistenceTimerKey) {
    const timer = this.timers.get(key);
    if (!timer) return;
    this.clearTimer(timer);
    this.timers.delete(key);
  }

  clearMany(keys: PersistenceTimerKey[]) {
    keys.forEach((key) => this.clear(key));
  }

  schedule(
    key: PersistenceTimerKey,
    delayMs: number,
    callback: () => void,
    options: { reset?: boolean } = {}
  ) {
    if (options.reset === false && this.timers.has(key)) return;

    this.clear(key);
    const timer = this.setTimer(() => {
      this.timers.delete(key);
      callback();
    }, delayMs);
    this.timers.set(key, timer);
  }
}
