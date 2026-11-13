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
 * Band refused a message claim, acknowledgement or post because it has
 * stopped the agent in the room (`agent.control` stop). It describes that
 * request: the room may since have been played again.
 */
export class RoomExecutionStoppedError extends BandSdkError {
  public constructor(public readonly roomId: string, cause?: unknown) {
    super(`Band has stopped the agent in room ${roomId}`, cause);
    this.name = "RoomExecutionStoppedError";
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

export const HTTP_NO_CONTENT = 204;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_REQUEST_TIMEOUT = 408;
export const HTTP_UNPROCESSABLE = 422;
export const HTTP_TOO_MANY_REQUESTS = 429;
export const HTTP_SERVER_ERROR = 500;

/** Whether `error` is an HTTP failure from the REST client carrying `statusCode`. */
export function hasStatusCode(error: unknown, statusCode: number): boolean {
  return statusCodeOf(error) === statusCode;
}

/** The HTTP status a REST client failure carries, or undefined when no response arrived. */
export function statusCodeOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;
}
