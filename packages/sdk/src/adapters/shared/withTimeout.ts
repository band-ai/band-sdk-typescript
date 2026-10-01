import { ValidationError } from "../../core/errors";

/** The longest delay `setTimeout` honours; it silently truncates anything past this to ~1ms. */
export const MAX_SETTIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Rejects a config value past `setTimeout`'s bound rather than let it fire
 * almost at once. The caller decides whether the check applies: a value that
 * is unused, or `Infinity`, may skip it.
 */
export function assertWithinSetTimeoutBound(message: string, value: number): void {
  if (value > MAX_SETTIMEOUT_DELAY_MS) {
    throw new ValidationError(message);
  }
}

// Bounds a promise that has no timeout of its own — the underlying work
// isn't cancelled (there's often no way to), only stopped waiting on.
//
// `onTimeout` is a plain message by default; pass a factory instead when a
// caller needs a specific error type (e.g. to `instanceof`-check it later).
//
// `timeoutMs` of `Infinity` (a caller's way of saying "unbounded") skips the
// race outright: `setTimeout` itself coerces `Infinity` to 1ms, so passing it
// through would fire the timeout almost immediately instead of never.
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: string | (() => Error),
): Promise<T> {
  if (!Number.isFinite(timeoutMs)) {
    return promise
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(typeof onTimeout === "function" ? onTimeout() : new Error(onTimeout)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
