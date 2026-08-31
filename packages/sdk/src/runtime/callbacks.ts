import type { MetadataMap, ParticipantRecord } from "../contracts/dtos";
import type { ContactEvent, MessageEvent, PlatformEvent } from "../platform/events";
import type { ExecutionContext, ExecutionContextOptions } from "./ExecutionContext";

// Named shapes for the callbacks the runtime accepts. Options interfaces reference these
// instead of re-inlining a function type, so a signature is defined and documented once and
// every consumer of it moves together.

/** Runs an adapter turn for an event that has already been routed to a room's context. */
export type OnExecuteCallback = (
  context: ExecutionContext,
  event: PlatformEvent,
) => Promise<void>;

/** Releases whatever per-room state the caller holds once a room's session ends. */
export type OnSessionCleanupCallback = (roomId: string) => Promise<void>;

/** Notifies the caller that the agent joined a room, with the room's metadata payload. */
export type OnRoomJoinedCallback = (
  roomId: string,
  payload: MetadataMap,
) => Promise<void> | void;

/** Notifies the caller that the agent left, or was removed from, a room. */
export type OnRoomLeftCallback = (roomId: string) => Promise<void> | void;

/**
 * Forwards a contact event the platform link delivered.
 *
 * Distinct from `OnContactEventCallback`, the public `ContactEventConfig.onEvent` hook:
 * this one is the runtime's internal hand-off and does not receive a tool surface.
 */
export type OnContactEventDispatchCallback = (event: ContactEvent) => Promise<void>;

/** Notifies the caller that a participant joined one of the agent's rooms. */
export type OnParticipantAddedCallback = (
  roomId: string,
  participant: ParticipantRecord,
) => Promise<void> | void;

/** Notifies the caller that a participant left one of the agent's rooms. */
export type OnParticipantRemovedCallback = (
  roomId: string,
  participantId: string,
) => Promise<void> | void;

/** Reports an error raised while handling an event, together with the event that caused it. */
export type OnErrorCallback = (error: unknown, event: PlatformEvent) => void;

/**
 * Reports a failed event execution. Unlike {@link OnErrorCallback} it may be async, so a
 * handler can await its own reporting before the runtime moves on.
 */
export type OnFailureCallback = (
  error: unknown,
  event: PlatformEvent,
) => void | Promise<void>;

/** Decides whether the agent should subscribe to a room, from the room's metadata. */
export type RoomFilter = (room: MetadataMap) => boolean;

/** Builds the execution context for a room, starting from the runtime's own defaults. */
export type ExecutionContextFactory = (
  roomId: string,
  defaults: ExecutionContextOptions,
) => ExecutionContext;

/** Delivers a contact-change announcement that should be broadcast into every active room. */
export type OnBroadcastCallback = (message: string) => void;

/** Delivers a contact event converted into a message for the hub room's adapter to process. */
export type OnHubEventCallback = (roomId: string, event: MessageEvent) => Promise<void>;

/** Seeds a freshly created hub room with its contact-management system prompt. */
export type OnHubInitCallback = (roomId: string, systemPrompt: string) => Promise<void>;
