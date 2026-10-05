import type { ToolOperationResult } from "../../contracts/dtos";
import type { MessagingTools } from "../../contracts/protocols";
import { deliverNotice } from "../../core/deliveryFailedError";

/**
 * Posts adapter-written text to one sender, mentioning them: the platform
 * drops a message that mentions nobody. A notice, so it never counts as the
 * turn's reply.
 */
export async function replyToSender(tools: MessagingTools, content: string, senderId: string): Promise<ToolOperationResult> {
  return deliverNotice(tools, content, [{ id: senderId }]);
}
