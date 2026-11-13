import { BandClient } from "@band-ai/rest-client";

import { FernRestAdapter } from "../../src/client/rest/FernRestAdapter";
import type { FernBandClientLike, PlatformChatMessage } from "../../src/client/rest/types";

export const SELF_ID = "agent-self";

/** What Band does with one POST of a message. */
export type PostStep =
  | { kind: "created" }
  /** Stored, then answered with `status`, as Band can after a commit. */
  | { kind: "committedThen"; status: number }
  /** Stored, and no response ever arrives: the client gives up. */
  | { kind: "committedNoResponse" }
  /** Answered with `status` and nothing stored. */
  | { kind: "refused"; status: number; body?: unknown; headers?: Record<string, string> }
  /** Answered with `status` now and stored only once `release` resolves: a commit still in flight. */
  | { kind: "commitsOnRelease"; status: number; release: Promise<void> };

interface StoredMessage extends PlatformChatMessage {
  readonly order: number;
}

const BASE_MS = Date.UTC(2026, 0, 1);
/** Band's agent text send accepts these fields and refuses any other. */
const MESSAGE_FIELDS = new Set(["content", "mentions", "attachment_ids"]);
const AGENT_PATH = /^\/api\/v1\/agent\/chats\/([^/]+)\/(messages|context)$/;

/**
 * Band's agent message endpoints for one room, under the real generated
 * client: a post is stamped when it arrives, `/context` serves the room oldest
 * first with Band's `{t, i}` keyset cursors, and each POST follows the next
 * scripted step. The content Band stores for a post is given by the test, so
 * this fake never computes Band's mention rewrite.
 */
export class FakeBandRoom {
  public readonly stored: StoredMessage[] = [];
  public readonly posts: string[] = [];
  public readonly contextCursors: Array<string | undefined> = [];
  private readonly steps: PostStep[] = [];
  private contextFailures = 0;
  private readonly issuedCursors = new Set<string>();
  private onlyIssuedCursors = false;
  private stamps = 0;
  private commits = 0;
  private postWaiters: Array<{ count: number; resolve: () => void }> = [];

  public constructor(
    public readonly roomId: string,
    /** The content Band stores for each posted content. */
    private readonly storedForm: Readonly<Record<string, string>>,
  ) {}

  /** A message already in the room, stamped now. */
  public seed(message: { id: string; content: string; senderId: string; mentionIds?: string[] }): StoredMessage {
    return this.storeAt(this.nextStamp(), message.id, message.content, message.senderId, message.mentionIds ?? []);
  }

  public script(...steps: PostStep[]): void {
    this.steps.push(...steps);
  }

  /** The next `count` `/context` reads answer 500. */
  public failContext(count: number): void {
    this.contextFailures += count;
  }

  /** From now on, a cursor this room did not hand out answers 422, as for a format Band no longer reads. */
  public refuseForeignCursors(): void {
    this.onlyIssuedCursors = true;
  }

  /** Resolves once `count` POSTs have arrived. */
  public posted(count: number): Promise<void> {
    if (this.posts.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.postWaiters.push({ count, resolve }));
  }

  /** A `FernRestAdapter` whose requests reach this room, built as a caller supplying its own REST client would. */
  public adapter(): FernRestAdapter {
    const client = new BandClient({ apiKey: "test-key", baseUrl: "http://fake-band.test", fetch: this.fetch }) as unknown as FernBandClientLike;
    return new FernRestAdapter(client);
  }

