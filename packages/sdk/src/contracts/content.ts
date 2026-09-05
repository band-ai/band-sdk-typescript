import { ValidationError } from "../core/errors";
import type { Logger } from "../core/logger";
import type { ToolOperationResult } from "./dtos";

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

// The `status` a message send refused for blank content carries in its
// `ToolOperationResult`, so callers can recognise the refusal by name instead
// of matching the error string.
export const BLANK_CONTENT_STATUS = "blank_content";

// sendMessage is the single choke point every adapter posts a reply through
// (directly or via AdapterToolsProtocol), so this is where a transport-level
// blank-content refusal turns into a real failure instead of a silently
// "successful" {ok: false} result no caller happens to check. A dropped final
// reply is the agent's actual answer going missing, a real correctness bug,
// so it stays fatal -- unlike sendEvent (see withVisibleEventContent below).
export function assertNotBlankContentRefusal(result: ToolOperationResult): ToolOperationResult {
  if (result.status === BLANK_CONTENT_STATUS) {
    throw new ValidationError(typeof result.error === "string" ? result.error : BLANK_CONTENT_ERROR);
  }

  return result;
}

// The stand-in content a chat event gets when it would otherwise be blank.
// Matches band-sdk-python's `_EVENT_EMPTY_CONTENT_PLACEHOLDER` (tools.py) so
// both SDKs produce an identical room record for the same input.
export const EVENT_EMPTY_CONTENT_PLACEHOLDER = "(no content)";

// An event is room telemetry, not the agent's answer -- unlike a blank
// message, a blank event is repaired in place rather than refused, so the
// narration step still lands instead of vanishing from the room (matches
// band-sdk-python's RoomTurnEmitter.emit, which posts every
// tool_call/tool_result/thought/plan chunk unconditionally).
export function withVisibleEventContent(value: string): string {
  return hasVisibleContent(value) ? value : EVENT_EMPTY_CONTENT_PLACEHOLDER;
}

// sendEvent's counterpart to assertNotBlankContentRefusal: an event is room
// telemetry, not the agent's answer, so a transport failure here (a rejected
// promise, e.g. a network error or exhausted retries) must resolve rather
// than abort the caller's turn the way a failed sendMessage does. Blank
// content never reaches this as a refusal -- withVisibleEventContent repairs
// it before the transport call is even made -- so this only ever absorbs a
// genuine transport failure, unrelated to content shape.
export async function resolveEventSend(
  send: () => Promise<ToolOperationResult>,
  logger: Logger,
  logContext: Record<string, unknown>,
): Promise<ToolOperationResult> {
  try {
    return await send();
  } catch (error) {
    logger.warn("chat event send failed", { ...logContext, error });
    return { ok: false, status: "failed" };
  }
}
