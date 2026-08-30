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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return asOptionalRecord(value) !== undefined;
}

export function asRecordArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter(isRecord);
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
