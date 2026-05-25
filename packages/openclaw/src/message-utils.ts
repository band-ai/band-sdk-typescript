import { SYNTHETIC_CONTACT_EVENTS_SENDER_ID } from "@thenvoi/sdk/runtime";
import type { PlatformEvent } from "@thenvoi/sdk";

export interface OpenClawInboundMessage {
  channelId: "thenvoi";
  threadId: string;
  senderId: string;
  senderType: string;
  senderName: string;
  text: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export function buildOpenClawBody(message: OpenClawInboundMessage): string {
  if (message.senderType?.toLowerCase() !== "agent") return message.text;

  return [
    `[Band worker agent reply from ${message.senderName} (${message.senderId})]`,
    "This message is from another agent in the room, not from the human requester. If you delegated work to this agent and a critique, improvement request, validation question, challenge, counterargument, or follow-up would improve the result, reply to this same worker with thenvoi_send_message instead of finaling back to the room owner. For debate, review, or compare/contrast tasks, the first worker answer is not enough; challenge it or add your own counterpoint before declaring consensus.",
    "",
    message.text,
  ].join("\n");
}

export function platformEventToInboundMessage(event: PlatformEvent): OpenClawInboundMessage | null {
  if (event.type !== "message_created") return null;
  const payload = event.payload;
  const roomId = event.roomId ?? payload.chat_room_id;
  if (!roomId) return null;

  const isTextMessage = payload.message_type === "text";
  const isSyntheticContactEvent =
    payload.message_type === "contact_event" && payload.sender_id === SYNTHETIC_CONTACT_EVENTS_SENDER_ID;
  if (!isTextMessage && !isSyntheticContactEvent) {
    console.log(`[thenvoi] Skipping non-text message (type=${payload.message_type}, room=${roomId})`);
    return null;
  }

  return {
    channelId: "thenvoi",
    threadId: roomId,
    senderId: payload.sender_id,
    senderType: payload.sender_type,
    senderName: payload.sender_name ?? "Unknown",
    text: payload.content,
    timestamp: payload.inserted_at,
    metadata: {
      messageId: payload.id,
      messageType: payload.message_type,
      mentions: payload.metadata?.mentions,
      contactEvent: isSyntheticContactEvent,
    },
  };
}

export function messageMentionsAgent(payload: Record<string, unknown>, agentId: string): boolean {
  const content = typeof payload.content === "string" ? payload.content : "";
  if (content.includes(agentId)) return true;

  const mentions = (payload.metadata as { mentions?: Array<{ id?: unknown; agent_id?: unknown; participant_id?: unknown }> } | undefined)?.mentions;
  return Array.isArray(mentions) && mentions.some((mention) =>
    mention.id === agentId || mention.agent_id === agentId || mention.participant_id === agentId,
  );
}

export function messageInsertedAt(payload: Record<string, unknown>): number | undefined {
  const insertedAt = typeof payload.inserted_at === "string" ? Date.parse(payload.inserted_at) : NaN;
  return Number.isFinite(insertedAt) ? insertedAt : undefined;
}
