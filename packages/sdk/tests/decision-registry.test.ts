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

  it("evicts the oldest open ask at capacity, never a claimed one", async () => {
    const room = new Room({ maxPending: 2 });
    room.ask("a", { key: "a" });
    room.ask("b", { key: "b" });
    const claimed = room.registry.tryClaim("a")!;

    room.ask("c", { key: "c" });
    expect(["a", "b", "c"].filter((key) => room.registry.has(key))).toEqual(["a", "c"]);
    expect(await room.outcome("b")).toBe("evicted");
    claimed.payload.answer.resolve("accept");
    expect(room.reply("c", "decline")).toBe(true);

    expect(await room.outcomes()).toEqual({ a: "accept", b: "evicted", c: "decline" });
    expect(room.registry.size).toBe(0);
  });

  it("lets a redelivery replace its predecessor without evicting another ask", async () => {
    const room = new Room({ maxPending: 2 });
    room.ask("a", { key: "a" });
    room.ask("c1", { key: "c" });

    room.ask("c2", { key: "c" });
    expect(["a", "c"].filter((key) => room.registry.has(key))).toEqual(["a", "c"]);
    expect(room.reply("c", "accept")).toBe(true);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);

    expect(await room.outcomes()).toEqual({ a: TIMED_OUT, c1: "replaced", c2: "accept" });
    expect(room.registry.size).toBe(0);
  });

  it("refuses a redelivery of a claimed ask, leaving it to its claimant", async () => {
    const room = new Room();
    room.ask("a", { key: "a" });
    const claimed = room.registry.tryClaim("a")!;

    expect(room.ask("a-again", { key: "a" })).toBeNull();
    expect(room.registry.has("a")).toBe(true);
    claimed.payload.answer.resolve("accept");

    expect(await room.outcomes()).toEqual({ a: "accept" });
    expect(room.registry.size).toBe(0);
  });

  it("lets a claimant's late answer beat the deadline, while unclaimed asks time out", async () => {
    const room = new Room();
    room.ask("a", { key: "a", timeoutMs: SHORT_DEADLINE_MS });
    room.ask("b", { key: "b" });
    const claimed = room.registry.tryClaim("a")!;

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(await room.outcome("b")).toBe(TIMED_OUT);
    claimed.payload.answer.resolve("accept");

    expect(await room.outcomes()).toEqual({ a: "accept", b: TIMED_OUT });
    expect(room.registry.size).toBe(0);
    expect(room.reply("b", "accept")).toBe(false);
  });

  it("resolves a torn-down room's open asks, and leaves a claimed one to its claimant", async () => {
    const room = new Room();
    room.ask("open", { roomId: "room-1" });
    const claimedAsk = room.ask("claimed", { roomId: "room-1" })!;
    const claimed = room.registry.tryClaim(claimedAsk.token)!;

    room.tearDown("room-1");
    expect(await room.outcome("open")).toBe("cancelled");
    claimed.payload.answer.resolve("accept");

    expect(await room.outcomes()).toEqual({ open: "cancelled", claimed: "accept" });
    expect(room.registry.size).toBe(0);
  });

  it("never touches another room's asks on teardown", async () => {
    const room = new Room();
    room.ask("torn-down", { roomId: "room-1" });
    room.ask("elsewhere", { roomId: "room-2" });
    const abandoned = room.ask("abandoned", { roomId: "room-2" })!;

    room.tearDown("room-1");
    room.abandon(abandoned);

    const [survivor] = room.registry.unclaimedInRoom("room-2");
    expect(survivor?.payload.name).toBe("elsewhere");
    expect(room.reply(survivor!.token, "decline")).toBe(true);
    expect(await room.outcomes()).toEqual({ "torn-down": "cancelled", elsewhere: "decline", abandoned: "abandoned" });
    expect(room.registry.size).toBe(0);
  });

  it("stops an ask's expiry timer once a reply claims it", async () => {
    const registry = new DecisionRegistry<Ask>();
    const expiries = new Expiries();
    registry.startTimeout(registry.registerKeyed(anAsk("answered"), { key: "p1" })!.entry, SHORT_DEADLINE_MS, expiries.record);
    registry.startTimeout(registry.registerKeyed(anAsk("unanswered"), { key: "p2" })!.entry, DEADLINE_MS, expiries.record);

    expect(registry.tryClaim("p1")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);

    expect(expiries.names).toEqual(["unanswered"]);
  });

  it("drops a redelivered ask's old timer, and never lets its stale handle arm another", async () => {
    const registry = new DecisionRegistry<Ask>();
    const expiries = new Expiries();
    const first = registry.registerKeyed(anAsk("first"), { key: "p" })!.entry;
    registry.startTimeout(first, SHORT_DEADLINE_MS, expiries.record);

    const redelivery = registry.registerKeyed(anAsk("redelivery"), { key: "p" })!.entry;
    registry.startTimeout(first, SHORT_DEADLINE_MS, expiries.record);
    registry.startTimeout(redelivery, DEADLINE_MS, expiries.record);
    await vi.advanceTimersByTimeAsync(SHORT_DEADLINE_MS);
    expect(expiries.names).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - SHORT_DEADLINE_MS);

    expect(expiries.names).toEqual(["redelivery"]);
  });

  it("lets an expiry that already claimed its ask finish through a teardown", async () => {
    const registry = new DecisionRegistry<Ask>();
    const expiries = new Expiries();
    const replying = createDeferred();
    const release = createDeferred();
    registry.startTimeout(registry.registerKeyed(anAsk("slow"), { key: "p" })!.entry, 0, async (entry) => {
      replying.resolve();
      await release.promise;
      expiries.record(entry);
    });

    await vi.advanceTimersByTimeAsync(0);
    await replying.promise;
    expect(registry.cancelAll()).toEqual([]);
    release.resolve();

    await expiries.until("slow");
    expect(expiries.names).toEqual(["slow"]);
  });

  it("never lets a handle replaced by a redelivery act on its successor", async () => {
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
    expect(namesOf(registry.unclaimed())).toEqual(["new"]);
  });

  it("never lets a handle from a registry since replaced act on the new registry's ask", () => {
    const stale = new DecisionRegistry<Ask>().registerKeyed(anAsk("old"), { key: "k" })!.entry;
    const fresh = new DecisionRegistry<Ask>();
    fresh.registerKeyed(anAsk("fresh"), { key: "k" });

    fresh.forget(stale);
    expect(fresh.withdraw(stale)).toBe(false);

    expect(namesOf(fresh.unclaimed())).toEqual(["fresh"]);
  });
});
