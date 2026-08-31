import type { ToolCallingModelRequest } from "./types";

export function normalizeConversationRole(
  value: unknown,
): "system" | "user" | "assistant" | null {
  if (value === "system" || value === "user" || value === "assistant") {
    return value;
  }

  return null;
}

export function mapConversationMessages(
  request: ToolCallingModelRequest,
  mapper: (entry: Record<string, unknown>) => Record<string, unknown> | null,
): Array<Record<string, unknown>> {
  return request.messages
    .map((entry) => mapper(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

/**
 * Merge consecutive messages with the same role by concatenating their content
 * with newlines. Required by APIs (Anthropic, Gemini) that enforce alternating roles.
 *
 * `adapters/shared/history.ts` has a same-purpose `mergeConsecutiveSameRoleTurns`
 * for typed `ChatTurn`s (guaranteed string `content`, a `sender` to preserve on
 * merge); this one folds raw wire-format API messages instead, where `content`
 * may be a content-block array, so it isn't reused here.
 */
export function mergeConsecutiveSameRole(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (messages.length <= 1) {
    return messages;
  }

  const merged: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role && typeof prev.content === "string" && typeof msg.content === "string") {
      prev.content = `${prev.content}\n\n${msg.content}`;
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}
