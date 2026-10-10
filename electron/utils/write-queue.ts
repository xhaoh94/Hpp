const queues = new Map<string, Promise<void>>();

/** 进程内按 key 串行化读改写/写入，避免不同 IPC 入口覆盖彼此的最新快照。 */
export function queueNamedWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(() => undefined, () => undefined);
  queues.set(key, tail);
  return current.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
}
