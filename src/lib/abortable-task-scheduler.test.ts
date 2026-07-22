import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleAbortableTask } from "./abortable-task-scheduler";

describe("abortable task scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs only after the debounce delay", () => {
    vi.useFakeTimers();
    const task = vi.fn();

    scheduleAbortableTask(task, 100);
    vi.advanceTimersByTime(99);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
    expect(task.mock.calls[0][0].aborted).toBe(false);
  });

  it("cancels pending work and aborts work that already started", () => {
    vi.useFakeTimers();
    const pendingTask = vi.fn();
    const pending = scheduleAbortableTask(pendingTask, 100);
    pending.cancel();
    vi.runAllTimers();
    expect(pendingTask).not.toHaveBeenCalled();
    expect(pending.signal.aborted).toBe(true);

    let runningSignal: AbortSignal | undefined;
    const running = scheduleAbortableTask((signal) => { runningSignal = signal; }, 100);
    vi.advanceTimersByTime(100);
    running.cancel();
    expect(runningSignal?.aborted).toBe(true);
  });
});
