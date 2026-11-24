import { z } from "zod";
import type { ParticipantRecord } from "../contracts/dtos";
import { MAX_SETTIMEOUT_DELAY_MS, MS_PER_SECOND } from "../core/deadline";
import { ValidationError } from "../core/errors";
import { DEFAULT_WORKING_REQUEST_TIMEOUT_SECONDS } from "../contracts/activity";
import { canonicalPlatformIdentity } from "./journal/identity";
import type {
  AdapterToolsProtocol,
  FrameworkAdapterInput,
  HistoryConverter,
  PlatformMessageLike,
} from "../contracts/protocols";

export interface AgentConfig {
  /**
   * Join the rooms the agent already belongs to at startup and after a
   * reconnect, not only rooms it is added to while running. Defaults to `true`.
   */
  autoSubscribeExistingRooms?: boolean;
}

/** Upper bound core's `RetryTracker` accepts for `maxRetries` (u32::MAX). */
export const MAX_MESSAGE_RETRIES = 4_294_967_295;

export const DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 300;
export const MIN_CONTEXT_MESSAGES = 1;
export const MAX_CONTEXT_MESSAGES = 100;
export const DEFAULT_MAX_MESSAGE_RETRIES = 1;

export const WORKING_STATE_TTL_SECONDS = 10;
export const DEFAULT_STOPPED_RESYNC_SECONDS = 60;
/** Default `journalRetentionSeconds`. */
export const DEFAULT_JOURNAL_RETENTION_SECONDS = 3 * 60 * 60;

// Range checks apply only when reporting is enabled; dormant numeric settings are preserved.
const workingTiming = z.custom<number>((value) => typeof value === "number", "Expected a number");

export const sessionConfigSchema = z.object({
  enableWorkingState: z.boolean().default(true),
  workingKeepAliveSeconds: workingTiming.default(3),
  workingRequestTimeoutSeconds: workingTiming.default(DEFAULT_WORKING_REQUEST_TIMEOUT_SECONDS),
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
  /**
   * How often a room Band has stopped checks `/messages/next`, which Band
   * keeps empty while it is stopped, to find a play whose push was missed.
   * Bounded by what `setTimeout` can wait, which fires at once past that.
   */
  stoppedResyncSeconds: z.number().positive().max(MAX_SETTIMEOUT_DELAY_MS / MS_PER_SECOND).default(DEFAULT_STOPPED_RESYNC_SECONDS),
  /**
   * Directory for the durable turn journal. When set, each room records reply
   * settlement (posted, unknown, refused) and which messages' turns ended, bound
   * to the agent's platform identity, so a restart does not re-answer a settled
   * turn or silently drop an unresolved delivery Band may already hold.
   */
  journalDir: z.string().min(1).optional(),
  /**
   * @deprecated Accepted for compatibility with v1 journal configuration; the
   * v2 journal keeps its records for the life of the deployment and does not
   * expire them.
   */
  journalRetentionSeconds: z.number().positive().default(DEFAULT_JOURNAL_RETENTION_SECONDS),
  /**
   * The canonical platform endpoint the journal's records are bound to, when
   * the runtime speaks to Band through a custom REST adapter: such a link's
   * URL cannot stand for the platform, so the deployment names it. With a
   * standard link the journal derives the identity from the link's REST
   * endpoint, and a value set here must match it.
   */
  journalPlatformIdentity: z
    .string()
    .min(1)
    .refine(isCanonicalPlatformIdentity, "must be a canonical platform endpoint")
    .optional(),
}).superRefine((config, ctx) => {
  if (!config.enableWorkingState) return;
  const cadence = config.workingKeepAliveSeconds;
  const timeout = config.workingRequestTimeoutSeconds;
  for (const [field, valid] of [
    ["workingKeepAliveSeconds", Number.isFinite(cadence) && cadence > 0 && cadence < WORKING_STATE_TTL_SECONDS / 2],
    // A refresh starts a cadence after the previous response, so one slow response and one slow request must fit the TTL.
    ["workingRequestTimeoutSeconds", Number.isFinite(timeout) && timeout > 0 && timeout < cadence && cadence + 2 * timeout < WORKING_STATE_TTL_SECONDS],
    ["maxWorkingStateSeconds", config.maxWorkingStateSeconds === undefined || (Number.isFinite(config.maxWorkingStateSeconds) && config.maxWorkingStateSeconds > 0)],
  ] as const) {
    if (!valid) ctx.addIssue({ code: "custom", path: [field], message: "Invalid enabled working-state timing" });
  }
});

/** Total, as a schema check must be: an identity that is no URL at all is simply not canonical. */
function isCanonicalPlatformIdentity(value: string): boolean {
  try {
    return canonicalPlatformIdentity(value) === value;
  } catch {
    return false;
  }
}

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
