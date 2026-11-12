import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { BAND_TOOL_EFFECTS } from "../../contracts/toolSchemas";
import type { Logger } from "../../core/logger";
import { overrideTools } from "../../core/overrideTools";
import { gatingReplies } from "../../core/replyGate";
import { bandToolOverrides } from "../../core/turn";
import { cutShort } from "../turnRevocation";

import { bestEffort, type TurnJournal } from "./TurnJournal";

/**
 * `tools` whose replies to `messageId` are recorded just before they post:
 * every Band tool whose effect band-sdk-core judges a reply, called by name or
 * through its direct method (`sendMessage`, the path an adapter's relayed
 * closing text takes). A call refused before its post (invalid arguments, an
 * unknown mention) records nothing. The record only lets a later run report
 * that a reply may already be in the room; a journal that cannot write it
 * never stops the reply. A turn cut short before or while the record is
 * written does not post, and one cut short before records nothing.
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
  stopped: AbortSignal,
  logger: Logger,
): T {
  const refuseIfCutShort = () => {
    const refused = cutShort(stopped);
    if (refused) throw refused;
  };
  const beforePost = async () => {
    // Before the record too: a reply refused anyway must not count as begun, nor reopen a released room.
    refuseIfCutShort();
    await bestEffort(
      async () => (await journals.room(roomId)).replyBegun(messageId),
      logger,
      "Failed to record a reply in the turn journal; posting it anyway",
      { roomId, messageId },
    );
    refuseIfCutShort();
  };
  const overrides = bandToolOverrides(tools, (toolName, call) =>
    BAND_TOOL_EFFECTS[toolName] === "reply" ? gatingReplies(beforePost, call) : call());
  return overrideTools(tools, overrides as Partial<T>);
}
