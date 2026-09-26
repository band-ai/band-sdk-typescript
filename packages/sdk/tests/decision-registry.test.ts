/**
 * Room-level flows through the shared chat-mediated decision registry.
 *
 * Each test drives `DecisionRegistry` the way the adapters do (an asker waits
 * on every ask, replies claim and resolve, and whoever removes an open ask
 * resolves it), then checks the one outcome every asker ends up with.
 * Deadlines run on vitest's fake clock; every other ordering is set by what
 * the flow observably did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeferred, type Deferred } from "../src/core/deferred";
import { DecisionRegistry, TIMED_OUT, type DecisionEntry, type TimedOut } from "../src/adapters/shared/decisions";
import { RecordLog } from "./testUtils";

type Outcome = string | TimedOut;

// Distinct deadlines fix which of two expiries is due first.
const SHORT_DEADLINE_MS = 30_000;
const DEADLINE_MS = 60_000;

interface Ask {
  name: string;
  answer: Deferred<string>;
}

const anAsk = (name: string): Ask => ({ name, answer: createDeferred<string>() });

/** An adapter's side of the registry: each ask gets a waiting asker, and every open ask the registry hands back is resolved with why it went. */
class Room {
  public readonly registry: DecisionRegistry<Ask>;
  private readonly askers = new Map<string, Promise<Outcome>>();

  public constructor(options: { maxPending?: number } = {}) {
    this.registry = new DecisionRegistry(options);
  }

  public ask(name: string, options: { key?: string; roomId?: string; timeoutMs?: number } = {}): DecisionEntry<Ask> | null {
    const ask = anAsk(name);
    const registration = options.key === undefined
      ? this.registry.registerMinted(ask, { roomId: options.roomId })
      : this.registry.registerKeyed(ask, { key: options.key });
    if (!registration) {
      return null;
    }
    for (const removed of registration.removed) {
      removed.payload.answer.resolve(removed.token === registration.entry.token ? "replaced" : "evicted");
    }
    this.askers.set(name, this.registry.wait(registration.entry, ask.answer.promise, { timeoutMs: options.timeoutMs ?? DEADLINE_MS }));
    return registration.entry;
  }

  public outcome(name: string): Promise<Outcome> {
    return this.askers.get(name)!;
  }

  /** A room reply: claim, then resolve with no await in between. */
  public reply(token: string, answer: string): boolean {
    const entry = this.registry.tryClaim(token);
    entry?.payload.answer.resolve(answer);
    return entry !== null;
  }

  /** The asker's turn gave up on the ask, as an aborted permission does. */
  public abandon(entry: DecisionEntry<Ask>): void {
    if (this.registry.withdraw(entry)) {
      entry.payload.answer.resolve("abandoned");
    }
  }

  public tearDown(roomId: string): void {
    for (const entry of this.registry.cancelRoom(roomId)) {
      entry.payload.answer.resolve("cancelled");
    }
  }

  public async outcomes(): Promise<Record<string, Outcome>> {
    return Object.fromEntries(await Promise.all([...this.askers].map(async ([name, asker]) => [name, await asker])));
  }
}

/** An `onTimeout` callback that records which asks expired. */
class Expiries {
  private readonly log = new RecordLog<string>();

  public get names(): readonly string[] {
    return this.log.entries;
  }

  public readonly record = (entry: DecisionEntry<Ask>): void => this.log.record(entry.payload.name);

  public async until(name: string): Promise<void> {
    await this.log.next((expired) => expired === name);
  }
}

const namesOf = (entries: Iterable<DecisionEntry<Ask>>) => [...entries].map((entry) => entry.payload.name);

