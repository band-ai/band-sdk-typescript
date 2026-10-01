import type { PlatformEvent } from "@band-ai/sdk";
import type { Logger } from "@band-ai/sdk/core";

import type { AckTracker } from "./ack.js";

import type {
  CommandAuthorizationRequest,
  CommandAuthorizationResult,
  PrivilegedCommandAuthorizer,
} from "./commandAuthorization.js";
import { parsePrivilegedCommand } from "./commandAuthorization.js";
import {
  isDirectRoomWithOwner,
  isSelfMentioned,
  sanitizeMeta,
  shouldForwardMessage,
  type SelfIdentity,
} from "./gating.js";
import type { LastSenderTracker, RoomParticipant } from "./mentions.js";

export interface MessageHandlerDeps {
  self: SelfIdentity;
  ownerId: string | null;
  listParticipants: (roomId: string) => Promise<RoomParticipant[]>;
  commandAuthorizer: Pick<PrivilegedCommandAuthorizer, "authorize">;
  sendMessage: (
    roomId: string,
    message: {
      content: string;
      mentions: Array<{ id: string; handle?: string; name?: string }>;
    },
  ) => Promise<unknown>;
  ackTracker: AckTracker;
  lastSenderTracker: LastSenderTracker;
  notify: (content: string, meta: Record<string, string>) => Promise<void>;
  /** Messages already pushed into this Claude transcript, which a resume must not replay. */
  deliveries: {
    wasDelivered(messageId: string): boolean;
    recordDelivered(messageId: string): void;
  };
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
  const {
    self,
    ownerId,
    listParticipants,
    ackTracker,
    lastSenderTracker,
    commandAuthorizer,
    sendMessage,
    notify,
    deliveries,
    logger,
  } = deps;

  return async (context: { roomId: string }, event: PlatformEvent): Promise<void> => {
    if (event.type !== "message_created") return;

    const payload = event.payload;
    if (payload.sender_id === self.id) return;
    if (payload.message_type !== "text") return;

    // Fail closed: slash-command authorization and the DM shortcut need the owner.
    if (!ownerId) {
      logger.warn("dropping message: agent has no owner on record", {
        room_id: context.roomId,
      });
      return;
    }

    const sender = { senderId: payload.sender_id, senderName: payload.sender_name ?? "" };

    // The runtime replays every unanswered (`processing`) message on start.
    // This transcript already holds this one, and any command in it was
    // already authorized, so only re-arm the reply ack.
    if (deliveries.wasDelivered(payload.id)) {
      ackTracker.trackPending(context.roomId, payload.id);
      lastSenderTracker.track(context.roomId, sender);
      return;
    }

    // Best-effort: an empty roster only disables the 1:1-room mention shortcut.
    let participants: RoomParticipant[] = [];
    try {
      participants = await listParticipants(context.roomId);
    } catch (error) {
      logger.warn("could not list participants", {
        room_id: context.roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const roomParticipantIds = participants.map((participant) => participant.id);
    const command = parsePrivilegedCommand(payload.content);
    let forward: boolean;
    if (command === null) {
      forward = shouldForwardMessage({
        text: payload.content,
        senderId: payload.sender_id,
        self,
        ownerId,
        roomParticipantIds,
      });
    } else {
      const addressed =
        isSelfMentioned(payload.content, self) ||
        (
          payload.sender_id === ownerId &&
          isDirectRoomWithOwner(roomParticipantIds, self.id, ownerId)
        );
      if (!addressed) {
        await ackTracker.markGatedOut(context.roomId, payload.id);
        return;
      }

      const request: CommandAuthorizationRequest = {
        senderId: payload.sender_id,
        senderName: payload.sender_name ?? "",
        command,
        content: payload.content,
      };
      const authorization = await commandAuthorizer.authorize(request);
      forward = authorization.allowed;
      if (!forward) {
        await ackTracker.markGatedOut(context.roomId, payload.id);
        await sendCommandDenial(
          context.roomId,
          request,
          authorization,
          participants,
          sendMessage,
          logger,
        );
        return;
      }
    }

    if (!forward) {
      await ackTracker.markGatedOut(context.roomId, payload.id);
      return;
    }

    // Mark processing before the push, not after: a crash between the two
    // would otherwise leave the message stuck at `sent`, which the backlog
    // catch-up sweep does not distinguish from "never seen".
    await ackTracker.markPushed(context.roomId, payload.id);
    lastSenderTracker.track(context.roomId, sender);

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
      deliveries.recordDelivered(payload.id);
    } catch (error) {
      logger.error("failed to push notifications/claude/channel", {
        room_id: context.roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

async function sendCommandDenial(
  roomId: string,
  request: CommandAuthorizationRequest,
  authorization: CommandAuthorizationResult,
  participants: readonly RoomParticipant[],
  sendMessage: MessageHandlerDeps["sendMessage"],
  logger: Logger,
): Promise<void> {
  const participant = participants.find((candidate) => candidate.id === request.senderId);
  const handle = participant?.handle?.trim().replace(/^@+/, "");
  const name = participant?.name || request.senderName || undefined;
  const mentionLabel = handle || name || request.senderId;
  const note = authorization.note === null ? "" : ` ${authorization.note}`;
  const mention = {
    id: request.senderId,
    ...(handle ? { handle } : {}),
    ...(name ? { name } : {}),
  };

  try {
    await sendMessage(roomId, {
      content: `@${mentionLabel} ${request.command} was denied by the local Claude Code session.${note}`,
      mentions: [mention],
    });
  } catch (error) {
    logger.warn("could not send privileged-command denial to Band", {
      room_id: roomId,
      sender_id: request.senderId,
      command: request.command,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
