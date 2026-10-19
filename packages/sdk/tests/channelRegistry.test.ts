import type { Socket } from "phoenix";
import { describe, expect, it } from "vitest";
import { Epoch } from "../src/core/epoch";
import { NoopLogger } from "../src/core/logger";
import { ChannelRegistry } from "../src/platform/streaming/ChannelRegistry";
import type { JoinOptions } from "../src/platform/streaming/transport";
import { RecordLog } from "./testUtils";

/*
 * Phoenix 1.8.14 acknowledges `channel.leave()` locally and at once, so a held
 * or failed graceful leave cannot be produced on the real wire. These tests
 * drive the registry through the one boundary that can: a socket whose
 * channels answer leave pushes on the test's schedule. Everything else about
 * the registry is the production code.
 */

type Status = "ok" | "error" | "timeout";

class FakePush {
  private outcome: { status: Status; response: unknown } | null = null;
  private readonly receivers = new Map<Status, Array<(response: unknown) => void>>();

  public receive(status: Status, callback: (response: unknown) => void): this {
    if (this.outcome?.status === status) callback(this.outcome.response);
    this.receivers.set(status, [...(this.receivers.get(status) ?? []), callback]);
    return this;
  }

  public settle(status: Status, response: unknown = {}): void {
    this.outcome = { status, response };
    for (const callback of this.receivers.get(status) ?? []) callback(response);
  }
}

class FakeChannel {
  public readonly joinPush = new FakePush();
  public readonly leavePushes: FakePush[] = [];
  private nextRef = 0;
  private readonly bindings = new Map<number, { event: string; callback: (payload: Record<string, unknown>) => void }>();

  public constructor(public readonly topic: string) {}

  public on(event: string, callback: (payload: Record<string, unknown>) => void): number {
    this.bindings.set(++this.nextRef, { event, callback });
    return this.nextRef;
  }

  public off(_event: string, ref: number): void {
    this.bindings.delete(ref);
  }

  public join(): FakePush {
    return this.joinPush;
  }

  public leave(): FakePush {
    const push = new FakePush();
    this.leavePushes.push(push);
    return push;
  }

  public get boundHandlers(): number {
    return this.bindings.size;
  }

  public deliver(event: string, payload: Record<string, unknown> = {}): void {
    for (const binding of [...this.bindings.values()]) {
      if (binding.event === event) binding.callback(payload);
    }
  }
}

class FakeSocket {
  public readonly channels: FakeChannel[] = [];
  public readonly removed: FakeChannel[] = [];

  public channel(topic: string): FakeChannel {
    const channel = new FakeChannel(topic);
    this.channels.push(channel);
    return channel;
  }

  public remove(channel: FakeChannel): void {
    this.removed.push(channel);
  }
}

const optional: JoinOptions = { blocksReconnect: false, exemptFromBuffering: true };

function registryKit() {
  const socket = new FakeSocket();
  const epoch = new Epoch();
  const left = new RecordLog<string>();
  const settled = new RecordLog<string>();
  const registry = new ChannelRegistry(socket as unknown as Socket, epoch, new NoopLogger(), {
    wrapHandler: (_topic, _event, handler) => (payload) => void handler(payload),
    onJoinSettled: (topic, joined) => settled.record(`${topic}:${joined}`),
    onLeft: (topic) => left.record(topic),
  });
  return { socket, registry, left, settled };
}

async function joined(kit: ReturnType<typeof registryKit>, topic: string, options: JoinOptions, handlers: Record<string, () => void> = {}) {
  const joining = kit.registry.join(topic, handlers, options);
  const channel = kit.socket.channels.at(-1)!;
  channel.joinPush.settle("ok", { snapshot: topic });
  await joining;
  return channel;
}

