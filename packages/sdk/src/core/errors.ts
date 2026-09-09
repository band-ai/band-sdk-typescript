export class BandSdkError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "BandSdkError";
  }
}

export class UnsupportedFeatureError extends BandSdkError {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedFeatureError";
  }
}

export class ValidationError extends BandSdkError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ValidationError";
  }
}

export class TransportError extends BandSdkError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "TransportError";
  }
}

export class RuntimeStateError extends BandSdkError {
  public constructor(message: string) {
    super(message);
    this.name = "RuntimeStateError";
  }
}

/**
 * A failure confined to the turn that raised it. `Execution` keeps the room's
 * loop — and every other room — running for these, where any other error
 * stops the whole runtime.
 *
 * The turn still fails: `PlatformRuntime` has already marked the message
 * failed by the time one of these reaches the queue. What it must not do is
 * take the agent down with it, which is the right response to a broken
 * adapter and the wrong one to a single reply that could not be posted.
 */
export class RecoverableTurnError extends BandSdkError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "RecoverableTurnError";
  }
}

/**
 * Call first in any catch that would otherwise report a provider failure a
 * second time, or misreport a delivery failure as one. Both
 * `DeliveryFailedError` and `ProviderTurnFailedError` mean this turn's
 * outcome is already decided and already reported (or intentionally never
 * reported, for a delivery failure) — rethrowing intact, rather than
 * rebuilding a fresh `AgentFailure` from either's message, is what keeps a
 * terminal-failure branch nested inside a broader try from double-reporting
 * or reclassifying it.
 */
export function rethrowIfRecoverableTurnFailure(error: unknown): void {
  if (error instanceof RecoverableTurnError) {
    throw error;
  }
}
