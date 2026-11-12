import type { AdapterToolsProtocol } from "../../contracts/protocols";
import type { MentionInput, MetadataMap } from "../../contracts/dtos";
import { BAND_TOOL_EFFECTS, isBandToolName } from "../../contracts/toolSchemas";
import type { Logger } from "../../core/logger";
import { overrideTools } from "../../core/overrideTools";
import type { RoomJournal } from "./TurnJournal";

/** Whether `toolName` posts a reply, as band-sdk-core judges each Band tool's effect on its turn. */
function postsReply(toolName: string): boolean {
  return isBandToolName(toolName) && BAND_TOOL_EFFECTS[toolName] === "reply";
}

/**
 * `tools` whose replies to `messageId` are recorded in `journal` before they
 * post: every reply tool call and every plain `sendMessage` (the path an
 * adapter's relayed closing text takes). The record only lets a restart report
 * that a reply may already be in the room; a journal that cannot write it
 * never stops the reply.
 */
export function journalingTools<T extends AdapterToolsProtocol>(
  tools: T,
  journal: RoomJournal,
  messageId: string,
  logger: Logger,
): T {
  const sendMessage = tools.sendMessage.bind(tools);
  const executeToolCall = tools.executeToolCall.bind(tools);

  const recordReply = async (): Promise<void> => {
    await journal.replyBegun(messageId).catch((error: unknown) => {
      logger.warn("Failed to record a reply in the turn journal; posting it anyway", { messageId, error });
    });
  };

  return overrideTools(tools, {
    sendMessage: async (content: string, mentions?: MentionInput) => {
      await recordReply();
      return sendMessage(content, mentions);
    },
    executeToolCall: async (toolName: string, args: MetadataMap) => {
      if (postsReply(toolName)) await recordReply();
      return executeToolCall(toolName, args);
    },
  } as Partial<T>);
}
