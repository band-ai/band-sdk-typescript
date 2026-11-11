/** A signal that aborts with `signal` or, when given, `extra`, whichever aborts first. */
export function eitherSignal(signal: AbortSignal, extra?: AbortSignal): AbortSignal {
  return extra ? AbortSignal.any([signal, extra]) : signal;
}

/**
 * Waits for `work` unless `signal` aborts first: resolves null once `work`
 * resolves (rejecting with its error), or the abort's reason once `signal`
 * aborts. `work` keeps running after an abort; a later failure of it goes to
 * `onAbandonedFailure` rather than going unobserved.
 */
export async function untilStopped<R>(
  work: Promise<unknown>,
  signal: AbortSignal,
  onAbandonedFailure: (error: unknown) => void,
): Promise<R | null> {
  const abandon = (): R => {
    work.catch(onAbandonedFailure);
    return signal.reason as R;
  };
  if (signal.aborted) {
    return abandon();
  }
  let onAbort!: () => void;
  const aborted = new Promise<R>((resolve) => {
    onAbort = () => resolve(abandon());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work.then(() => null), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
