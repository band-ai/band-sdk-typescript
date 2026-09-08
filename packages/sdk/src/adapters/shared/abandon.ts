/**
 * Starts a call on a peer we have already given up on, without waiting for it.
 *
 * A turn that timed out must free its room whether or not the agent ever
 * answers again: an agent that stopped draining its stdin, or a server that
 * stopped answering HTTP, leaves a cancel/abort pending forever, and awaiting
 * it would block the very cleanup and failure report the timeout exists to
 * produce. Nothing reads the result, so there is nothing to bound it with.
 *
 * The `Promise.resolve()` hop is load-bearing: `operation` is a peer's
 * caller-supplied method and may throw *synchronously*, which a bare
 * `void operation().catch(...)` would let escape uncaught.
 */
export function abandon(
  operation: () => Promise<unknown>,
  onError: (error: unknown) => void = () => undefined,
): void {
  void Promise.resolve().then(operation).catch(onError);
}
