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

export const WORKING_STATE_TTL_SECONDS = 10;

// Range checks apply only when reporting is enabled; dormant numeric settings are preserved.
const workingTiming = z.custom<number>((value) => typeof value === "number", "Expected a number");

export const sessionConfigSchema = z.object({
  enableWorkingState: z.boolean().default(true),
  workingKeepAliveSeconds: workingTiming.default(3),
  workingRequestTimeoutSeconds: workingTiming.default(2),
  maxWorkingStateSeconds: workingTiming.optional(),
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
    .nonnegative()
    .max(MAX_MESSAGE_RETRIES)
    .default(DEFAULT_MAX_MESSAGE_RETRIES),
  enableContextHydration: z.boolean().default(true),
}).superRefine((config, ctx) => {
  if (!config.enableWorkingState) return;
  const cadence = config.workingKeepAliveSeconds;
  const timeout = config.workingRequestTimeoutSeconds;
  for (const [field, valid] of [
    ["workingKeepAliveSeconds", Number.isFinite(cadence) && cadence > 0 && cadence < WORKING_STATE_TTL_SECONDS / 2],
    ["workingRequestTimeoutSeconds", Number.isFinite(timeout) && timeout > 0 && timeout < cadence],
    ["maxWorkingStateSeconds", config.maxWorkingStateSeconds === undefined || (Number.isFinite(config.maxWorkingStateSeconds) && config.maxWorkingStateSeconds > 0)],
  ] as const) {
    if (!valid) ctx.addIssue({ code: "custom", path: [field], message: "Invalid enabled working-state timing" });
  }
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

export {
  SYNTHETIC_SENDER_TYPE,
  SYNTHETIC_CONTACT_EVENTS_SENDER_ID,
  SYNTHETIC_CONTACT_EVENTS_SENDER_NAME,
} from "../contracts/protocols";

export function ensureHandlePrefix(handle: string | null | undefined): string | null {
  if (!handle) {
    return null;
  }

  return handle.startsWith("@") ? handle : `@${handle}`;
}
