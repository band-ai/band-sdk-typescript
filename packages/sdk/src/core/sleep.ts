/**
 * Resolves after `ms` milliseconds. Used by the retry/backoff paths across the SDK.
 *
 * When a signal is supplied the wait ends as soon as it aborts, so a caller that cancels
 * mid-backoff does not have to wait out the remaining delay. Aborting resolves rather than
 * rejects; callers decide what an aborted wait means for them.
 */
export async function sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void> {
  const signal = options?.signal;
  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const settle = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolve();
    };

    const timer = setTimeout(settle, ms);
    signal?.addEventListener("abort", settle, { once: true });
  });
}
