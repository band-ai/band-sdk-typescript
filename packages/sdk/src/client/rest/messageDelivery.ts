/**
 * At-least-once delivery of one message post. Band can commit a post and still
 * answer 5xx or never answer, and its text send takes no idempotency key. So
 * every attempt is made visibly, and one that may have committed is settled by
 * reading the room back before any resend: found means delivered, not found
 * means resend. A commit landing after the read-back costs a duplicate, never
 * a loss. No decision here reads a clock.
 */
import {
  HTTP_BAD_REQUEST,
  HTTP_REQUEST_TIMEOUT,
  HTTP_SERVER_ERROR,
  HTTP_TOO_MANY_REQUESTS,
  RoomExecutionStoppedError,
  RuntimeStateError,
  statusCodeOf,
} from "../../core/errors";
import { MAX_SETTIMEOUT_DELAY_MS, MS_PER_SECOND } from "../../core/deadline";
import type { Logger } from "../../core/logger";
import { MESSAGE_SEND_MAX_RETRIES } from "./requestOptions";
import type { PlatformChatMessage } from "./types";

/** The first pause before a resend; each later one doubles. Latency only, never a decision. */
const MESSAGE_RESEND_BASE_DELAY_MS = MS_PER_SECOND;

/** A mention as the agent sends it; Band rewrites the content from these fields. */
export interface SentMention {
  id: string;
  handle?: string;
  name?: string;
  username?: string;
  kind?: string;
}

const REFERENCE_MENTION_KIND = "reference";

/**
 * The content Band stores for `content` posted with `mentions`, mirroring its
 * rewrite: per mention, an existing `@[[id]]` stays; else every `@handle`,
 * else every `@name`, becomes `@[[id]]`; else the token is prepended, except
 * for a reference. Plain substring replacement, as Band's: `@bob` also
 * rewrites inside `@bobby`.
 */
export function predictStoredContent(content: string, mentions: readonly SentMention[]): string {
  return mentions.reduce((text, mention) => {
    const placeholder = `@[[${mention.id}]]`;
    const username = mention.name ?? mention.username;
    if (text.includes(placeholder)) return text;
    if (typeof mention.handle === "string" && text.includes(`@${mention.handle}`)) {
      return text.replaceAll(`@${mention.handle}`, placeholder);
    }
    if (typeof username === "string" && text.includes(`@${username}`)) {
      return text.replaceAll(`@${username}`, placeholder);
    }
    if (mention.kind === REFERENCE_MENTION_KIND) return text;
    return `${placeholder} ${text}`;
  }, content);
}

/** What identifies a post in the room: its stored content and the ids it mentions. */
export interface PostFingerprint {
  content: string;
  mentionIds: string;
}

export function sentFingerprint(content: string, mentions: readonly SentMention[]): PostFingerprint {
  return { content: predictStoredContent(content, mentions), mentionIds: mentionIdKey(mentions) };
}

export function storedFingerprint(message: PlatformChatMessage): PostFingerprint {
  const mentions = message.metadata?.mentions;
  const stored = Array.isArray(mentions)
    ? mentions.flatMap((entry: unknown) => {
      const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
      return typeof id === "string" ? [{ id }] : [];
    })
    : [];
  return { content: message.content, mentionIds: mentionIdKey(stored) };
}

function mentionIdKey(mentions: readonly Pick<SentMention, "id">[]): string {
  return mentions.map(({ id }) => id.toLowerCase()).sort().join(",");
}

export function sameFingerprint(a: PostFingerprint, b: PostFingerprint): boolean {
  return a.content === b.content && a.mentionIds === b.mentionIds;
}

/** Own posts already credited to a delivery in one room: a read-back never takes one for a later reply. */
export interface PostAttribution {
  has(id: string): boolean;
  add(id: string): void;
}

/**
 * A room's `PostAttribution`. Credits are kept for the life of the room's
 * delivery context: dropping one would let a still-in-room twin be claimed
 * again as a later reply, which loses that reply under at-least-once settle.
 */
export class AttributedPosts implements PostAttribution {
  private readonly ids = new Set<string>();

  public has(id: string): boolean {
    return this.ids.has(id);
  }

  public add(id: string): void {
    this.ids.add(id);
  }
}

/** Where a post may be read back: the turn it answers, and the room's credited posts. */
export interface MessageDelivery {
  /** The posting agent: a read-back matches only its own posts. */
  selfId: string;
  /** The turn's trigger. Band stamps a post when it arrives, so every reply sorts after it. */
  anchor: { id: string; createdAt: Date };
  attributed: PostAttribution;
  /** Ends a pause between attempts once the turn is cut short. */
  stopped?: AbortSignal;
}

