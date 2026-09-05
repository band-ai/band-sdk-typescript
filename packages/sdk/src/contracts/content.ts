import { ValidationError } from "../core/errors";
import type { Logger } from "../core/logger";
import type { ToolOperationResult } from "./dtos";

// Mirrors platform `Chat.validate_visible_content/1`: letters, numbers, punctuation,
// and symbols count as visible; whitespace/control/formatting/mark categories don't.
// A naive `.length > 0` check would wrongly pass whitespace-only or zero-width strings.
const VISIBLE_CONTENT_PATTERN = /[\p{L}\p{N}\p{P}\p{S}]/u;

// An adapter must guard an unconditional sendMessage with this: invisible-only text throws
// downstream, and most callers have no surrounding try/catch (or one that rethrows after
// logging), so an unguarded call can kill the room or the whole runtime.
export function hasVisibleContent(value: unknown): value is string {
  // A non-string coerces into the regex ("undefined" reads as visible), so the type is guarded first.
  return typeof value === "string" && VISIBLE_CONTENT_PATTERN.test(value);
}

// Matches the platform's Ecto changeset error text so callers see identical wording
// whether the platform rejected the request or the SDK caught it first.
export const BLANK_CONTENT_ERROR = "can't be blank";

// Lets callers recognize a blank-content refusal by status instead of matching the error string.
export const BLANK_CONTENT_STATUS = "blank_content";

// sendMessage is the one choke point every adapter posts through, so this is where a
// blank-content refusal becomes a thrown error instead of a silently-ignored {ok: false}.
export function assertNotBlankContentRefusal(result: ToolOperationResult): ToolOperationResult {
  if (result?.status === BLANK_CONTENT_STATUS) {
    throw new ValidationError(typeof result.error === "string" ? result.error : BLANK_CONTENT_ERROR);
  }

  return result;
}

// For callers outside AgentTools/ContactCallbackTools: any resolved ok:false (not just
// blank content, e.g. moderation) must surface here or it reads as a fabricated send.
export function assertMessageSent(result: ToolOperationResult, context: string): ToolOperationResult {
  if (result?.ok === false) {
    const reason = typeof result.error === "string" ? result.error : String(result.status || "unknown error");
    throw new ValidationError(`${context}: ${reason}`);
  }

  return result;
}

// Events are room telemetry, not the agent's answer, so blank content is repaired,
// not refused. The placeholder string matches band-sdk-python's
// `_EVENT_EMPTY_CONTENT_PLACEHOLDER`, but the trigger condition is broader here:
// band-sdk-python's `send_event` substitutes only on an empty string (`if not content`),
// while `withVisibleEventContent` below also substitutes for whitespace-only, zero-width,
// and bidi-mark-only content.
export const EVENT_EMPTY_CONTENT_PLACEHOLDER = "(no content)";

export function withVisibleEventContent(value: string): string {
  return hasVisibleContent(value) ? value : EVENT_EMPTY_CONTENT_PLACEHOLDER;
}

// Lets callers/tests recognize resolveEventSend's own failure by status instead of a string literal.
export const EVENT_SEND_FAILED_STATUS = "failed";

// Absorbs a thrown transport failure so sendEvent resolves {ok: false} instead of aborting
// the turn. Only catches throws -- a RestApi that resolves a blank-content refusal instead
// of repairing it would still pass straight through unchanged. A caller-supplied logger that
// itself throws must not turn this telemetry failure into a rejection in its place.
export async function resolveEventSend(
  send: () => Promise<ToolOperationResult>,
  logger: Logger,
  logContext: Record<string, unknown>,
): Promise<ToolOperationResult> {
  try {
    return await send();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      logger.warn("chat event send failed", { ...logContext, error });
    } catch {
      // See function comment.
    }
    return { ok: false, status: EVENT_SEND_FAILED_STATUS, message };
  }
}
