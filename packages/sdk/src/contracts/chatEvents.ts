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

// The platform rejects a chat event whose content has no visible character --
// not merely a plain non-empty check: whitespace-only, zero-width, and
// bidi-mark-only strings pass a naive `.trim().length > 0` test but the
// platform's chat-message changeset still rejects them with "can't be blank"
// (`validate_has_visible_content/2`, delegating to
// `Chat.validate_visible_content/1`). Every letter/number/punctuation/symbol
// counts as visible; every other Unicode category (whitespace, control,
// formatting, marks) does not.
//
// TODO(reconcile with fix/reject-blank-content-before-transport-INT-1372):
// this duplicates that branch's `hasVisibleContent` in
// `contracts/content.ts`, which isn't importable here yet since neither
// branch has merged. Delete this copy and import that one once either lands.
const VISIBLE_CONTENT_PATTERN = /[\p{L}\p{N}\p{P}\p{S}]/u;

export function isBlankEventContent(content: string): boolean {
  return !VISIBLE_CONTENT_PATTERN.test(content);
}
