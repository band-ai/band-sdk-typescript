import type { McpToolRegistration } from "@band-ai/sdk/mcp";
import { getRecentMessages, type ChatParticipant, type PlatformChatMessage } from "@band-ai/sdk/rest";
import { AgentTools, replaceUuidMentions } from "@band-ai/sdk/runtime";

import { handleOf, listCandidates, resolveAll, type Candidate } from "./names";
import { ALWAYS_LOAD_META, requiredString, stringList, TOOL, toolResult, type ToolContext } from "./tools";

/** How many messages `reply` remembers, the least recently seen dropped first. */
export const REPLY_MEMORY_SIZE = 1000;

/** How many messages `fetch_messages` lists by default, and at most. */
export const FETCH_DEFAULT_LIMIT = 20;
export const FETCH_MAX_LIMIT = 100;

const ROOM_PARTICIPANTS = "In the room";

interface RememberedMessage {
  readonly roomId: string;
  readonly senderId: string;
}

/** The room and sender of each message Claude has seen, so `reply` needs only its id; in memory only. */
export class MessageMemory {
  private readonly messages = new Map<string, RememberedMessage>();

  public remember(messageId: string, message: RememberedMessage): void {
    // Re-inserting moves a message seen again (as fetch_messages lists it) to the newest end.
    this.messages.delete(messageId);
    this.messages.set(messageId, message);
    if (this.messages.size > REPLY_MEMORY_SIZE) {
      // A Map iterates in insertion order, so the first key is the least recently seen.
      this.messages.delete(this.messages.keys().next().value as string);
    }
  }

  public recall(messageId: string): RememberedMessage | undefined {
    return this.messages.get(messageId);
  }
}

export function replyTool(context: ToolContext): McpToolRegistration {
  return {
    name: TOOL.reply,
    description:
      `Posts on Band as ${context.self.handle}. The only way to answer a Band message: terminal text never reaches Band. ` +
      `Pass the message_id from the <channel> tag; the reply goes to that message's room and mentions its sender. ` +
      `Answer each of several messages with its own reply. Add mentions only for others you address, a word or two of their handle or name each. ` +
      `For an id it doesn't know, list the room with ${TOOL.fetchMessages}, or use ${TOOL.send} with the tag's room_id.`,
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message_id of the Band message you answer." },
        content: { type: "string", description: "The reply." },
        mentions: { type: "array", items: { type: "string" }, description: "Others in the room to mention besides the sender, by handle or name." },
      },
      required: ["message_id", "content"],
    },
    _meta: ALWAYS_LOAD_META,
    execute: (args) => toolResult(TOOL.reply, context, async () => {
      const messageId = requiredString(args, "message_id");
      const message = context.memory.recall(messageId);
      if (!message) {
        throw new Error(
          `No message ${messageId} is known; nothing was posted. List the room's messages with ${TOOL.fetchMessages}(room_id), ` +
          `or post with ${TOOL.send} to the <channel> tag's room_id.`,
        );
      }
      const others = await othersInRoom(context, message.roomId);
      const sender = others.find(({ id }) => id === message.senderId);
      if (!sender) {
        throw new Error(`The sender has left the room; nothing was posted. ${ROOM_PARTICIPANTS}:\n${listCandidates(others)}`);
      }
      const extra = resolveAll(stringList(args.mentions), others, ROOM_PARTICIPANTS);
      return post(context, message.roomId, requiredString(args, "content"), [sender, ...extra]);
    }),
  };
}

