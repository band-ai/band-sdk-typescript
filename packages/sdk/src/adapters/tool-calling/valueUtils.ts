import type { ToolCallingModelRequest } from "./types";

export function normalizeConversationRole(
  value: unknown,
): "system" | "user" | "assistant" | null {
  if (value === "system" || value === "user" || value === "assistant") {
    return value;
  }

  return null;
}

/**
 * A mid-conversation system notice as user text. Anthropic and Gemini reject a system role there,
 * and the base prompt tells the model that `[System]:` marks platform updates.
 */
export function systemNoticeAsUserText(content: string): string {
  return `[System]: ${content}`;
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
