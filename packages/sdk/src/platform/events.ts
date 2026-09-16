interface Payload extends Record<string, unknown> {}

export interface MentionPayload extends Payload {
  id: string;
  handle?: string | null;
  name?: string | null;
  username?: string | null;
}

export interface MessageCreatedPayload extends Payload {
  id: string;
  content: string;
  message_type: string;
  metadata?: Payload & { mentions?: MentionPayload[] };
  attachments?: unknown[];
  sender_id: string;
  sender_type: string;
  sender_name?: string | null;
  inserted_at: string;
  updated_at: string;
}

export interface RoomPayload extends Payload {
  id: string;
  title?: string | null;
  task_id?: string | null;
  inserted_at: string;
  updated_at: string;
}

export type RoomAddedPayload = RoomPayload;
export type RoomRemovedPayload = RoomPayload;

export interface RoomDeletedPayload extends Payload {
  id: string;
}

export interface ParticipantPayload extends Payload {
  id: string;
  name: string;
  type: string;
  handle?: string | null;
}

export type ParticipantAddedPayload = ParticipantPayload;
export type ParticipantRemovedPayload = ParticipantPayload;

export interface ContactRequestReceivedPayload extends Payload {
  id: string;
  from_handle?: string;
  from_name?: string;
  message?: string | null;
  status: string;
  inserted_at: string;
}

export interface ContactRequestUpdatedPayload extends Payload {
  id: string;
  status: string;
}

export interface ContactAddedPayload extends Payload {
  id: string;
  handle: string | null;
  name: string | null;
  type: string;
  description?: string | null;
  is_external?: boolean | null;
  is_remote?: boolean | null;
  inserted_at: string;
}

export interface ContactRemovedPayload extends Payload {
  id: string;
}

interface BaseEvent<TType extends string, TPayload> {
  type: TType;
  roomId: string | null;
  payload: TPayload;
  raw?: Record<string, unknown>;
}

export type MessageEvent = BaseEvent<"message_created", MessageCreatedPayload>;
export type RoomAddedEvent = BaseEvent<"room_added", RoomAddedPayload>;
export type RoomRemovedEvent = BaseEvent<"room_removed", RoomRemovedPayload>;
export type ParticipantAddedEvent = BaseEvent<"participant_added", ParticipantAddedPayload>;
export type ParticipantRemovedEvent = BaseEvent<"participant_removed", ParticipantRemovedPayload>;
export type RoomDeletedEvent = BaseEvent<"room_deleted", RoomDeletedPayload>;
export type ContactRequestReceivedEvent = BaseEvent<"contact_request_received", ContactRequestReceivedPayload>;
export type ContactRequestUpdatedEvent = BaseEvent<"contact_request_updated", ContactRequestUpdatedPayload>;
export type ContactAddedEvent = BaseEvent<"contact_added", ContactAddedPayload>;
export type ContactRemovedEvent = BaseEvent<"contact_removed", ContactRemovedPayload>;

export type ContactEvent =
  | ContactRequestReceivedEvent
  | ContactRequestUpdatedEvent
  | ContactAddedEvent
  | ContactRemovedEvent;

export type PlatformEvent =
  | MessageEvent
  | RoomAddedEvent
  | RoomRemovedEvent
  | RoomDeletedEvent
  | ParticipantAddedEvent
  | ParticipantRemovedEvent
  | ContactRequestReceivedEvent
  | ContactRequestUpdatedEvent
  | ContactAddedEvent
  | ContactRemovedEvent;

/** Socket events owned by BandLink's regular event queue, not every Core EventType. */
export type SupportedSocketEvent = PlatformEvent["type"];
