import type { ParticipantRecord } from "../contracts/dtos";
import type {
  AdapterToolsProtocol,
  FrameworkAdapterInput,
  HistoryConverter,
  PlatformMessageLike,
} from "../contracts/protocols";

/** Room-subscription behaviour the agent applies when it starts up. */
export interface AgentConfig {
  /** Subscribe to rooms the agent was already a member of before it started. */
  autoSubscribeExistingRooms?: boolean;
}

/**
 * Per-room conversation settings: how much history the runtime keeps, how long it caches
 * it, and how often it retries a message that failed to process.
 */
export interface SessionConfig {
  /** Reuse a room's hydrated context across messages instead of rebuilding it each time. */
  enableContextCache?: boolean;
  /** How long a cached room context stays valid. */
  contextCacheTtlSeconds?: number;
  /** Upper bound on the messages carried into an adapter turn. */
  maxContextMessages?: number;
  /** How many times a failed message is retried before it is marked failed. */
  maxMessageRetries?: number;
  /** Backfill a room's history from REST when the runtime first sees the room. */
  enableContextHydration?: boolean;
}

/** How the agent reacts to contact requests and contact changes. */
export type ContactEventStrategy = "disabled" | "callback" | "hub_room";

/** Handles a contact event programmatically, with the agent's tool surface available. */
export type OnContactEventCallback = (
  event: import("../platform/events").ContactEvent,
  tools: AdapterToolsProtocol,
) => Promise<void>;

/**
 * Previous name for {@link OnContactEventCallback}.
 *
 * @deprecated Use {@link OnContactEventCallback} instead.
 */
export type ContactEventCallback = OnContactEventCallback;

/**
 * Contact-handling configuration. `strategy` selects who decides on a contact request —
 * nobody, a callback, or the agent's own LLM in a dedicated hub room — and
 * `broadcastChanges` composes with any of them.
 */
export interface ContactEventConfig {
  /** Which contact-handling strategy to run. Defaults to `"disabled"`. */
  strategy?: ContactEventStrategy;
  /** Task to link the hub room to, for the `"hub_room"` strategy. */
  hubTaskId?: string;
  /** Announce contact additions and removals into every active room. */
  broadcastChanges?: boolean;
  /** Handler invoked per contact event, for the `"callback"` strategy. */
  onEvent?: OnContactEventCallback;
}

/** A single chat message as the runtime hands it to an adapter. */
export type PlatformMessage = PlatformMessageLike;

/** A room's hydrated history and participant list, with the time it was fetched. */
export interface ConversationContext {
  roomId: string;
  messages: Array<Record<string, unknown>>;
  participants: ParticipantRecord[];
  hydratedAt: Date;
}

/** Handles one inbound room message with the agent's tool surface available. */
export type MessageHandler = (
  message: PlatformMessage,
  tools: AdapterToolsProtocol,
) => Promise<void>;

/**
 * A room's raw message history, as passed to an adapter. Adapters read {@link raw}
 * directly or call {@link convert} with a framework-specific {@link HistoryConverter} to
 * turn it into their own message format.
 */
export class HistoryProvider {
  public readonly raw: Array<Record<string, unknown>>;

  public constructor(raw: Array<Record<string, unknown>>) {
    this.raw = raw;
  }

  public convert<T>(converter: HistoryConverter<T>): T {
    return converter.convert(this.raw);
  }

  public get length(): number {
    return this.raw.length;
  }
}

/** Everything an adapter receives for one turn, with the SDK's concrete message and history types. */
export interface AgentInput extends Omit<FrameworkAdapterInput, "message" | "history"> {
  message: PlatformMessage;
  history: HistoryProvider;
}

export const SYNTHETIC_SENDER_TYPE = "System";
export const SYNTHETIC_CONTACT_EVENTS_SENDER_ID = "contact-events";
export const SYNTHETIC_CONTACT_EVENTS_SENDER_NAME = "Contact Events";

export function ensureHandlePrefix(handle: string | null | undefined): string | null {
  if (!handle) {
    return null;
  }

  return handle.startsWith("@") ? handle : `@${handle}`;
}
