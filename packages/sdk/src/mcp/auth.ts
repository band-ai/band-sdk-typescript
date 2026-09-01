import { randomBytes, timingSafeEqual } from "node:crypto";

/** Generates a fresh per-backend bearer token for a loopback MCP server. */
export function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Checks a request's `Authorization` header against a configured bearer token.
 * Comparison is constant-time to avoid leaking the token via response timing.
 * When `authToken` is unset, every request is authorized (auth is opt-in).
 */
export function isAuthorizedRequest(
  authorizationHeader: string | undefined,
  authToken: string | undefined,
): boolean {
  if (!authToken) {
    return true;
  }

  if (!authorizationHeader) {
    return false;
  }

  const expected = Buffer.from(`Bearer ${authToken}`);
  const actual = Buffer.from(authorizationHeader);
  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
