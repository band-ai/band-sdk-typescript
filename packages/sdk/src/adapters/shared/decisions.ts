/**
 * Chat-mediated decisions over band-sdk-core's `DecisionRegistry`: core owns
 * the claim, eviction and ticket rules; this wrapper owns payloads, timers and
 * reads, from a `Map` that mirrors core's order by construction.
 */
import {
  DecisionRegistry as CoreDecisionRegistry,
  type CancelledDecisions,
  type ClaimOutcome,
} from "@band-ai/band-sdk-core";

import { resolveLogger, type Logger } from "../../core/logger";
import { abandon } from "./abandon";

export const TIMED_OUT: unique symbol = Symbol("decision timed out");
export type TimedOut = typeof TIMED_OUT;

/** One registration: the handle its asker, timer and waiter act through. Its ticket goes stale once a redelivery replaces it. */
export interface DecisionEntry<T> {
  readonly token: string;
  readonly ticket: bigint;
  readonly payload: T;
}

/** A new entry, plus any open ask registering it removed, for the caller to resolve. */
export interface Registration<T> {
  readonly entry: DecisionEntry<T>;
  readonly evicted: DecisionEntry<T> | null;
  readonly replaced: DecisionEntry<T> | null;
  readonly removed: readonly DecisionEntry<T>[];
}

/** A configured allowlist in the shape core's `isAuthorizedSender` takes: null admits anyone; any list, empty included, only its members. */
export function senderAllowlist(senders?: Iterable<string> | null): ReadonlySet<string> | null {
  return senders == null ? null : new Set(senders);
}

/** Pending asks by token, oldest first. Without `maxPending` it never evicts. */
export class DecisionRegistry<T> implements Iterable<DecisionEntry<T>> {
  private readonly core: CoreDecisionRegistry;
  private readonly entries = new Map<string, DecisionEntry<T>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly logger: Logger;

  public constructor(options: { maxPending?: number; logger?: Logger } = {}) {
    this.core = new CoreDecisionRegistry(options.maxPending ?? null);
    this.logger = resolveLogger(options.logger);
  }

  public get(token: string): T | undefined {
    return this.entries.get(token)?.payload;
  }

  public has(token: string): boolean {
    return this.entries.has(token);
  }

  public get size(): number {
    return this.entries.size;
  }

  public keys(): string[] {
    return [...this.entries.keys()];
  }

  public [Symbol.iterator](): Iterator<DecisionEntry<T>> {
    return this.entries.values();
  }

  /** Adds `payload` under a minted token, evicting the oldest open ask first when at capacity. */
  public registerMinted(payload: T, options: { roomId?: string } = {}): Registration<T> {
    const evicted = this.evictOldest();
    const registered = this.core.registerMinted(options.roomId ?? null);
    if (!registered) {
      throw new Error("DecisionRegistry ran out of tickets");
    }
    return registration(this.store(payload, ...registered), evicted, null);
  }

  /** Adds `payload` under `key`; a redelivery replaces its open predecessor in place, so only a new key evicts. Null while the key is claimed. */
  public registerKeyed(payload: T, options: { key: string }): Registration<T> | null {
    const replaced = this.entries.get(options.key) ?? null;
    const evicted = replaced ? null : this.evictOldest();
    const registered = this.core.registerKeyed(options.key);
    if (!registered) {
      return null;
    }
    return registration(this.store(payload, ...registered), evicted, replaced);
  }

  /** Claims `entry` after `timeoutMs` and hands it to `onTimeout`, unless a reply claims it first. */
  public startTimeout(entry: DecisionEntry<T>, timeoutMs: number, onTimeout: (entry: DecisionEntry<T>) => Promise<void> | void): void {
    // `setTimeout` coerces Infinity to 1ms, so "unbounded" must never arm.
    if (!this.holds(entry) || !Number.isFinite(timeoutMs)) {
      return;
    }
    this.cancelTimer(entry.token);
    const timer = setTimeout(() => {
      // The running expiry owns its outcome once it claims, so a later discard must not find it.
      if (this.timers.get(entry.token) === timer) {
        this.timers.delete(entry.token);
      }
      if (this.claim(entry) !== "claimed") {
        return;
      }
      abandon(async () => onTimeout(entry), (error) => {
        this.logger.warn("decisions.timeout_handler_failed", { token: entry.token, error });
      });
    }, timeoutMs);
    this.timers.set(entry.token, timer);
  }

  /** Takes ownership of whatever registration holds `token`; null if someone else has. Resolve without awaiting in between: a waiter defers to the claim. */
  public tryClaim(token: string): DecisionEntry<T> | null {
    const entry = this.entries.get(token);
    return entry && this.claim(entry) === "claimed" ? entry : null;
  }

