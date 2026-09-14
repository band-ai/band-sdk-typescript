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
    const json = JSON.stringify(value);
    // JSON.stringify returns undefined for functions/symbols; guard against it.
    return typeof json === "string" ? json : String(value);
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
const LENGTH_TRUNCATED_MARKER = "... (truncated)";
const DEPTH_TRUNCATED_MARKER = "... (cause chain truncated)";

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

// Prefers .data (the JSON-RPC convention) over .cause (the native Error
// convention), falling back to .cause when .data is absent or blank instead
// of discarding a genuinely present cause just because .data wasn't useful.
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

// A plain object literal's own keys are its entire content, so an empty one
// carries nothing to show. Date/Map/Set/RegExp/etc. store their real content
// outside own-enumerable keys — treating them the same way would misreport a
// genuinely present value as blank.
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

// An Error-instance detail delegates to formatCaughtError, whose own message
// and further detail are already truncated at their own level — its fully-
// composed "message (detail)" result is never re-truncated here, or a cut
// could land inside its own parenthetical and leave it unbalanced. Every
// other detail shape is a single leaf value, truncated exactly once.
function formatErrorDetail(detail: unknown, depth: number): string {
  if (detail instanceof Error) {
    return formatCaughtError(detail, depth);
  }

  return truncate(formatLeafDetail(detail));
}

function formatLeafDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return detail;
  }

  if (typeof detail === "number" && !Number.isFinite(detail)) {
    // JSON.stringify silently coerces NaN/Infinity to the string "null" —
    // keep them visibly distinct from an actually-absent value instead.
    return String(detail);
  }

  const nested = asNestedMessage(detail);
  if (nested !== null) {
    return nested;
  }

  return toDisplayText(detail);
}

export function truncate(text: string): string {
  return text.length > MAX_ERROR_DETAIL_LENGTH
    ? `${text.slice(0, MAX_ERROR_DETAIL_LENGTH)}${LENGTH_TRUNCATED_MARKER}`
    : text;
}

export function asNestedMessage(value: unknown): string | null {
  const record = asOptionalRecord(value);
  // A blank message is treated the same as a missing one — an empty string
  // is "present" by strict null-checks but produces the same dangling-
  // parenthetical artifact a genuinely absent message does.
  return asNonEmptyString(record?.message);
}