/**
 * - `refused`: Band answered and saved nothing (an app 4xx, or the room is stopped).
 * - `notCommitted`: 408 or 429, which only infrastructure in front of Band sends.
 * - `uncertain`: a 5xx, no response, or a response that could not be read.
 */
type FailedAttempt = "refused" | "notCommitted" | "uncertain";

function classifyFailedAttempt(error: unknown): FailedAttempt {
  if (error instanceof RoomExecutionStoppedError) return "refused";
  const status = statusCodeOf(error);
  if (status === HTTP_REQUEST_TIMEOUT || status === HTTP_TOO_MANY_REQUESTS) return "notCommitted";
  if (status !== undefined && status >= HTTP_BAD_REQUEST && status < HTTP_SERVER_ERROR) return "refused";
  return "uncertain";
}

type Delivered<T> = { posted: T } | { found: PlatformChatMessage };

interface DeliverMessageOptions<T> {
  /** One attempt, with no retries of its own. */
  post: () => Promise<T>;
  /** The post's own message in the room, or null when not found or not readable. Absent: no read-back. */
  findPosted?: () => Promise<PlatformChatMessage | null>;
  stopped?: AbortSignal;
  logger: Logger;
  roomId: string;
}

/**
 * Posts until a status or a read-back shows the message in the room, within
 * `MESSAGE_SEND_MAX_RETRIES` resends; then the last failure surfaces.
 */
export async function deliverMessage<T>({ post, findPosted, stopped, logger, roomId }: DeliverMessageOptions<T>): Promise<Delivered<T>> {
  for (let attempt = 0; ; attempt += 1) {
    let failure: unknown;
    try {
      return { posted: await post() };
    } catch (error) {
      failure = error;
    }
    const outcome = classifyFailedAttempt(failure);
    const resendsLeft = attempt < MESSAGE_SEND_MAX_RETRIES;
    if (outcome === "refused" || (outcome === "notCommitted" && !resendsLeft)) throw failure;

    logger.warn("Message post failed; settling it before any resend", { roomId, attempt, outcome, status: statusCodeOf(failure) });
    // Before the read-back too: a commit still in flight gets the pause to land.
    await pause(resendDelayMs(attempt, failure), stopped);
    if (outcome === "uncertain" && findPosted) {
      const found = await findPosted();
      if (found) {
        logger.info("Message post found in the room; not resending", { roomId, attempt, messageId: found.id });
        return { found };
      }
    }
    if (!resendsLeft) throw failure;
    logger.warn("Resending a message post", { roomId, attempt: attempt + 1 });
  }
}

function resendDelayMs(attempt: number, failure: unknown): number {
  return retryAfterMs(failure) ?? MESSAGE_RESEND_BASE_DELAY_MS * 2 ** attempt;
}

/** The pause a `Retry-After` header in seconds asks for, capped for `setTimeout`. */
function retryAfterMs(failure: unknown): number | undefined {
  const headers = (failure as { rawResponse?: { headers?: Headers } } | undefined)?.rawResponse?.headers;
  const value = headers?.get?.("retry-after");
  const seconds = value === null || value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * MS_PER_SECOND, MAX_SETTIMEOUT_DELAY_MS)
    : undefined;
}

function pause(ms: number, stopped?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cut = () => reject(new RuntimeStateError("The turn was cut short; its message post stopped"));
    if (stopped?.aborted) {
      cut();
      return;
    }
    const timer = setTimeout(() => {
      stopped?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cut();
    };
    stopped?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A `/context` cursor positioned at `anchor`, so a walk reads only what Band
 * stored after it. Band's keyset cursor is base64url JSON `{t, i}` compared as
 * `(inserted_at, id) > (t, i)`; a millisecond `t` only widens the window.
 */
export function contextCursorAfter(anchor: MessageDelivery["anchor"]): string {
  return Buffer.from(JSON.stringify({ t: anchor.createdAt.toISOString(), i: anchor.id })).toString("base64url");
}

/** Whether `message` sorts strictly after `anchor` under Band's `(inserted_at, id)` keyset. */
export function sortsAfterAnchor(message: PlatformChatMessage, anchor: MessageDelivery["anchor"]): boolean {
  const at = Date.parse(message.inserted_at);
  const anchorAt = anchor.createdAt.getTime();
  return at > anchorAt || (at === anchorAt && message.id > anchor.id);
}
