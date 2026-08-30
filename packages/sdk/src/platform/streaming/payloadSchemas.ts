import { z } from "zod";

const mentionSchema = z.looseObject({
  id: z.string(),
  handle: z.string().nullish(),
  name: z.string().nullish(),
  username: z.string().nullish(),
});

const messageMetadataSchema = z.looseObject({
  mentions: z.array(mentionSchema).nullish(),
});

export const messageCreatedPayloadSchema = z.looseObject({
  id: z.string(),
  content: z.string(),
  message_type: z.string(),
  metadata: messageMetadataSchema.nullish(),
  sender_id: z.string(),
  sender_type: z.string(),
  sender_name: z.string().nullish(),
  chat_room_id: z.string().nullish(),
  inserted_at: z.string(),
  updated_at: z.string(),
});

const roomOwnerSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

export const roomAddedPayloadSchema = z.looseObject({
  id: z.string(),
  title: z.string().nullish(),
  task_id: z.string().nullish(),
  inserted_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  owner: roomOwnerSchema.nullish(),
  status: z.string().nullish(),
  type: z.string().nullish(),
  created_at: z.string().nullish(),
  participant_role: z.string().nullish(),
});

export const roomRemovedPayloadSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  type: z.string(),
  title: z.string(),
  removed_at: z.string(),
});

export const participantAddedPayloadSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  handle: z.string().nullish(),
});

export const participantRemovedPayloadSchema = z.looseObject({
  id: z.string(),
});

export const roomDeletedPayloadSchema = z.looseObject({
  id: z.string(),
});

export const contactRequestReceivedPayloadSchema = z.looseObject({
  id: z.string(),
  from_handle: z.string(),
  from_name: z.string(),
  message: z.string().nullish(),
  status: z.string(),
  inserted_at: z.string(),
});

export const contactRequestUpdatedPayloadSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
});

export const contactAddedPayloadSchema = z.looseObject({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
  type: z.string(),
  description: z.string().nullish(),
  is_external: z.boolean().nullish(),
  inserted_at: z.string(),
});

export const contactRemovedPayloadSchema = z.looseObject({
  id: z.string(),
});

export type MessageCreatedPayload = z.infer<typeof messageCreatedPayloadSchema>;
export type RoomAddedPayload = z.infer<typeof roomAddedPayloadSchema>;
export type RoomRemovedPayload = z.infer<typeof roomRemovedPayloadSchema>;
export type ParticipantAddedPayload = z.infer<typeof participantAddedPayloadSchema>;
export type ParticipantRemovedPayload = z.infer<typeof participantRemovedPayloadSchema>;
export type RoomDeletedPayload = z.infer<typeof roomDeletedPayloadSchema>;
export type ContactRequestReceivedPayload = z.infer<typeof contactRequestReceivedPayloadSchema>;
export type ContactRequestUpdatedPayload = z.infer<typeof contactRequestUpdatedPayloadSchema>;
export type ContactAddedPayload = z.infer<typeof contactAddedPayloadSchema>;
export type ContactRemovedPayload = z.infer<typeof contactRemovedPayloadSchema>;

export const payloadSchemas = {
  message_created: messageCreatedPayloadSchema,
  room_added: roomAddedPayloadSchema,
  room_removed: roomRemovedPayloadSchema,
  participant_added: participantAddedPayloadSchema,
  participant_removed: participantRemovedPayloadSchema,
  room_deleted: roomDeletedPayloadSchema,
  contact_request_received: contactRequestReceivedPayloadSchema,
  contact_request_updated: contactRequestUpdatedPayloadSchema,
  contact_added: contactAddedPayloadSchema,
  contact_removed: contactRemovedPayloadSchema,
} as const;

export type SupportedSocketEvent = keyof typeof payloadSchemas;
