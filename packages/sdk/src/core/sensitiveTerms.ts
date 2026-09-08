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
 */
export const SENSITIVE_KEY_TERMS = "authorization|api[-_]?key|token|secret|password|cookie";
