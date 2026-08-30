import { asNonEmptyString } from "../adapters/shared/coercion";

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
  toolCallId: string;
}

export interface ParsedToolResult {
  name: string;
  output: string;
  toolCallId: string;
  isError: boolean;
}

export function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseToolPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseToolCall(value: unknown): ParsedToolCall | null {
  const parsed = parseToolPayload(value);
  const name = asNonEmptyString(parsed?.name);
  const toolCallId = asNonEmptyString(parsed?.tool_call_id);

  if (!name || !toolCallId) {
    return null;
  }

  const args = parsed?.args;
  return {
    name,
    toolCallId,
    args: args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {},
  };
}

export function parseToolResult(value: unknown): ParsedToolResult | null {
  const parsed = parseToolPayload(value);
  const name = asNonEmptyString(parsed?.name);
  const toolCallId = asNonEmptyString(parsed?.tool_call_id);

  if (!name || !toolCallId) {
    return null;
  }

  return {
    name,
    toolCallId,
    output: parsed?.output === undefined ? "" : String(parsed.output),
    isError: parsed?.is_error === true,
  };
}
