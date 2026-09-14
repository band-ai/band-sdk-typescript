import { AgentFailure } from "@band-ai/band-sdk-core";

import { FAILURE_METADATA_KEY } from "../../contracts/protocols";
import { asOptionalRecord, asString } from "../shared/coercion";
import { SENSITIVE_KEY_TERMS } from "../../core/sensitiveTerms";

/** This gateway's `AgentFailure.provider` identity. */
export const PROVIDER = "a2a-gateway";

// Compiled once at module load, not per call: this fires on every gateway
// failure. Matches key=value/key:value credentials in free-form error text —
// see `SENSITIVE_KEY_TERMS`'s doc comment for why this needs its own shape
// rather than sharing a compiled regex with `logger.ts`'s isolated-key match.
const SENSITIVE_VALUE_PATTERN = new RegExp(
  `(${SENSITIVE_KEY_TERMS})"?\\s*[:=]\\s*"?(?:[A-Za-z][\\w-]*\\s+)?[^\\s,;"]+`,
  "gi",
);

/**
 * Builds the `metadata.failure` payload every gateway failure event posts,
 * nested under {@link FAILURE_METADATA_KEY} to match the same convention
 * every other `sendFailure` implementation uses ({@link toFailureEvent} in
 * `contracts/protocols.ts`). `code` overrides the default `error.name`
 * derivation for call sites that know a more specific failure code (e.g. a
 * timeout). `message` overrides the default sanitization of `error`, for a
 * caller that already sanitized it for the event's own `text` field.
 */
export function buildGatewayFailureMetadata(
  error: unknown,
  code?: string,
  message: string = sanitizeGatewayErrorMessage(error),
): Record<string, unknown> {
  return {
    [FAILURE_METADATA_KEY]: new AgentFailure(
      PROVIDER,
      message,
      code ?? (error instanceof Error ? error.name : "UnknownError"),
    ).toObject(),
  };
}

/**
 * Redacts credential-shaped substrings from an upstream error before it
 * reaches an external A2A client. Exported so every failure site in this
 * gateway (including the peer-forwarded relay in `A2AGatewayAdapter`) shares
 * one redaction rule instead of drifting.
 */
export function sanitizeGatewayErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const trimmed = rawMessage.trim();
  if (!trimmed) {
    return "Unknown error";
  }

  // A scheme-prefixed credential like "Authorization: ApiKey sk-..." has a
  // space between the header name and the value, so the value group has to
  // tolerate one optional leading scheme word — but only one: matching
  // everything up to the next comma/semicolon (no whitespace boundary at
  // all) also swallows unrelated trailing prose past the real secret.
  // A JSON-embedded credential quotes both the key and the value
  // (`"api_key":"sk-..."`), so the key/value boundary needs an optional
  // quote on each side — without it the quote right after the key breaks
  // the `[:=]` match and the whole credential survives unredacted.
  const withBearerRedaction = trimmed
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(SENSITIVE_VALUE_PATTERN, "$1=[REDACTED]");

  const maxLength = 240;
  if (withBearerRedaction.length <= maxLength) {
    return withBearerRedaction;
  }

  return `${withBearerRedaction.slice(0, maxLength - 3)}...`;
}

/**
 * Rebuilds a room's own `AgentFailure` (already-serialized via `toObject()`)
 * into the shape safe to forward to an external A2A client: `provider` and
 * `code` are narrow, adapter-chosen identifiers, so they pass through, but
 * `message` gets this gateway's own redaction independently of whatever the
 * originating adapter already did to it, and `detail` — which routinely
 * carries a raw provider payload (an HTTP body, an RPC error object) with no
 * redaction of its own — is dropped rather than forwarded unfiltered.
 */
export function sanitizeForwardedFailure(value: unknown): Record<string, unknown> | undefined {
  const record = asOptionalRecord(value);
  if (!record) {
    return undefined;
  }

  const provider = asString(record.provider) ?? "unknown";
  const code = asString(record.code) ?? undefined;
  const message = sanitizeGatewayErrorMessage(asString(record.message) ?? record.message);
  return new AgentFailure(provider, message, code).toObject();
}
