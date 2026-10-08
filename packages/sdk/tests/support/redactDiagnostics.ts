const REDACTED = "[REDACTED]";
const SECRET_FIELD = /(?:api[_-]?key|authorization|password|secret|credential|(?:^|_)access_token$|(?:^|_)refresh_token$)/i;

/** Child-process errors and provider messages can embed secrets inside strings. */
export function redactDiagnosticText(text: string, secrets: readonly string[] = []): string {
  let sanitized = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.split(secret).join(REDACTED);
  }
  return sanitized
    .replace(/\bband_[a-z]_[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\bBearer\s+[^\s"']+/gi, `Bearer ${REDACTED}`)
    .replace(/(--(?:api[-_]?key|token|password|secret)(?:=|\s+))["']?[^\s"']+["']?/gi, `$1${REDACTED}`)
    .replace(/\b((?:[A-Z_]*API_KEY|authorization|password|secret)\s*[:=]\s*)["']?[^\s,"']+["']?/gi, `$1${REDACTED}`);
}

/** One boundary for artifacts, assertion diagnostics and subprocess failures. */
export function redactDiagnostics(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return redactDiagnosticText(item, secrets);
    if (typeof item === "bigint") return String(item);
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    if (item instanceof Error) {
      return visit({ name: item.name, message: item.message, stack: item.stack, cause: item.cause });
    }
    if (Array.isArray(item)) return item.map(visit);
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, SECRET_FIELD.test(key) ? REDACTED : visit(entry)]));
  };
  return visit(value);
}
