/**
 * The reply barrier: wait until an agent's reply to the room's last posted
 * message is captured. Independent of the delivery barrier — a reply frame and
 * the processed frame are unordered platform events, so assert on reply text
 * only after this, never after `untilProcessed`.
 */
import { Band } from "@band-ai/rest-client";

import { FAILURE_EVENT_TYPE } from "../../../src/contracts/protocols";
import { parseToolCall } from "../../../src/converters/shared";
import type { MessageCreatedPayload } from "../../../src/platform/events";
import { MEMORY_TOOL_NAMES } from "../../../src/runtime/tools/schemas";
import { LIVE_EVENT_TIMEOUT_MS } from "../../integration/support/liveHarness";
import type { AgentIdentity } from "./agents";
import { liveRun } from "./liveRun";
import type { Room } from "./rooms";
import { waitFor } from "./waitFor";

export interface CapturedMessage {
  id: string;
  content: string;
  senderId: string;
  /** `MESSAGE_TYPE.Text` for a chat message; an event's type (`Task`, `ToolCall`, …) otherwise. */
  messageType: string;
  mentionIds: string[];
  metadata: Record<string, unknown>;
}

/** The platform's message types, for reading a room's stored `history()`. */
export const MESSAGE_TYPE = Band.ListMyChatMessagesRequestMessageType;

export type MessageType = Band.ListMyChatMessagesRequestMessageType;

export const REPLY_WAIT = { reply: "reply", timeout: "timeout" } as const;

export type ReplyWait =
  | { kind: typeof REPLY_WAIT.reply; message: CapturedMessage }
  /**
   * `unmatched`: what the agent did post after the message, none of it a match.
   * `failures`: what it reported failing in the room meanwhile, the likeliest reason.
   */
  | { kind: typeof REPLY_WAIT.timeout; waitedMs: number; unmatched: string[]; failures: string[] };

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

/** What `senderId` posted after the message `afterId`, oldest first; nothing until `afterId` is captured. */
function postedAfter(messages: readonly MessageCreatedPayload[], afterId: string, senderId: string): CapturedMessage[] {
  const sentAt = messages.findIndex((message) => message.id === afterId);
  if (sentAt < 0) {
    return [];
  }
  return messages
    .slice(sentAt + 1)
    .filter((message) => message.sender_id === senderId)
    .map(captured);
}

/**
 * The room's stored messages, oldest first, read as the user — including the
 * tool and task events the platform never streams to a user's socket.
 */
export async function history(room: Pick<Room, "id">, messageType?: MessageType): Promise<CapturedMessage[]> {
  const { env } = await liveRun();
  const messages: CapturedMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.userClient.humanApiMessages.listMyChatMessages(room.id, { message_type: messageType, cursor, limit: 100 });
    messages.push(...page.data.map((message) => captured(message as MessageRecord)));
    cursor = page.metadata.has_more ? page.metadata.next_cursor : undefined;
  } while (cursor);
  // The platform lists newest first.
  return messages.reverse();
}

/** The room's stored `messageType` events from `sender`, oldest first. Read only after `untilProcessed`. */
export async function eventsFrom(room: Room, messageType: MessageType, sender: Pick<AgentIdentity, "id">): Promise<CapturedMessage[]> {
  return (await history(room, messageType)).filter((event) => event.senderId === sender.id);
}

/** One stored tool call. `id` is the event's own id, which tells one turn's calls from another's. */
export interface ToolCallEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallsOptions {
  /** Keep the Band memory tools' calls, which the general view leaves out. */
  includeMemory?: boolean;
}

/**
 * Every tool `sender` called in `room`, oldest first. An event that is not a
 * parseable call is dropped. Read only after `untilProcessed`.
 */
export async function toolCalls(
  room: Room,
  sender: Pick<AgentIdentity, "id">,
  { includeMemory = false }: ToolCallsOptions = {},
): Promise<ToolCallEvent[]> {
  const events = await eventsFrom(room, MESSAGE_TYPE.ToolCall, sender);
  return events
    .flatMap((event) => {
      const call = parseToolCall(event.content);
      return call ? [{ id: event.id, name: call.name, args: call.args }] : [];
    })
    .filter((call) => includeMemory || !MEMORY_TOOL_NAMES.has(call.name));
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
    const postedByFrom = () => postedAfter(room.messages.entries, after.id, from.id);
    const message = await waitFor(room.messages, () => postedByFrom().find(matches), timeoutMs);
    if (message) {
      return { kind: REPLY_WAIT.reply, message };
    }
    const failures = (await history(room, FAILURE_EVENT_TYPE)).filter((event) => event.senderId === from.id);
    return {
      kind: REPLY_WAIT.timeout,
      waitedMs: timeoutMs,
      unmatched: postedByFrom().map((posted) => posted.content),
      failures: failures.map((event) => event.content),
    };
  };

  return {
    /** `from`'s first message after the room's last posted one. */
    untilReply: (from: AgentIdentity, options?: ReplyWaitOptions) => untilReplyMatching(from, () => true, options),
    /** `from`'s first message after the room's last posted one that `matches` — for a turn that posts several. */
    untilReplyMatching,
    history: (messageType?: MessageType) => history(room, messageType),
  };
}
