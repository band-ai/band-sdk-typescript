/**
 * The reply barrier: wait until an agent's reply to the room's last posted
 * message is captured. Independent of the delivery barrier — a reply frame and
 * the processed frame are unordered platform events, so assert on reply text
 * only after this, never after `untilProcessed`.
 */
import type { MessageCreatedPayload } from "../../../src/platform/events";
import { LIVE_EVENT_TIMEOUT_MS } from "../../integration/support/liveHarness";
import type { AgentIdentity } from "./agents";
import type { Room } from "./rooms";
import { waitFor } from "./waitFor";

export interface CapturedMessage {
  id: string;
  content: string;
  senderId: string;
  mentionIds: string[];
}

export type ReplyWait =
  | { kind: "reply"; message: CapturedMessage }
  | { kind: "timeout"; waitedMs: number };

function captured(payload: MessageCreatedPayload): CapturedMessage {
  return {
    id: payload.id,
    content: payload.content,
    senderId: payload.sender_id,
    mentionIds: (payload.metadata?.mentions ?? []).map((mention) => mention.id),
  };
}

/** The first message from `senderId` after the message `afterId`, once both are captured. */
function replyAfter(messages: readonly MessageCreatedPayload[], afterId: string, senderId: string): CapturedMessage | undefined {
  const sentAt = messages.findIndex((message) => message.id === afterId);
  const reply = sentAt < 0 ? undefined : messages.slice(sentAt + 1).find((message) => message.sender_id === senderId);
  return reply && captured(reply);
}

export function observeRoom(room: Room) {
  return {
    async untilReply(from: AgentIdentity, timeoutMs = LIVE_EVENT_TIMEOUT_MS): Promise<ReplyWait> {
      const sent = room.lastSent;
      if (!sent) {
        throw new Error("untilReply waits for a reply to a posted message; send one with Rooms.sendMention first");
      }
      const message = await waitFor(room.messages, () => replyAfter(room.messages.entries, sent.id, from.id), timeoutMs);
      return message ? { kind: "reply", message } : { kind: "timeout", waitedMs: timeoutMs };
    },
  };
}
