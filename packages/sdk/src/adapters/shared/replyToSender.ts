import type { ToolOperationResult } from "../../contracts/dtos";
import type { MessagingTools } from "../../contracts/protocols";
import { deliverReply } from "../../core/deliveryFailedError";

/** Replies to one sender, mentioning them: the platform drops a message that mentions nobody. */
export async function replyToSender(tools: MessagingTools, content: string, senderId: string): Promise<ToolOperationResult> {
  return deliverReply(tools, content, [{ id: senderId }]);
}
