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

export function asErrorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }

  const record = error as { message?: unknown; data?: unknown; cause?: unknown };
  const message = typeof record.message === "string" ? record.message : String(error);
  const detail = record.data ?? record.cause;
  if (detail === undefined || detail === null) {
    return message;
  }

  return `${message} (${formatErrorDetail(detail)})`;
}

function formatErrorDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return detail;
  }

  if (detail instanceof Error) {
    return asErrorMessage(detail);
  }

  const nested = asNestedMessage(detail);
  if (nested !== null) {
    return nested;
  }

  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function asNestedMessage(value: unknown): string | null {
  const record = asOptionalRecord(value);
  return typeof record?.message === "string" ? record.message : null;
}
