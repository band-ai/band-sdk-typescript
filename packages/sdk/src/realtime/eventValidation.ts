import { z } from "zod";

import {
  eventCreatedPayloadSchema,
  messageCreatedPayloadSchema,
} from "../platform/streaming/payloadSchemas";
import { canonicalizeUuid } from "./activity";

const roomIdSchema = z.string().min(1);

const messageDeletedSchema = z.object({
  id: z.string().min(1),
  chat_room_id: z.string().min(1),
});

const presenceSchema = z.object({
  id: z.string().min(1),
  chat_room_id: z.string().min(1),
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
  name: z.string().min(1),
  type: z.string().min(1),
  chat_room_id: z.string().optional(),
});

function roomMatches(payloadRoomId: string, roomId: string): boolean {
  return payloadRoomId === roomId;
}

export function isValidRoomId(roomId: string): boolean {
  return roomIdSchema.safeParse(roomId).success && !roomId.includes(":");
}

export function isValidTopicIdentity(value: string): boolean {
  return value.trim().length > 0 && !value.includes(":");
}

export function validateChatPayload(
  event:
    | "message_created"
    | "message_updated"
    | "event_created"
    | "message_deleted",
  payload: Record<string, unknown>,
  roomId: string,
): boolean {
  if (event === "message_deleted") {
    const parsed = messageDeletedSchema.safeParse(payload);
    return parsed.success && roomMatches(parsed.data.chat_room_id, roomId);
  }
  if (event === "event_created") {
    const parsed = eventCreatedPayloadSchema.safeParse(payload);
    return parsed.success && roomMatches(parsed.data.chat_room_id, roomId);
  }
  const parsed = messageCreatedPayloadSchema.safeParse(payload);
  return (
    parsed.success &&
    typeof parsed.data.chat_room_id === "string" &&
    roomMatches(parsed.data.chat_room_id, roomId)
  );
}

export function validateParticipantMutation(
  payload: Record<string, unknown>,
  roomId: string,
  kind: "added" | "removed",
): boolean {
  const parsed =
    kind === "added"
      ? participantSchema.safeParse(payload)
      : z.object({ id: z.string().min(1), chat_room_id: z.string().optional() }).safeParse(payload);
  if (!parsed.success || canonicalizeUuid(parsed.data.id) === null) {
    return false;
  }
  if (parsed.data.chat_room_id !== undefined) {
    return roomMatches(parsed.data.chat_room_id, roomId);
  }
  return true;
}

export function validatePresencePayload(
  event: "agent_connected" | "agent_disconnected",
  payload: Record<string, unknown>,
  roomId: string,
): boolean {
  const parsed = presenceSchema.safeParse(payload);
  if (
    !parsed.success ||
    !roomMatches(parsed.data.chat_room_id, roomId) ||
    canonicalizeUuid(parsed.data.id) === null
  ) {
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
