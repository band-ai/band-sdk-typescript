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
