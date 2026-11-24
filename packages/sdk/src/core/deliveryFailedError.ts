import type { MentionInput, ToolOperationResult } from "../contracts/dtos";
import { isToolExecutorError, toolExecutionError, type MessagingTools, type ToolExecutorError } from "../contracts/protocols";
import { RecoverableTurnError } from "./errors";
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

/**
 * A reply whose delivery is unknown: the transport neither accepted nor
 * refused it (a 5xx, no response, or an unreadable response). It extends the
 * delivery failure so direct call sites and failure reports keep working, but
 * its own text states what the state means: Band may already hold the message,
 * so resending it blindly could post it twice.
 */
export class DeliveryUnknownError extends DeliveryFailedError {
  public static readonly KIND = "delivery_unknown" as const;

  public readonly kind: typeof DeliveryUnknownError.KIND = DeliveryUnknownError.KIND;

  constructor(
    cause: unknown,
    public readonly publicationId?: string,
  ) {
    super(cause);
    this.name = "DeliveryUnknownError";
    this.message =
      "The reply's delivery is unknown: Band may already hold it, so it must not be resent. The turn journal records the reply as unknown; a process that reopens the room reports it without reposting it.";
  }
}

/**
 * An unknown delivery as a tool result: the classification rides in
 * `details`, so an MCP result or a direct ToolExecutorError tells callers
 * Band may already hold the message.
 */
export function deliveryUnknownToolError(toolName: string, error: DeliveryUnknownError): ToolExecutorError {
  return toolExecutionError(toolName, error.message, { kind: DeliveryUnknownError.KIND, publicationId: error.publicationId });
}

/** A tool result whose `details` classify the delivery as unknown. */
type DeliveryUnknownOutput = ToolExecutorError & { details: { kind: typeof DeliveryUnknownError.KIND } };

/**
 * True when a tool or MCP result says delivery is unknown: Band may already
 * hold the post, so a same-content retry must not POST again.
 */
export function isDeliveryUnknownOutput(value: unknown): value is DeliveryUnknownOutput {
  return isToolExecutorError(value) && value.details?.kind === DeliveryUnknownError.KIND;
}

/** Publication id carried on a delivery_unknown tool result, when present. */
export function deliveryUnknownPublicationId(value: unknown): string | undefined {
  if (!isDeliveryUnknownOutput(value)) return undefined;
  const publicationId = value.details?.publicationId;
  return typeof publicationId === "string" ? publicationId : undefined;
}

async function delivered(post: () => Promise<ToolOperationResult>): Promise<ToolOperationResult> {
  try {
    return await post();
  } catch (error) {
    // A classified failure stays classified: rewrapping an unknown would let
    // a caller retry the same content blindly.
    if (error instanceof DeliveryFailedError) throw error;
    throw new DeliveryFailedError(error);
  }
}

/** Posts the turn's reply; on a judged turn it counts as the reply. */
export async function deliverReply(
  tools: MessagingTools,
  content: string,
  mentions: MentionInput,
): Promise<ToolOperationResult> {
  return delivered(() => tools.sendMessage(content, mentions));
}

/** Posts text the adapter writes itself; it never counts as the turn's reply. */
export async function deliverNotice(
  tools: MessagingTools,
  content: string,
  mentions: MentionInput,
): Promise<ToolOperationResult> {
  return delivered(() => tools.sendNotice(content, mentions));
}
