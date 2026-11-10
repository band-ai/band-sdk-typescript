/**
 * Calls every listener with `value`, over a snapshot so a listener may
 * unsubscribe mid-call. One that throws, or returns a promise that rejects,
 * is handed to `onError` and never stops the rest.
 */
export function notifyEach<T>(
  listeners: Iterable<(value: T) => unknown>,
  value: T,
  onError: (error: unknown) => void,
): void {
  for (const listener of [...listeners]) {
    try {
      const result = listener(value);
      if (result instanceof Promise) {
        result.catch(onError);
      }
    } catch (error) {
      onError(error);
    }
  }
}

/** Adds `listener` to `listeners`; the returned function removes it. */
export function subscribe<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
