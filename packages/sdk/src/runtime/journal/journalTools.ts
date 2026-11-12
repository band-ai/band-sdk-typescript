import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { BAND_TOOL_EFFECTS } from "../../contracts/toolSchemas";
import type { Logger } from "../../core/logger";
import { overrideTools } from "../../core/overrideTools";
import { bandToolOverrides } from "../../core/turn";
import { bestEffort, type TurnJournal } from "./TurnJournal";

/**
 * `tools` whose replies to `messageId` are recorded before they post: every
 * Band tool whose effect band-sdk-core judges a reply, called by name or
 * through its direct method (`sendMessage`, the path an adapter's relayed
 * closing text takes). The record only lets a later run report that a reply
 * may already be in the room; a journal that cannot write it never stops the
 * reply.
 *
 * `roomId`'s journal is resolved at each reply, not once per turn: a turn that
 * outlives its room's handling (a reset or leave that stopped waiting for it)
 * records into the journal the room's next execution reads. Once the runtime
 * stopped, `journals` is closed and the reply posts unrecorded.
 */
export function journalingTools<T extends AdapterToolsProtocol>(
  tools: T,
  journals: TurnJournal,
  roomId: string,
  messageId: string,
  logger: Logger,
): T {
  const overrides = bandToolOverrides(tools, async (toolName, call) => {
    if (BAND_TOOL_EFFECTS[toolName] === "reply") {
      await bestEffort(
        async () => (await journals.room(roomId)).replyBegun(messageId),
        logger,
        "Failed to record a reply in the turn journal; posting it anyway",
        { roomId, messageId },
      );
    }
    return call();
  });
  return overrideTools(tools, overrides as Partial<T>);
}
