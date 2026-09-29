import { ValidationError } from "../../core/errors";

/** The longest delay `setTimeout` honours; it silently truncates anything past this to ~1ms. */
export const MAX_SETTIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Rejects a config value past `setTimeout`'s bound rather than let it fire
 * almost at once. The caller decides whether the check applies: a value that
 * is unused, or `Infinity`, may skip it.
 */
export function assertWithinSetTimeoutBound(message: string, value: number): void {
  if (value > MAX_SETTIMEOUT_DELAY_MS) {
    throw new ValidationError(message);
  }
}

/** Validates a `turnTimeoutMs` option: a positive number, or `Infinity` for no limit. */
export function assertTurnTimeoutMs(value: number): void {
  // Reject non-numbers: a string like "3000" passes `Number.isNaN`, then fails
  // `Number.isFinite` and would silently disable the timeout.
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new ValidationError(`turnTimeoutMs must be a positive number or Infinity, got ${value}`);
  }
  if (Number.isFinite(value)) {
    assertWithinSetTimeoutBound(`turnTimeoutMs must be Infinity or at most ${MAX_SETTIMEOUT_DELAY_MS}, got ${value}`, value);
  }
}
