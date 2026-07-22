export interface AbortableTaskHandle {
  cancel: () => void;
  signal: AbortSignal;
}

export function scheduleAbortableTask(
  task: (signal: AbortSignal) => void,
  delayMs: number,
): AbortableTaskHandle {
  const controller = new AbortController();
  const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) task(controller.signal);
  }, delay);

  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      controller.abort();
    },
  };
}
