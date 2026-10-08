import { REDACTED_VALUE, SENSITIVE_KEY_TERMS, redactCredentialText } from "../../src/core/sensitiveTerms";

const SECRET_TERMS = `${SENSITIVE_KEY_TERMS}|credential`;
const SECRET_FIELD = new RegExp(SECRET_TERMS, "i");
const NON_TOKEN_SECRET = new RegExp(SECRET_TERMS.split("|").filter((term) => term !== "token").join("|"), "i");
const TOKEN_COUNT = /(?:tokens|token_?count)$/i;
const CLI_SECRET = new RegExp(`(--(?:${SENSITIVE_KEY_TERMS})(?:=|\\s+))["']?[^\\s"']+["']?`, "gi");
const NAMED_VALUE = /\b([A-Za-z_][\w-]*)(["']?\s*[:=]\s*)(["']?)[^\s,"']+\3/g;

/** Child-process errors and provider messages can embed secrets inside strings. */
export function redactDiagnosticText(text: string, secrets: readonly string[] = []): string {
  let sanitized = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.split(secret).join(REDACTED_VALUE);
  }
  sanitized = redactCredentialText(sanitized.replace(CLI_SECRET, `$1${REDACTED_VALUE}`));
  return sanitized
    .replace(NAMED_VALUE, (match, key: string, separator: string, quote: string) =>
      SECRET_FIELD.test(key) ? `${key}${separator}${quote}${REDACTED_VALUE}${quote}` : match)
    .replace(/\bband_[a-z]_[A-Za-z0-9_-]+\b/g, REDACTED_VALUE)
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g, REDACTED_VALUE);
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
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
      // Numeric usage counters are evidence; credential values are not.
      const isCounter = typeof entry === "number" && TOKEN_COUNT.test(key) && !NON_TOKEN_SECRET.test(key);
      return [key, SECRET_FIELD.test(key) && !isCounter ? REDACTED_VALUE : visit(entry)];
    }));
  };
  return visit(value);
}