describe("DecisionRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives every asker in a busy room exactly one outcome", async () => {
    // At capacity with a reply mid-flight: the oldest open ask is evicted (never the claimed one), a redelivery
    // supersedes its predecessor without evicting, a redelivery of the claimed ask is refused, the claimant's
    // late answer still wins past the deadline, and the rest time out.
    const room = new Room({ maxPending: 2 });
    room.ask("a", { key: "a", timeoutMs: SHORT_DEADLINE_MS });
    room.ask("b", { key: "b" });
    const claimed = room.registry.tryClaim("a")!;

    room.ask("c1", { key: "c" });
    room.ask("c2", { key: "c" });
    expect(room.ask("a-again", { key: "a" })).toBeNull();
    expect(["a", "b", "c"].filter((key) => room.registry.has(key))).toEqual(["a", "c"]);

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(await room.outcome("c2")).toBe(TIMED_OUT);
    claimed.payload.answer.resolve("accept");

    expect(await room.outcomes()).toEqual({ a: "accept", b: "evicted", c1: "replaced", c2: TIMED_OUT });
    expect(room.registry.size).toBe(0);
    expect(room.reply("c", "accept")).toBe(false);
  });

  it("resolves only a torn-down room's open asks", async () => {
    // Teardown resolves the room's open asks, leaves a claimed one to its claimant, and never touches another room.
    const room = new Room();
    room.ask("open", { roomId: "room-1" });
    const claimedAsk = room.ask("claimed", { roomId: "room-1" })!;
    room.ask("elsewhere", { roomId: "room-2" });
    const abandoned = room.ask("abandoned", { roomId: "room-2" })!;
    const claimed = room.registry.tryClaim(claimedAsk.token)!;

    room.tearDown("room-1");
    claimed.payload.answer.resolve("accept");
    room.abandon(abandoned);

    const [survivor] = room.registry.unclaimedInRoom("room-2");
    expect(survivor?.payload.name).toBe("elsewhere");
    expect(room.reply(survivor!.token, "decline")).toBe(true);
    expect(await room.outcomes()).toEqual({ open: "cancelled", claimed: "accept", elsewhere: "decline", abandoned: "abandoned" });
    expect(room.registry.size).toBe(0);
  });

  it("races expiry timers against replies, redeliveries and teardown", async () => {
    // A reply before the deadline stops that ask's timer; a redelivery drops its predecessor's timer and a stale
    // handle can't arm a new one; and teardown during an expiry that already claimed its ask lets it finish.
    const registry = new DecisionRegistry<Ask>();
    const expiries = new Expiries();
    const replying = createDeferred();
    const release = createDeferred();
    const slowExpiry = async (entry: DecisionEntry<Ask>) => {
      replying.resolve();
      await release.promise;
      expiries.record(entry);
    };
    const ask = (name: string, key: string) => registry.registerKeyed(anAsk(name), { key })!.entry;

    registry.startTimeout(ask("answered", "p1"), SHORT_DEADLINE_MS, expiries.record);
    const first = ask("first", "p2");
    registry.startTimeout(first, SHORT_DEADLINE_MS, expiries.record);
    const redelivery = ask("redelivery", "p2");
    registry.startTimeout(first, SHORT_DEADLINE_MS, expiries.record);
    registry.startTimeout(redelivery, DEADLINE_MS, expiries.record);
    registry.startTimeout(ask("slow", "p3"), 0, slowExpiry);
    expect(registry.tryClaim("p1")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await replying.promise;
    expect(expiries.names).toEqual(["redelivery"]);

    expect(registry.cancelAll()).toEqual([]);
    release.resolve();
    await expiries.until("slow");
    expect(expiries.names).toEqual(["redelivery", "slow"]);
  });

  it("never lets a stale handle act on a newer registration", async () => {
    // A handle outlives its registration (replaced by a redelivery, or issued by a registry teardown has since
    // replaced), and every operation through it must leave the newer registration alone.
    const registry = new DecisionRegistry<Ask>();
    const expiries = new Expiries();
    const oldAsk = anAsk("old");
    const old = registry.registerKeyed(oldAsk, { key: "k" })!;
    const replacement = registry.registerKeyed(anAsk("new"), { key: "k" })!;
    expect(replacement.removed).toEqual([old.entry]);

    registry.forget(old.entry);
    expect(registry.withdraw(old.entry)).toBe(false);
    registry.startTimeout(old.entry, 0, expiries.record);
    const waited = registry.wait(old.entry, oldAsk.answer.promise, { timeoutMs: DEADLINE_MS });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(await waited).toBe(TIMED_OUT);
    expect(expiries.names).toEqual([]);

    const fresh = new DecisionRegistry<Ask>();
    fresh.registerKeyed(anAsk("fresh"), { key: "k" });
    fresh.forget(old.entry);
    expect(fresh.withdraw(old.entry)).toBe(false);

    expect(namesOf(registry.unclaimed())).toEqual(["new"]);
    expect(namesOf(fresh.unclaimed())).toEqual(["fresh"]);
  });
});
