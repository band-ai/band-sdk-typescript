/**
 * Shared teardown-isolation helpers.
 *
 * Used by {@link AgentRuntime}, {@link PlatformRuntime}, and
 * `PhoenixChannelsTransport` to run a sequence of independent teardown steps
 * where one step's failure must not skip the rest, then report the failures
 * collected without masking a lone error's identity.
 */

/** Runs one teardown step, recording its failure instead of propagating it. */
export async function isolateTeardown(errors: unknown[], step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    errors.push(error);
  }
}

/**
 * Collapses the errors collected across isolated teardown steps.
 *
 * A single distinct error is rethrown as-is — so callers that coalesced onto
 * the same teardown still observe one identical `Error` instance — rather
 * than masked inside an `AggregateError` of one. Multiple distinct errors are
 * wrapped in `new AggregateError(distinct, message)`.
 */
export function combineTeardownErrors(errors: unknown[], message: string): unknown {
  const distinct = [...new Set(errors)];
  return distinct.length === 1
    ? distinct[0]
    : new AggregateError(distinct, message);
}