  /** Drops `entry` if nobody claimed it; false when a claimant owns it or it was replaced or removed. */
  public withdraw(entry: DecisionEntry<T>): boolean {
    if (!this.holds(entry) || !this.core.withdraw(entry.token, entry.ticket)) {
      return false;
    }
    this.discard(entry.token);
    return true;
  }

  /** Drops `entry`, claimed or not, leaving any newer registration of its token intact. */
  public forget(entry: DecisionEntry<T>): void {
    if (this.holds(entry) && this.core.forget(entry.token, entry.ticket)) {
      this.discard(entry.token);
    }
  }

  /** The answer to `entry`, or TIMED_OUT if the deadline claims it first or it was replaced; a reply that claimed it first is always waited for. */
  public async wait<R>(entry: DecisionEntry<T>, answer: Promise<R>, options: { timeoutMs: number }): Promise<R | TimedOut> {
    let settled: { value: R } | undefined;
    const answered = answer.then((value) => (settled = { value }));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!Number.isFinite(options.timeoutMs)) {
        return await answer;
      }
      const first = await Promise.race([
        answered,
        new Promise<TimedOut>((resolve) => {
          deadline = setTimeout(() => resolve(TIMED_OUT), options.timeoutMs);
        }),
      ]);
      if (first !== TIMED_OUT) {
        return first.value;
      }
      // Whoever removed the ask in the deadline's own tick resolved it.
      if (settled) {
        return settled.value;
      }
      if (this.claim(entry) === "already_claimed") {
        this.logger.debug("decisions.deadline_deferred_to_claimant", { token: entry.token });
        return await answer;
      }
      return TIMED_OUT;
    } finally {
      clearTimeout(deadline);
      this.forget(entry);
    }
  }

  /** Entries still awaiting an answer: what a room should see as pending. */
  public unclaimed(): DecisionEntry<T>[] {
    return this.entriesFor(this.core.unclaimed());
  }

  public unclaimedInRoom(roomId: string): DecisionEntry<T>[] {
    return this.entriesFor(this.core.unclaimedInRoom(roomId));
  }

  public unclaimedCount(): number {
    return this.core.unclaimedCount();
  }

  public oldestUnclaimed(): DecisionEntry<T> | null {
    const token = this.core.oldestUnclaimed();
    return token === undefined ? null : this.entries.get(token) ?? null;
  }

  /** Unlike `size`, ignores an entry whose claimant is still resolving it. */
  public hasUnclaimed(): boolean {
    return this.unclaimedCount() > 0;
  }

  public hasClaimed(): boolean {
    return this.size > this.unclaimedCount();
  }

  /** Removes every entry, returning the unclaimed ones for the caller to resolve; a claimed entry's claimant still resolves it. */
  public cancelAll(): DecisionEntry<T>[] {
    return this.dropCancelled(this.core.cancelAll());
  }

  public cancelRoom(roomId: string): DecisionEntry<T>[] {
    return this.dropCancelled(this.core.cancelRoom(roomId));
  }

  // Tickets restart per registry, so an entry from a replaced registry could otherwise match a fresh one.
  private holds(entry: DecisionEntry<T>): boolean {
    return this.entries.get(entry.token) === entry;
  }

  private claim(entry: DecisionEntry<T>): ClaimOutcome {
    if (!this.holds(entry)) {
      return "stale";
    }
    const outcome = this.core.tryClaim(entry.token, entry.ticket);
    if (outcome === "claimed") {
      this.cancelTimer(entry.token);
    }
    return outcome;
  }

  private store(payload: T, token: string, ticket: bigint): DecisionEntry<T> {
    this.cancelTimer(token);
    const entry = Object.freeze({ token, ticket, payload });
    this.entries.set(token, entry);
    return entry;
  }

  private evictOldest(): DecisionEntry<T> | null {
    const token = this.core.evictOldest();
    return token === undefined ? null : this.discard(token);
  }

  private entriesFor(tokens: readonly string[]): DecisionEntry<T>[] {
    return tokens.map((token) => this.entries.get(token)!);
  }

  private dropCancelled(cancelled: CancelledDecisions): DecisionEntry<T>[] {
    const unclaimed = this.entriesFor(cancelled.unclaimed);
    [...cancelled.unclaimed, ...cancelled.claimed].forEach((token) => this.discard(token));
    return unclaimed;
  }

  private discard(token: string): DecisionEntry<T> {
    this.cancelTimer(token);
    const entry = this.entries.get(token)!;
    this.entries.delete(token);
    return entry;
  }

  private cancelTimer(token: string): void {
    clearTimeout(this.timers.get(token));
    this.timers.delete(token);
  }
}

function registration<T>(entry: DecisionEntry<T>, evicted: DecisionEntry<T> | null, replaced: DecisionEntry<T> | null): Registration<T> {
  return { entry, evicted, replaced, removed: [evicted, replaced].filter((removed) => removed !== null) };
}
