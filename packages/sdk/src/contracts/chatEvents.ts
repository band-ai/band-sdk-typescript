import { ValidationError } from "../core/errors";

export const CHAT_EVENT_TYPES = ["tool_call", "tool_result", "thought", "error", "task"] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export const CHAT_MESSAGE_TYPES = ["text", ...CHAT_EVENT_TYPES] as const;
export type ChatMessageType = (typeof CHAT_MESSAGE_TYPES)[number];

export function isChatEventType(value: string): value is ChatEventType {
  return (CHAT_EVENT_TYPES as readonly string[]).includes(value);
}

export function assertChatEventType(value: string): asserts value is ChatEventType {
  if (!isChatEventType(value)) {
    throw new ValidationError(
      `Invalid event message_type '${value}'. Expected one of: ${CHAT_EVENT_TYPES.join(", ")}`,
    );
  }
}
