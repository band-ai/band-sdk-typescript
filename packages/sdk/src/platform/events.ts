import type {
  ContactAddedPayload,
  ContactRemovedPayload,
  ContactRequestReceivedPayload,
  ContactRequestUpdatedPayload,
  MessageCreatedPayload,
  ParticipantAddedPayload,
  ParticipantRemovedPayload,
  RoomAddedPayload,
  RoomDeletedPayload,
  RoomRemovedPayload,
} from "./streaming/payloadSchemas";

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

/**
 * Synthetic — never a wire event. Queued once per settled transport
 * reconnect generation, after tracker reconciliation, so a room's
 * `Execution` can re-run its `/next` synchronization boundary.
 */
export type ReconnectedEvent = BaseEvent<"reconnected", Record<string, never>>;

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
  | ContactRemovedEvent
  | ReconnectedEvent;