  private readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const match = AGENT_PATH.exec(url.pathname);
    if (!match || match[1] !== this.roomId) throw new Error(`FakeBandRoom: unsupported ${method} ${url.pathname}`);
    if (match[2] === "context" && method === "GET") return this.readContext(url.searchParams);
    if (match[2] === "messages" && method === "POST") return this.receivePost(String(init?.body ?? ""), init?.signal ?? undefined);
    throw new Error(`FakeBandRoom: unsupported ${method} ${url.pathname}`);
  }) as typeof fetch;

  private receivePost(rawBody: string, signal: AbortSignal | undefined): Promise<Response> | Response {
    const message = (JSON.parse(rawBody) as { message: Record<string, unknown> }).message;
    const unexpected = Object.keys(message).filter((key) => !MESSAGE_FIELDS.has(key));
    const mentions = (message.mentions ?? []) as Array<{ id: string }>;
    if (unexpected.length > 0 || mentions.length === 0) return json(422, { error: { code: "validation_error", message: "Unexpected field or no mentions" } });

    const content = String(message.content);
    this.posts.push(content);
    this.notifyPost();
    const step = this.steps.shift();
    if (!step) throw new Error(`FakeBandRoom: no step scripted for POST #${this.posts.length}`);
    const stamp = this.nextStamp();
    const commit = () => {
      this.commits += 1;
      return this.storeAt(stamp, `stored-${this.commits}`, this.storedContent(content), SELF_ID, mentions.map(({ id }) => id));
    };
    switch (step.kind) {
      case "created":
        return json(201, { data: { id: commit().id, success: true, recipients: [] } });
      case "committedThen":
        commit();
        return json(step.status, { error: { code: "service_unavailable", message: "Unavailable" } });
      case "committedNoResponse":
        commit();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      case "refused":
        return json(step.status, step.body ?? { error: { code: "refused", message: "Refused" } }, step.headers);
      case "commitsOnRelease":
        void step.release.then(commit);
        return json(step.status, { error: { code: "service_unavailable", message: "Unavailable" } });
    }
  }

  private readContext(params: URLSearchParams): Response {
    const cursor = params.get("cursor") ?? undefined;
    this.contextCursors.push(cursor);
    if (this.contextFailures > 0) {
      this.contextFailures -= 1;
      return json(500, { error: { code: "internal", message: "Internal error" } });
    }
    const foreign = cursor !== undefined && this.onlyIssuedCursors && !this.issuedCursors.has(cursor);
    const after = cursor === undefined ? null : foreign ? undefined : decodeCursor(cursor);
    if (after === undefined) return json(422, { error: { code: "invalid_cursor", message: "Invalid cursor" } });
    const limit = Number(params.get("limit") ?? 50);
    const ordered = [...this.stored].sort((a, b) => a.order - b.order);
    const rest = after === null ? ordered : ordered.filter((message) => isAfter(message, after));
    const page = rest.slice(0, limit);
    const last = page.at(-1);
    const hasMore = rest.length > limit;
    const next = hasMore && last ? encodeCursor(last) : undefined;
    if (next) this.issuedCursors.add(next);
    return json(200, {
      data: page.map(({ order: _order, ...message }) => message),
      metadata: { has_more: hasMore, ...(next ? { next_cursor: next } : {}) },
    });
  }

  private storedContent(content: string): string {
    const stored = this.storedForm[content];
    if (stored === undefined) throw new Error(`FakeBandRoom: no stored form given for ${JSON.stringify(content)}`);
    return stored;
  }

  private storeAt(order: number, id: string, content: string, senderId: string, mentionIds: string[]): StoredMessage {
    const message: StoredMessage = {
      order,
      id,
      content,
      sender_id: senderId,
      sender_type: senderId === SELF_ID ? "Agent" : "User",
      message_type: "text",
      metadata: { mentions: mentionIds.map((id) => ({ id, kind: "mention" })) },
      inserted_at: new Date(BASE_MS + order).toISOString(),
    };
    this.stored.push(message);
    return message;
  }

  private nextStamp(): number {
    this.stamps += 1;
    return this.stamps;
  }

  private notifyPost(): void {
    const ready = this.postWaiters.filter(({ count }) => this.posts.length >= count);
    this.postWaiters = this.postWaiters.filter(({ count }) => this.posts.length < count);
    for (const { resolve } of ready) resolve();
  }
}

/** Band's `(inserted_at, id) > (t, i)` keyset comparison. */
function isAfter(message: PlatformChatMessage, after: { t: number; i: string }): boolean {
  const at = Date.parse(message.inserted_at);
  return at > after.t || (at === after.t && message.id > after.i);
}

function encodeCursor(message: PlatformChatMessage): string {
  return Buffer.from(JSON.stringify({ t: message.inserted_at, i: message.id })).toString("base64url");
}

/** The cursor's position; undefined for one Band cannot read. */
function decodeCursor(cursor: string): { t: number; i: string } | undefined {
  try {
    const { t, i } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    const at = typeof t === "string" ? Date.parse(t) : Number.NaN;
    return Number.isFinite(at) && typeof i === "string" ? { t: at, i } : undefined;
  } catch {
    return undefined;
  }
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
