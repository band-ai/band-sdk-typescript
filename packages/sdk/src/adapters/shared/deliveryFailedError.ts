import type { MentionInput, ToolOperationResult } from "../../contracts/dtos";
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
): Promise<ToolOperationResult> {
  try {
    return await tools.sendMessage(content, mentions);
  } catch (error) {
    throw new DeliveryFailedError(error);
  }
}
