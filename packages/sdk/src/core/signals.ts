/** A signal that aborts with `signal` or, when given, `extra`, whichever aborts first. */
export function eitherSignal(signal: AbortSignal, extra?: AbortSignal): AbortSignal {
  return extra ? AbortSignal.any([signal, extra]) : signal;
}

/**
 * Waits for `work` unless `signal` aborts first: resolves false once `work`
 * resolves (rejecting with its error), or true once `signal` aborts. `work`
 * keeps running after an abort; a later failure of it goes to
 * `onAbandonedFailure` rather than going unobserved.
 */
export async function untilStopped(
  work: Promise<unknown>,
  signal: AbortSignal,
  onAbandonedFailure: (error: unknown) => void,
): Promise<boolean> {
  const abandon = (): true => {
    work.catch(onAbandonedFailure);
    return true;
  };
  if (signal.aborted) {
    return abandon();
  }
  let onAbort!: () => void;
  const aborted = new Promise<true>((resolve) => {
    onAbort = () => resolve(abandon());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work.then(() => false), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
