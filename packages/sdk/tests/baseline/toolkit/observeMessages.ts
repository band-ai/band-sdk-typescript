/**
 * The reply barrier: wait until an agent's reply to the room's last posted
 * message is captured. Independent of the delivery barrier — a reply frame and
 * the processed frame are unordered platform events, so assert on reply text
 * only after this, never after `untilProcessed`.
 */
import type { Band } from "@band-ai/rest-client";

import type { MessageCreatedPayload } from "../../../src/platform/events";
import { LIVE_EVENT_TIMEOUT_MS } from "../../integration/support/liveHarness";
import type { AgentIdentity } from "./agents";
import { liveRun } from "./liveRun";
import type { Room } from "./rooms";
import { waitFor } from "./waitFor";

export interface CapturedMessage {
  id: string;
  content: string;
  senderId: string;
  /** `text` for a chat message; an event's type (`task`, `tool_call`, …) otherwise. */
  messageType: string;
  mentionIds: string[];
  metadata: Record<string, unknown>;
}

export type ReplyWait =
  | { kind: "reply"; message: CapturedMessage }
  | { kind: "timeout"; waitedMs: number };

type MessageRecord = Pick<MessageCreatedPayload, "id" | "content" | "sender_id" | "message_type"> & {
  metadata?: Record<string, unknown> & { mentions?: Array<{ id?: string }> };
};

function captured(payload: MessageRecord): CapturedMessage {
  return {
    id: payload.id,
    content: payload.content,
    senderId: payload.sender_id,
    messageType: payload.message_type,
    mentionIds: (payload.metadata?.mentions ?? []).flatMap((mention) => (mention.id ? [mention.id] : [])),
    metadata: payload.metadata ?? {},
  };
}

/** The first message from `senderId` after the message `afterId` that `matches`, once both are captured. */
function replyAfter(
  messages: readonly MessageCreatedPayload[],
  afterId: string,
  senderId: string,
  matches: (message: CapturedMessage) => boolean,
): CapturedMessage | undefined {
  const sentAt = messages.findIndex((message) => message.id === afterId);
  if (sentAt < 0) {
    return undefined;
  }
  return messages
    .slice(sentAt + 1)
    .filter((message) => message.sender_id === senderId)
    .map(captured)
    .find(matches);
}

/**
 * The room's stored messages, oldest first, read as the user — including the
 * tool and task events the platform never streams to a user's socket.
 */
async function history(room: Room, messageType?: Band.ListMyChatMessagesRequestMessageType): Promise<CapturedMessage[]> {
  const { env } = await liveRun();
  const messages: CapturedMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.userClient.humanApiMessages.listMyChatMessages(room.id, { message_type: messageType, cursor, limit: 100 });
    messages.push(...page.data.map((message) => captured(message as MessageRecord)));
    cursor = page.metadata.has_more ? page.metadata.next_cursor : undefined;
  } while (cursor);
  return messages;
}

export interface ReplyWaitOptions {
  /** The message the reply follows; the room's last posted one by default. */
  after?: { id: string };
  timeoutMs?: number;
}

export function observeRoom(room: Room) {
  const untilReplyMatching = async (
    from: AgentIdentity,
    matches: (message: CapturedMessage) => boolean,
    { after = room.lastSent ?? undefined, timeoutMs = LIVE_EVENT_TIMEOUT_MS }: ReplyWaitOptions = {},
  ): Promise<ReplyWait> => {
    if (!after) {
      throw new Error("a reply wait needs a posted message to answer; send one with Rooms.sendMention first");
    }
    const message = await waitFor(room.messages, () => replyAfter(room.messages.entries, after.id, from.id, matches), timeoutMs);
    return message ? { kind: "reply", message } : { kind: "timeout", waitedMs: timeoutMs };
  };

  return {
    /** `from`'s first message after the room's last posted one. */
    untilReply: (from: AgentIdentity, options?: ReplyWaitOptions) => untilReplyMatching(from, () => true, options),
    /** `from`'s first message after the room's last posted one that `matches` — for a turn that posts several. */
    untilReplyMatching,
    history: (messageType?: Band.ListMyChatMessagesRequestMessageType) => history(room, messageType),
  };
}
