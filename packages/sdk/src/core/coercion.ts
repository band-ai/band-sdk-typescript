/** Reduces any thrown/rejected value to a display-safe message string. */

const MAX_ERROR_CAUSE_DEPTH = 5;
const MAX_ERROR_DETAIL_LENGTH = 500;
const LENGTH_TRUNCATED_MARKER = "... (truncated)";
const DEPTH_TRUNCATED_MARKER = "... (cause chain truncated)";

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toDisplayText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    const json = JSON.stringify(value);
    // JSON.stringify returns undefined for functions/symbols; guard against it.
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

export function asErrorMessage(error: unknown): string {
  return formatCaughtError(error, 0);
}

function formatCaughtError(error: unknown, depth: number): string {
  if (typeof error !== "object" || error === null) {
    return truncate(String(error));
  }

  const message = truncate(asNestedMessage(error) ?? String(error));
  const detail = selectDetail(asOptionalRecord(error));
  if (detail === undefined) {
    return message;
  }

  if (depth >= MAX_ERROR_CAUSE_DEPTH) {
    return `${message} (${DEPTH_TRUNCATED_MARKER})`;
  }

  return `${message} (${formatErrorDetail(detail, depth + 1)})`;
}

function selectDetail(record: Record<string, unknown> | undefined): unknown {
  if (isPresentDetail(record?.data)) {
    return record?.data;
  }
  if (isPresentDetail(record?.cause)) {
    return record?.cause;
  }
  return undefined;
}

function isPresentDetail(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return asNonEmptyString(value) !== null;
  }
  if (value instanceof Error) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return isPlainObject(value) ? Object.keys(value).length > 0 : true;
  }
  return true;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function formatErrorDetail(detail: unknown, depth: number): string {
  if (detail instanceof Error || selectDetail(asOptionalRecord(detail)) !== undefined) {
    return formatCaughtError(detail, depth);
  }
  return truncate(formatLeafDetail(detail));
}

function formatLeafDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return detail;
  }
  if (typeof detail === "number" && !Number.isFinite(detail)) {
    return String(detail);
  }
  const builtin = formatNonEnumerableDetail(detail);
  if (builtin !== null) {
    return builtin;
  }
  const nested = asNestedMessage(detail);
  if (nested !== null) {
    return nested;
  }
  return toDisplayText(detail);
}

function formatNonEnumerableDetail(detail: unknown): string | null {
  if (detail instanceof RegExp) {
    return detail.toString();
  }
  if (detail instanceof Map) {
    return `Map ${toDisplayText([...detail])}`;
  }
  if (detail instanceof Set) {
    return `Set ${toDisplayText([...detail])}`;
  }
  return null;
}

export function truncate(text: string): string {
  return text.length > MAX_ERROR_DETAIL_LENGTH
    ? `${text.slice(0, MAX_ERROR_DETAIL_LENGTH)}${LENGTH_TRUNCATED_MARKER}`
    : text;
}

export function asNestedMessage(value: unknown): string | null {
  const record = asOptionalRecord(value);
  return asNonEmptyString(record?.message);
}
