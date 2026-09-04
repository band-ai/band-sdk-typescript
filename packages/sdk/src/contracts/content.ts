// Mirrors the platform's own rule for what counts as content, rather than a
// plain non-empty check: whitespace-only, zero-width, and bidi-mark-only
// strings pass a naive `.length > 0` test but the platform's chat-message
// changeset still rejects them with "can't be blank"
// (`validate_has_visible_content/2`, delegating to
// `Chat.validate_visible_content/1`). Every letter/number/punctuation/symbol
// counts as visible; every other Unicode category (whitespace, control,
// formatting, marks) does not.
const VISIBLE_CONTENT_PATTERN = /[\p{L}\p{N}\p{P}\p{S}]/u;

export function hasVisibleContent(value: string): boolean {
  // A non-string would stringify into the regex (`undefined` -> "undefined")
  // and read as visible, quietly restoring the platform-422 behaviour this
  // guard exists to prevent.
  return typeof value === "string" && VISIBLE_CONTENT_PATTERN.test(value);
}

// Matches the platform's Ecto changeset error for a blank `:content` field, so
// a caller sees the same wording whether the platform rejected the request or
// the SDK caught it first.
export const BLANK_CONTENT_ERROR = "can't be blank";

// The `status` a send refused for blank content carries in its
// `ToolOperationResult`, so callers can recognise the refusal by name instead
// of matching the error string.
export const BLANK_CONTENT_STATUS = "blank_content";
