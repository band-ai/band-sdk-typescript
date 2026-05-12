const PREFIXED_REDACTION_PATTERNS: RegExp[] = [
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(gateway[-_ ]?token["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[-_ ]?key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(thenvoi[-_ ]?api[-_ ]?key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(authorization["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(x-api-key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /([?&](?:api_?key|token|gateway_?token)=)[^\s&]+/gi,
];

const TOKEN_REDACTION_PATTERNS: RegExp[] = [
  /\btv_[A-Za-z0-9_-]{8,}\b/g,
  /\bthnv_(?:a_|u_)?[A-Za-z0-9_-]{8,}\b/g,
  /\bband_(?:a_|u_)[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bnvapi-[A-Za-z0-9_-]{8,}\b/g,
  /\bhf_[A-Za-z0-9_-]{8,}\b/g,
];

export function redactSecrets(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const pattern of PREFIXED_REDACTION_PATTERNS) {
    text = text.replace(pattern, (_match: string, prefix: string) => `${prefix}[REDACTED]`);
  }
  for (const pattern of TOKEN_REDACTION_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text;
}
