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

export function hasVisibleContent(value: unknown): boolean {
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
// "successful" {ok: false} result no caller happens to check.
export function assertNotBlankContentRefusal(result: ToolOperationResult): ToolOperationResult {
  if (result?.status === BLANK_CONTENT_STATUS) {
    throw new ValidationError(typeof result.error === "string" ? result.error : BLANK_CONTENT_ERROR);
  }

  return result;
}

// A direct createChatMessage caller (not routed through AgentTools/ContactCallbackTools)
// needs to know the send actually succeeded, not just that it wasn't specifically a
// blank-content refusal -- any other resolved `ok: false` (e.g. moderation) would
// otherwise fall through to a fabricated message id or a silent response timeout.
export function assertMessageSent(result: ToolOperationResult, context: string): ToolOperationResult {
  if (result?.ok === false) {
    const reason = typeof result.error === "string" ? result.error : String(result.status || "unknown error");
    throw new ValidationError(`${context}: ${reason}`);
  }

  return result;
}

// An event is room telemetry, not the agent's answer, so blank content is
// repaired rather than refused. Matches band-sdk-python's
// `_EVENT_EMPTY_CONTENT_PLACEHOLDER`.
export const EVENT_EMPTY_CONTENT_PLACEHOLDER = "(no content)";

export function withVisibleEventContent(value: string): string {
  return hasVisibleContent(value) ? value : EVENT_EMPTY_CONTENT_PLACEHOLDER;
}

// The `status` resolveEventSend's own failure carries, so callers/tests can
// recognise it by name instead of matching a string literal.
export const EVENT_SEND_FAILED_STATUS = "failed";

// Absorbs a thrown transport failure (network error, exhausted retries) so a
// failed sendEvent resolves instead of aborting the turn, the way a failed
// sendMessage does. Only catches thrown errors -- a RestApi that resolves a
// blank-content refusal instead of repairing it (unlike FernRestAdapter, via
// withVisibleEventContent) would pass straight through unchanged.
export async function resolveEventSend(
  send: () => Promise<ToolOperationResult>,
  logger: Logger,
  logContext: Record<string, unknown>,
): Promise<ToolOperationResult> {
  try {
    return await send();
  } catch (error) {
    logger.warn("chat event send failed", { ...logContext, error });
    return { ok: false, status: EVENT_SEND_FAILED_STATUS };
  }
}