describe("ChannelRegistry retirement when a graceful leave does not complete", () => {
  it("retires an optional channel locally after a failed leave, so the same topic restarts on a fresh channel", async () => {
    const kit = registryKit();
    const unavailable = new RecordLog<string>();
    const old = await joined(kit, "t", { ...optional, onUnavailable: () => unavailable.record("lost") }, { changed: () => undefined });

    const leaving = kit.registry.leave("t");
    const failed = expect(leaving).rejects.toThrow("Failed to leave topic t");
    old.leavePushes[0]!.settle("error");
    await failed;

    expect(unavailable.entries).toEqual(["lost"]);
    expect(old.boundHandlers).toBe(0);
    expect(kit.socket.removed).toEqual([old]);
    expect(kit.registry.isJoined("t")).toBe(false);
    expect(kit.left.entries).toEqual(["t"]);

    const replacement = await joined(kit, "t", optional);
    expect(replacement).not.toBe(old);
    expect(kit.registry.isJoined("t")).toBe(true);
  });

  it("keeps a mandatory channel registered after a failed leave, as before", async () => {
    const kit = registryKit();
    const channel = await joined(kit, "t", {});

    const failed = expect(kit.registry.leave("t")).rejects.toThrow("Failed to leave topic t");
    channel.leavePushes[0]!.settle("timeout");
    await failed.catch(() => undefined);

    expect(kit.registry.isJoined("t")).toBe(true);
    expect(kit.socket.removed).toEqual([]);
    expect(kit.left.entries).toEqual([]);
  });

  it("does not let a join reply that arrives while the leave is held reach the owner or the tracker", async () => {
    const kit = registryKit();
    const snapshots = new RecordLog<unknown>();
    const channel = await joined(kit, "t", { ...optional, onJoined: (reply) => snapshots.record(reply) });
    const settledBefore = kit.settled.entries.length;
    const snapshotsBefore = snapshots.entries.length;

    const leaving = kit.registry.leave("t");
    // Phoenix resends the same join push on every automatic rejoin; a reply to it can still land mid-leave.
    channel.joinPush.settle("ok", { stale: true });
    channel.leavePushes[0]!.settle("ok");
    await leaving;

    expect(snapshots.entries).toHaveLength(snapshotsBefore);
    expect(kit.settled.entries).toHaveLength(settledBefore);
  });

  it("starts no replacement channel until the held leave has settled", async () => {
    const kit = registryKit();
    const old = await joined(kit, "t", optional);

    const leaving = kit.registry.leave("t");
    const restarting = kit.registry.join("t", {}, optional);
    await Promise.resolve();
    expect(kit.socket.channels).toEqual([old]);

    old.leavePushes[0]!.settle("error");
    await leaving.catch(() => undefined);
    const replacement = kit.socket.channels[1]!;
    replacement.joinPush.settle("ok");
    await restarting;
    expect(kit.registry.isJoined("t")).toBe(true);
  });

  it("lets a late failed cleanup finish without touching the replacement that took its topic", async () => {
    const kit = registryKit();
    const events = new RecordLog<string>();
    const old = await joined(kit, "t", optional);
    const leaving = kit.registry.leave("t");
    const failed = expect(leaving).rejects.toThrow("Failed to leave topic t");

    // A transport teardown forgets the in-flight leave; the topic is then joined afresh.
    kit.registry.forceTeardown();
    const replacement = await joined(kit, "t", optional, { changed: () => events.record("replacement") });
    const removedBefore = kit.socket.removed.length;

    old.leavePushes[0]!.settle("error");
    await failed;

    expect(kit.socket.removed.slice(removedBefore)).toEqual([old]);
    expect(kit.registry.isJoined("t")).toBe(true);
    expect(kit.left.entries).toEqual([]);
    replacement.deliver("changed");
    expect(events.entries).toEqual(["replacement"]);
  });
});

describe("ChannelRegistry leave of a join still in flight", () => {
  it("abandons an optional pending channel, settles its awaiter and ignores the reply that follows", async () => {
    const kit = registryKit();
    const lifecycle = new RecordLog<string>();
    const joining = kit.registry.join("t", {}, {
      ...optional,
      onJoined: () => lifecycle.record("joined"),
      onUnavailable: () => lifecycle.record("lost"),
    });
    const abandoned = expect(joining).rejects.toThrow("superseded");
    const channel = kit.socket.channels[0]!;

    await kit.registry.leave("t");
    await abandoned;
    channel.joinPush.settle("ok", { late: true });

    expect(lifecycle.entries).toEqual(["lost"]);
    expect(channel.boundHandlers).toBe(0);
    expect(channel.leavePushes).toHaveLength(1);
    expect(kit.socket.removed).toEqual([channel]);
    expect(kit.registry.isJoined("t")).toBe(false);
  });

  it("leaves a mandatory pending join alone, as before", async () => {
    const kit = registryKit();
    const joining = kit.registry.join("t", {}, {});
    const channel = kit.socket.channels[0]!;

    await kit.registry.leave("t");
    channel.joinPush.settle("ok");
    await joining;

    expect(channel.leavePushes).toHaveLength(0);
    expect(kit.registry.isJoined("t")).toBe(true);
  });
});
