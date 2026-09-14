/**
 * Case-insensitive credential-shaped key names, as raw alternation source
 * rather than a compiled `RegExp`: consumers match this against different
 * shapes of input — `logger.ts` against isolated object keys, the A2A
 * gateway's `sanitizeGatewayErrorMessage` against free-form error text — so
 * each builds its own differently-shaped pattern from this one word list
 * rather than sharing a single compiled regex.
 *
 * Lives here, under `core/`, rather than inside either consumer: neither
 * "structured log context redaction" nor "gateway error text redaction" owns
 * this vocabulary — both sit on top of it.
 *
 * Logger matching is substring-on-key, so `session` cannot live in this list:
 * it would redact ordinary `sessionId` / `sessionID` fields at every log site.
 * Gateway free-text redaction adds `session` separately for `session=` secrets.
 */
export const SENSITIVE_KEY_TERMS = "authorization|api[-_ ]?key|token|secret|password|cookie";

/** Extra gateway-only free-text keys (credential-shaped `session=` values). */
export const GATEWAY_FREE_TEXT_SENSITIVE_KEY_TERMS = `${SENSITIVE_KEY_TERMS}|session`;
