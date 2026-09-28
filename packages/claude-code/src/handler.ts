import type { PlatformEvent } from "@band-ai/sdk";
import type { Logger } from "@band-ai/sdk/core";

import type { AckTracker } from "./ack.js";
import { sanitizeMeta, shouldForwardMessage, type SelfIdentity } from "./gating.js";
import type { LastSenderTracker, RoomParticipant } from "./mentions.js";

export interface MessageHandlerDeps {
  self: SelfIdentity;
  ownerId: string | null;
  allowedSenderIds: ReadonlySet<string>;
  listParticipants: (roomId: string) => Promise<RoomParticipant[]>;
  ackTracker: AckTracker;
  lastSenderTracker: LastSenderTracker;
  notify: (content: string, meta: Record<string, string>) => Promise<void>;
  logger: Logger;
}

/**
 * Build `AgentRuntime`'s `onExecute` handler. There is nothing in a
 * `PlatformEvent` that marks it as arriving via a live WebSocket push versus
 * a reconnect's `/messages/next` catch-up sweep — `AgentRuntime` routes both
 * through the exact same `onExecute` call, so this handler needs no special
 * case for either: gating, the ack lifecycle, and the mention-fallback
 * tracking below all apply identically regardless of how the event arrived.
 */
export function createMessageHandler(deps: MessageHandlerDeps) {
  const { self, ownerId, allowedSenderIds, listParticipants, ackTracker, lastSenderTracker, notify, logger } = deps;

  return async (context: { roomId: string }, event: PlatformEvent): Promise<void> => {
    if (event.type !== "message_created") return;

    const payload = event.payload;
    if (payload.sender_id === self.id) return;
    if (payload.message_type !== "text") return;

    // Fail closed: an unknown owner means nothing passes the sender gate.
    if (!ownerId) {
      logger.warn("dropping message: agent has no owner on record", {
        room_id: context.roomId,
      });
      return;
    }

    // Best-effort: an empty roster only disables the 1:1-room mention
    // shortcut, it never widens who the sender gate allows.
    let roomParticipantIds: string[] = [];
    try {
      const participants = await listParticipants(context.roomId);
      roomParticipantIds = participants.map((p) => p.id);
    } catch (error) {
      logger.warn("could not list participants", {
        room_id: context.roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const forward = shouldForwardMessage({
      text: payload.content,
      senderId: payload.sender_id,
      self,
      ownerId,
      allowedSenderIds,
      roomParticipantIds,
    });

    if (!forward) {
      await ackTracker.markGatedOut(context.roomId, payload.id);
      return;
    }

    // Mark processing before the push, not after: a crash between the two
    // would otherwise leave the message stuck at `sent`, which the backlog
    // catch-up sweep does not distinguish from "never seen".
    await ackTracker.markPushed(context.roomId, payload.id);
    lastSenderTracker.track(context.roomId, {
      senderId: payload.sender_id,
      senderName: payload.sender_name ?? "",
    });

    try {
      await notify(
        payload.content,
        sanitizeMeta({
          room_id: context.roomId,
          sender_id: payload.sender_id,
          sender_name: payload.sender_name ?? "",
          message_id: payload.id,
        }),
      );
    } catch (error) {
      logger.error("failed to push notifications/claude/channel", {
        room_id: context.roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
