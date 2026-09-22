import { z } from "zod";
import type { ParticipantRecord } from "../contracts/dtos";
import { ValidationError } from "../core/errors";
import type {
  AdapterToolsProtocol,
  FrameworkAdapterInput,
  HistoryConverter,
  PlatformMessageLike,
} from "../contracts/protocols";

export interface AgentConfig {
  autoSubscribeExistingRooms?: boolean;
}

/** Upper bound core's `RetryTracker` accepts for `maxRetries` (u32::MAX). */
export const MAX_MESSAGE_RETRIES = 4_294_967_295;

export const DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 300;
export const MIN_CONTEXT_MESSAGES = 1;
export const MAX_CONTEXT_MESSAGES = 100;
export const DEFAULT_MAX_MESSAGE_RETRIES = 1;

export const sessionConfigSchema = z.object({
  enableContextCache: z.boolean().default(true),
  // Zero keeps a cache valid until it is explicitly refreshed or changed.
  contextCacheTtlSeconds: z.number().int().nonnegative().default(DEFAULT_CONTEXT_CACHE_TTL_SECONDS),
  maxContextMessages: z
    .number()
    .int()
    .min(MIN_CONTEXT_MESSAGES)
    .max(MAX_CONTEXT_MESSAGES)
    .default(MAX_CONTEXT_MESSAGES),
  maxMessageRetries: z
    .number()
    .int()
    .min(0)
    .max(MAX_MESSAGE_RETRIES)
    .default(DEFAULT_MAX_MESSAGE_RETRIES),
  enableContextHydration: z.boolean().default(true),
});

export type SessionConfig = z.input<typeof sessionConfigSchema>;
export type ResolvedSessionConfig = z.output<typeof sessionConfigSchema>;

export function parseSessionConfig(input: unknown = undefined): ResolvedSessionConfig {
  const result = sessionConfigSchema.safeParse(input === undefined ? {} : input);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.map(String).join(".") : "sessionConfig";
    return `${field}: ${issue.message}`;
  });
  throw new ValidationError(`Invalid sessionConfig: ${issues.join(", ")}`, result.error);
}

export type ContactEventStrategy = "disabled" | "callback" | "hub_room";

export type ContactEventCallback = (
  event: import("../platform/events").ContactEvent,
  tools: AdapterToolsProtocol,
) => Promise<void>;

export interface ContactEventConfig {
  strategy?: ContactEventStrategy;
  hubTaskId?: string;
  broadcastChanges?: boolean;
  onEvent?: ContactEventCallback;
}

export type PlatformMessage = PlatformMessageLike;

export interface ConversationContext {
  roomId: string;
  messages: Array<Record<string, unknown>>;
  participants: ParticipantRecord[];
  hydratedAt: Date;
}

export type MessageHandler = (
  message: PlatformMessage,
  tools: AdapterToolsProtocol,
) => Promise<void>;

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
