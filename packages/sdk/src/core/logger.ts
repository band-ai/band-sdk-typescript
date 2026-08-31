/**
 * Structured logging sink the SDK writes to instead of `console`. Every level takes a
 * short event name plus an optional context object, so hosts can forward SDK activity to
 * whatever logger they already run. Pass an implementation via an adapter's or runtime's
 * `logger` option; the default is {@link NoopLogger}.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noop = (): void => undefined;
const REDACTED_VALUE = "[REDACTED]";
const CIRCULAR_VALUE = "[Circular]";
const SENSITIVE_KEY_PATTERN = /(authorization|api[-_]?key|token|secret|password|cookie)/i;

/** {@link Logger} that discards everything. The SDK's default, so it is silent unless asked. */
export class NoopLogger implements Logger {
  public debug = noop;
  public info = noop;
  public warn = noop;
  public error = noop;
}

/**
 * {@link Logger} that writes to the console — `error` to stderr, the rest through the
 * matching `console` method. Context objects are serialized with values under
 * authorization/key/token/secret/password/cookie keys redacted.
 */
export class ConsoleLogger implements Logger {
  public debug(message: string, context?: Record<string, unknown>): void {
    this.emit("debug", message, context);
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.emit("info", message, context);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.emit("warn", message, context);
  }

  public error(message: string, context?: Record<string, unknown>): void {
    const payload = context ? ` ${safeSerializeContext(context)}` : "";
    process.stderr.write(`${message}${payload}\n`);
  }

  private emit(
    level: "debug" | "info" | "warn",
    message: string,
    context?: Record<string, unknown>,
  ): void {
    // eslint-disable-next-line no-console -- ConsoleLogger is the intended consumer of console methods.
    const fn = console[level];
    if (context === undefined) {
      fn(message);
      return;
    }
    fn(message, sanitizeValue(context));
  }
}

function safeSerializeContext(context: Record<string, unknown>): string {
  try {
    return JSON.stringify(sanitizeValue(context));
  } catch {
    return JSON.stringify({ context: "[Unserializable]" });
  }
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (value instanceof Error) {
    return sanitizeValue(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
        ...(value.cause !== undefined ? { cause: value.cause } : {}),
      },
      seen,
    );
  }

  if (seen.has(value)) {
    return CIRCULAR_VALUE;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED_VALUE
      : sanitizeValue(entry, seen);
  }
  return sanitized;
}
