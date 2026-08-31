import { vi } from "vitest";

/**
 * Resolves `promise` while draining every fake timer the retry/backoff path
 * schedules along the way — call with `vi.useFakeTimers()` active so a test
 * doesn't have to sit through real backoff delays.
 */
export async function settleThroughRetries<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const outcome = await settled;
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
