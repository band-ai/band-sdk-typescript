import type { MentionInput } from "../../contracts/dtos";
import type { MessagingTools } from "../../contracts/protocols";
import { RecoverableTurnError } from "../../core/errors";
import { asErrorMessage } from "./coercion";

/**
 * Marks a rejection as coming from delivering an already-decided reply, not
 * from the provider itself.
 *
 * `RecoverableTurnError`, because failing to post one reply is a failure of
 * that turn and nothing more: the runtime marks the message failed and keeps
 * every room serving. Reporting it as an `AgentFailure` would blame the
 * provider for a Band-side fault; taking the runtime down would answer a
 * transient post failure with an outage.
 */
export class DeliveryFailedError extends RecoverableTurnError {
  constructor(public readonly cause: unknown) {
    super(asErrorMessage(cause), cause);
    this.name = "DeliveryFailedError";
  }
}

export async function deliverReply(
  tools: MessagingTools,
  content: string,
  mentions: MentionInput = [],
): Promise<void> {
  try {
    await tools.sendMessage(content, mentions);
  } catch (error) {
    throw new DeliveryFailedError(error);
  }
}

/**
 * Call first in any catch that would otherwise report a provider failure, and
 * in any intermediate catch a delivery failure must travel through. Failing to
 * deliver an answer the provider already produced is not a provider failure:
 * rethrowing rejects the turn, so the runtime marks the message failed instead
 * of reporting an `AgentFailure` and losing the answer.
 *
 * The marker is rethrown intact, never unwrapped to its cause — it already
 * carries the cause's message, and both `Execution` and every catch further
 * out need the type to tell this apart from a provider failure.
 */
export function rethrowIfDeliveryFailure(error: unknown): void {
  if (error instanceof DeliveryFailedError) {
    throw error;
  }
}
