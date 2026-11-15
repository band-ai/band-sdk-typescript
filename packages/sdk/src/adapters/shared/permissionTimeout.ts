import { MAX_SETTIMEOUT_DELAY_MS } from "../../core/deadline";
import { ValidationError } from "../../core/errors";
import { assertWithinSetTimeoutBound } from "./withTimeout";

/**
 * Default wait for a human to answer a permission prompt. Same default
 * `OpencodeAdapter` uses for its own manual-approval wait
 * (`approvalWaitTimeoutMs`) — an unanswered request shouldn't hang the
 * agent's turn forever, but should give a human realistic time to notice it.
 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;

/** Validates an optional `permissionTimeoutMs`: omitted uses the default; otherwise a positive finite number within setTimeout's bound. */
export function assertPermissionTimeoutMs(value: number | undefined): void {
  const permissionTimeoutMs = value ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  if (!Number.isFinite(permissionTimeoutMs) || permissionTimeoutMs <= 0) {
    throw new ValidationError(`permissionTimeoutMs must be a positive finite number, got ${value}`);
  }
  assertWithinSetTimeoutBound(`permissionTimeoutMs must be at most ${MAX_SETTIMEOUT_DELAY_MS}, got ${value}`, permissionTimeoutMs);
}
