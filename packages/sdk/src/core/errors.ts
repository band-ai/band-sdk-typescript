/**
 * Base class for every error the SDK raises from its own code. Thrown directly when a
 * failure does not fit one of the specific classes below — for example an unhandled member
 * of a discriminated union. Catch this to catch anything the SDK threw deliberately.
 */
export class BandSdkError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "BandSdkError";
  }
}

/**
 * Thrown when a requested capability is not available: an optional peer SDK is not
 * installed or is missing an export the adapter needs, the host runtime lacks a required
 * built-in, or a backend does not implement the operation being asked for.
 */
export class UnsupportedFeatureError extends BandSdkError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "UnsupportedFeatureError";
  }
}

/**
 * Thrown when caller-supplied input is unusable: missing or malformed credentials and
 * configuration, an argument that fails a tool's schema, or a value outside its allowed set.
 */
export class ValidationError extends BandSdkError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ValidationError";
  }
}

/**
 * Thrown when communication with the Band platform fails: a WebSocket connect, join or
 * leave that errors or times out, or a REST call the client could not complete.
 */
export class TransportError extends BandSdkError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "TransportError";
  }
}

/**
 * Thrown when an operation is attempted in the wrong state: using a client or adapter that
 * has not been started or initialized, or exceeding a runtime limit such as the maximum
 * number of concurrent sessions.
 */
export class RuntimeStateError extends BandSdkError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "RuntimeStateError";
  }
}

/** Message of an unknown thrown value, for interpolation into logs and diagnostics. */
export function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/** Structured-logging payload for an unknown thrown value. */
export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const payload: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };

  const { retryable } = error as { retryable?: unknown };
  if (retryable !== undefined) {
    payload.retryable = retryable;
  }

  return payload;
}

/**
 * Exhaustiveness guard for discriminated unions. Lives beside `BandSdkError` because the
 * only thing it does is throw one when a union grows a member a switch does not handle.
 *
 * @param context - what the unhandled value is, e.g. `"contact event"`.
 */
export function assertNever(value: never, context = "value"): never {
  throw new BandSdkError(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
