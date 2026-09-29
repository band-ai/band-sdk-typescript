/**
 * Opt-in SDK logs for a baseline run. Every agent and the room observer log
 * through the SDK's own `Logger`, which resolves to a no-op without one, so a
 * failure that only the SDK's logs explain leaves no trace by default.
 */
import { ConsoleLogger, type Logger } from "../../../src/core/logger";
import { FLAG_ON } from "./registry";

/** Set to `FLAG_ON` to print the SDK's logs, each line stamped with wall-clock time and its source. */
export const DEBUG_LOGS_ENV = "BAND_E2E_DEBUG_LOGS";

/**
 * A logger for `label`'s SDK logs, or `undefined` (the SDK's no-op) unless the
 * flag is set. The wall-clock stamp puts every source's lines and a message's
 * `processed_at` on one axis.
 */
export function debugLogger(label: string, env: NodeJS.ProcessEnv = process.env): Logger | undefined {
  if (env[DEBUG_LOGS_ENV] !== FLAG_ON) {
    return undefined;
  }
  const sink = new ConsoleLogger();
  const stamped = (message: string) => `${new Date().toISOString()} [${label}] ${message}`;
  return {
    debug: (message, context) => sink.debug(stamped(message), context),
    info: (message, context) => sink.info(stamped(message), context),
    warn: (message, context) => sink.warn(stamped(message), context),
    error: (message, context) => sink.error(stamped(message), context),
  };
}
