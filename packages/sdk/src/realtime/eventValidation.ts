import { z } from "zod";

import { messageCreatedPayloadSchema } from "../platform/streaming/payloadSchemas";
import { canonicalizeUuid } from "./activity";

const roomIdSchema = z.string().min(1);

const messageDeletedSchema = z.object({
  id: z.string().min(1),
  chat_room_id: z.string().nullish(),
});

const presenceSchema = z.object({
  id: z.string().min(1),
  chat_room_id: z.string().nullish(),
  connected: z.boolean().optional(),
});

const titleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
});

const deletedRoomSchema = z.object({
  id: z.string().min(1),
});

const participantSchema = z.object({
  id: z.string().min(1),
  chat_room_id: z.string().nullish(),
});

function roomMatches(payloadRoomId: string | null | undefined, roomId: string): boolean {
  return payloadRoomId === undefined || payloadRoomId === null || payloadRoomId === roomId;
}

export function isValidRoomId(roomId: string): boolean {
  return roomIdSchema.safeParse(roomId).success && !roomId.includes(":");
}

export function validateChatPayload(
  event: "message_created" | "message_updated" | "event_created" | "message_deleted",
  payload: Record<string, unknown>,
  roomId: string,
): boolean {
  if (event === "message_deleted") {
    const parsed = messageDeletedSchema.safeParse(payload);
    return parsed.success && roomMatches(parsed.data.chat_room_id, roomId);
  }
  const parsed = messageCreatedPayloadSchema.safeParse(payload);
  return parsed.success && roomMatches(parsed.data.chat_room_id, roomId);
}

export function validateParticipantMutation(
  payload: Record<string, unknown>,
  roomId: string,
): boolean {
  const parsed = participantSchema.safeParse(payload);
  return parsed.success && roomMatches(parsed.data.chat_room_id, roomId);
}

export function validatePresencePayload(
  event: "agent_connected" | "agent_disconnected",
  payload: Record<string, unknown>,
  roomId: string,
): boolean {
  const parsed = presenceSchema.safeParse(payload);
  if (!parsed.success || !roomMatches(parsed.data.chat_room_id, roomId)) {
    return false;
  }
  if (canonicalizeUuid(parsed.data.id) === null) {
    return false;
  }
  if (event === "agent_connected" && parsed.data.connected === false) {
    return false;
  }
  if (event === "agent_disconnected" && parsed.data.connected === true) {
    return false;
  }
  return true;
}

export function validateTitlePayload(
  payload: Record<string, unknown>,
  roomId: string,
): boolean {
  const parsed = titleSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== roomId) {
    return false;
  }
  return Buffer.byteLength(parsed.data.title, "utf8") <= 256;
}

export function validateRoomDeletedPayload(
  payload: Record<string, unknown>,
  roomId: string,
): boolean {
  const parsed = deletedRoomSchema.safeParse(payload);
  return parsed.success && parsed.data.id === roomId;
}
