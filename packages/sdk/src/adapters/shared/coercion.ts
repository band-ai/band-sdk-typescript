import { toLegacyToolExecutorErrorMessage } from "../../contracts/protocols";

export function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function asRecord(value: unknown, context = "value"): Record<string, unknown> {
  const record = asOptionalRecord(value);
  if (!record) {
    throw new TypeError(`Expected ${context} to be an object record.`);
  }

  return record;
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return asString(value);
}

// Use when rendering model/user-facing text where null/undefined should be empty.
export function toDisplayText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value == null) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Use when serializing unknown values for wire/tool payloads.
export function toWireString(value: unknown): string {
  const legacyErrorMessage = toLegacyToolExecutorErrorMessage(value);
  if (legacyErrorMessage !== null) {
    return legacyErrorMessage;
  }

  if (value === undefined || value === null) {
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

// Bounds how many .data/.cause levels asErrorMessage will unwrap — a self-
// referential or pathologically long cause chain must degrade gracefully,
// not overflow the stack (see the "runTurn error reporting" regression test).
const MAX_ERROR_CAUSE_DEPTH = 5;
const MAX_ERROR_DETAIL_LENGTH = 500;

export function asErrorMessage(error: unknown): string {
  return formatCaughtError(error, 0);
}

function formatCaughtError(error: unknown, depth: number): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }

  const record = error as { data?: unknown; cause?: unknown };
  const message = asNestedMessage(error) ?? String(error);
  const detail = record.data ?? record.cause;
  const isBlankDetail = typeof detail === "string" && asNonEmptyString(detail) === null;
  if (detail === undefined || detail === null || isBlankDetail || depth >= MAX_ERROR_CAUSE_DEPTH) {
    return message;
  }

  return `${message} (${formatErrorDetail(detail, depth + 1)})`;
}

// Applies the size cap once, at the single return point, so every branch
// below — including a nested Error's own fully-formatted message/detail —
// is capped the same way, rather than truncating some branches and not others.
function formatErrorDetail(detail: unknown, depth: number): string {
  return truncate(formatErrorDetailText(detail, depth));
}

function formatErrorDetailText(detail: unknown, depth: number): string {
  if (typeof detail === "string") {
    return detail;
  }

  if (typeof detail === "number" && !Number.isFinite(detail)) {
    // JSON.stringify silently coerces NaN/Infinity to the string "null" —
    // keep them visibly distinct from an actually-absent value instead.
    return String(detail);
  }

  if (detail instanceof Error) {
    return formatCaughtError(detail, depth);
  }

  const nested = asNestedMessage(detail);
  if (nested !== null) {
    return nested;
  }

  return toDisplayText(detail);
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_DETAIL_LENGTH
    ? `${text.slice(0, MAX_ERROR_DETAIL_LENGTH)}... (truncated)`
    : text;
}

export function asNestedMessage(value: unknown): string | null {
  const record = asOptionalRecord(value);
  const message = record?.message;
  // A blank message is treated the same as a missing one — an empty string
  // is "present" by strict null-checks but produces the same dangling-
  // parenthetical artifact a genuinely absent message does.
  return typeof message === "string" && asNonEmptyString(message) !== null ? message : null;
}
