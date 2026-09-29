import { ValidationError } from "../../core/errors";
import { MAX_SETTIMEOUT_DELAY_MS, assertWithinSetTimeoutBound } from "./withTimeout";

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
