import { SENSITIVE_KEY_TERMS } from "./sensitiveTerms";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noop = (): void => undefined;
const REDACTED_VALUE = "[REDACTED]";
const CIRCULAR_VALUE = "[Circular]";
const SENSITIVE_KEY_PATTERN = new RegExp(`(${SENSITIVE_KEY_TERMS})`, "i");

export class NoopLogger implements Logger {
  public debug = noop;
  public info = noop;
  public warn = noop;
  public error = noop;
}

/**
 * Wraps a caller-supplied logger so a throwing implementation cannot replace
 * the failure being logged. Nearly every log call in the SDK sits in a `catch`
 * or on a failure path, where a throw from the logger would take the place of
 * the error it was reporting — or, from a floating `catch`, become an
 * unhandled rejection instead of it.
 *
 * Use this wherever an optional caller-supplied `Logger` enters the SDK, so
 * the guard lives here once rather than at each site that remembers it.
 *
 * Adoption is deliberately partial: every adapter entry point and `Execution`
 * are converted, because those log from inside the failure paths this
 * feature added. Thirteen entry points under `runtime/`, `platform/`,
 * `integrations/` and `client/` still build their logger with
 * `?? new NoopLogger()` — a known, pre-existing inconsistency tracked
 * separately, not an oversight to report.
 */
export function resolveLogger(logger?: Logger): Logger {
  if (!logger) {
    return new NoopLogger();
  }

  // Idempotent: a logger a caller already passed through this once (e.g. an
  // adapter wrapping its own `options.logger` before handing it to an inner
  // client that resolves it again) must not gain a second, redundant guard
  // layer — this is the single place that guarantee is meant to hold.
  return logger instanceof GuardedLogger ? logger : new GuardedLogger(logger);
}

class GuardedLogger implements Logger {
  public constructor(private readonly inner: Logger) {}

  public debug(message: string, context?: Record<string, unknown>): void {
    return this.emit("debug", message, context);
  }

  public info(message: string, context?: Record<string, unknown>): void {
    return this.emit("info", message, context);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    return this.emit("warn", message, context);
  }

  public error(message: string, context?: Record<string, unknown>): void {
    return this.emit("error", message, context);
  }

  private emit(
    level: keyof Logger,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    try {
      // `Logger.warn` etc. are typed `void`, but an `async` implementation
      // still returns a real promise at runtime — typed `unknown` here, not
      // the declared `void`, so the `instanceof` check below can see it.
      // Attaching a swallowing catch — rather than trusting every
      // fire-and-forget call site to do it — is what keeps a rejecting
      // caller-supplied logger from becoming an unhandled rejection on the
      // failure path it was reporting. The original promise is still
      // returned so a caller that wants to await completion can do so; this
      // attaches an additional, harmless handler rather than replacing it.
      const result: unknown = this.inner[level](message, context);
      if (result instanceof Promise) {
        result.catch(noop);
      }
      return result as void;
    } catch {
      // Swallowed deliberately — see resolveLogger.
    }
  }
}

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
