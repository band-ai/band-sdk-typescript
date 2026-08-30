export class BandSdkError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "BandSdkError";
  }
}

export class UnsupportedFeatureError extends BandSdkError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
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