export function sendTool(context: ToolContext): McpToolRegistration {
  return {
    name: TOOL.send,
    description:
      `Posts on Band as ${context.self.handle}. Starts a conversation in a room by room_id, as in a room ${TOOL.openRoom} gave you; ` +
      `to answer a Band message, use ${TOOL.reply} instead. Mention at least one participant you address, by a word or two of their handle or name, never yourself. ` +
      `Their answer arrives later as a <channel> message.`,
    inputSchema: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "The room to post in." },
        content: { type: "string", description: "The message." },
        mentions: { type: "array", items: { type: "string" }, description: "At least one participant to mention, by handle or name." },
      },
      required: ["room_id", "content", "mentions"],
    },
    _meta: ALWAYS_LOAD_META,
    execute: (args) => toolResult(TOOL.send, context, async () => {
      const roomId = requiredString(args, "room_id");
      const content = requiredString(args, "content");
      const others = await othersInRoom(context, roomId);
      const entries = stringList(args.mentions);
      if (entries.length === 0) {
        throw new Error(`Say whom to mention; nothing was posted. ${ROOM_PARTICIPANTS}:\n${listCandidates(others)}`);
      }
      return post(context, roomId, content, resolveAll(entries, others, ROOM_PARTICIPANTS));
    }),
  };
}

export function fetchMessagesTool(context: ToolContext): McpToolRegistration {
  return {
    name: TOOL.fetchMessages,
    description:
      `Lists a room's newest messages this agent can see (its own and those mentioning it), oldest first, ` +
      `${FETCH_DEFAULT_LIMIT} by default and at most ${FETCH_MAX_LIMIT}, each with its id. ` +
      `Use it to catch up on a room or to find a message to answer, then answer it with ${TOOL.reply}(message_id).`,
    inputSchema: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "The room to read." },
        limit: { type: "integer", description: `How many messages, 1 to ${FETCH_MAX_LIMIT}; ${FETCH_DEFAULT_LIMIT} by default.` },
      },
      required: ["room_id"],
    },
    execute: (args) => toolResult(TOOL.fetchMessages, context, async () => {
      const roomId = requiredString(args, "room_id");
      const limit = args.limit ?? FETCH_DEFAULT_LIMIT;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > FETCH_MAX_LIMIT) {
        throw new Error(`limit must be a whole number from 1 to ${FETCH_MAX_LIMIT}.`);
      }
      const { rest } = context.link;
      if (!rest.getChat) {
        throw new Error("Band's REST client can't read a room");
      }
      const [messages, room, participants] = await Promise.all([
        getRecentMessages(rest, roomId, limit),
        rest.getChat(roomId),
        rest.listChatParticipants(roomId),
      ]);
      for (const message of messages) {
        if (message.sender_id !== context.self.id) {
          context.memory.remember(message.id, { roomId, senderId: message.sender_id });
        }
      }
      const header = `'${room.title ?? roomId}' — ${participants.filter(({ id }) => id !== context.self.id).map(handleOf).join(", ")}`;
      return [header, ...messages.map((message) => messageLine(message, participants))].join("\n");
    }),
  };
}

/** Everyone in the room but this agent: who a post there can mention. */
async function othersInRoom({ link, self }: ToolContext, roomId: string): Promise<ChatParticipant[]> {
  return (await link.rest.listChatParticipants(roomId)).filter(({ id }) => id !== self.id);
}

async function post(context: ToolContext, roomId: string, content: string, mentions: readonly Candidate[]): Promise<string> {
  const { link, logger, self, working } = context;
  // Object-form mentions are already resolved, so the SDK posts them as they are, once each.
  await new AgentTools({ roomId, rest: link.rest, logger }).sendMessage(content, mentions.map(({ id, handle }) => ({ id, handle: handle ?? undefined })));
  working.stop(roomId);
  return `Posted as ${self.handle}, mentioning ${[...new Set(mentions.map(handleOf))].join(", ")}.`;
}

function messageLine(message: PlatformChatMessage, participants: ChatParticipant[]): string {
  const sender = participants.find(({ id }) => id === message.sender_id);
  // Someone who left the room is shown by the name the message carries.
  const who = sender ? handleOf(sender) : message.sender_name ?? message.sender_id;
  return `[${message.inserted_at}] ${who}: ${replaceUuidMentions(message.content, participants as unknown as Array<Record<string, unknown>>)} (id: ${message.id})`;
}
