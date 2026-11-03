/** A signal that aborts with `signal` or, when given, `extra`, whichever aborts first. */
export function eitherSignal(signal: AbortSignal, extra?: AbortSignal): AbortSignal {
  return extra ? AbortSignal.any([signal, extra]) : signal;
}
