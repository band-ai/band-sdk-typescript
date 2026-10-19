import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../src/core/deferred";
import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";
import { FakePhoenixPeer } from "./fakePhoenixPeer";
import { RecordLog } from "./testUtils";

const optional = "optional:room";
const chat = "chat_room:room";
const participants = "room_participants:room";

async function connected() {
  const peer = await FakePhoenixPeer.start();
  const transport = new PhoenixChannelsTransport({ wsUrl: peer.url, apiKey: "test", reconnectAfterMs: () => 10 });
  await transport.connect();
  return { peer, transport, async [Symbol.asyncDispose]() {
    vi.useRealTimers();
    await transport.disconnect().catch(() => undefined);
    await peer.stop();
  } };
}

describe("optional topic lifecycle on the Phoenix wire", () => {
  it("installs each join snapshot synchronously before following events, including channel-only recovery", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const applied = new RecordLog<unknown>();
    const losses = new RecordLog<string>();
    peer.queueJoinPayloads(optional, [{ version: 1 }]);
    await transport.join(optional, { changed: (payload) => applied.record(payload) }, {
      onJoined: (reply) => applied.record(reply), onUnavailable: () => losses.record("lost"),
      exemptFromBuffering: true, blocksReconnect: false,
    });
    peer.push(optional, "changed", { version: 2 });
    await applied.next((value) => (value as { version: number }).version === 2);
    peer.queueJoinOutcomes(optional, ["pending"]);
    const cursor = peer.joins.entries.length;
    peer.push(optional, "phx_error", {});
    await losses.next(() => true);
    const request = await peer.joins.next((entry) => entry.topic === optional, cursor);
    peer.settleRequest(request, "ok", { version: 3 });
    peer.push(optional, "changed", { version: 4 });
    await applied.next((value) => (value as { version: number }).version === 4);
    expect(applied.entries).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
  });

  it.each(["before", "after"])("isolates optional recovery %s mandatory recovery", async (order) => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const recovery = createDeferred<void>();
    const delivered = new RecordLog<string>();
    const activity = new RecordLog<unknown>();
    transport.onReconnected((snapshot) => {
      expect(snapshot.attemptedTopics).toEqual(new Set([chat, participants]));
      recovery.resolve();
    });
    await transport.join(chat, { message: () => delivered.record("message") });
    await transport.join(participants, { added: () => delivered.record("participant") });
    await transport.join(optional, { changed: (payload) => activity.record(payload) }, {
      blocksReconnect: false, exemptFromBuffering: true, onJoined: (reply) => activity.record(reply),
    });
    for (const topic of [chat, participants, optional]) peer.queueJoinOutcomes(topic, ["pending"]);
    const cursor = peer.joins.entries.length;
    peer.severAllConnections();
    const requests = await Promise.all([chat, participants, optional].map((topic) => peer.joins.next((r) => r.topic === topic, cursor)));
    const activityRequest = requests[2]!;
    if (order === "before") {
      peer.settleRequest(activityRequest, "ok", { recovered: true });
      peer.push(optional, "changed", { changed: true });
      await activity.next((value) => (value as { changed?: boolean }).changed === true);
      // An independent new join must also bypass the outstanding mandatory barrier.
      await transport.join("optional:another", {}, { blocksReconnect: false });
    }
    for (const request of requests.slice(0, 2)) peer.settleRequest(request, "ok");
    await recovery.promise;
    peer.push(chat, "message", {});
    peer.push(participants, "added", {});
    await delivered.next((value) => value === "participant");
    expect(delivered.entries).toEqual(["message", "participant"]);
    if (order === "after") {
      expect(activity.entries).toEqual([{}]);
      peer.settleRequest(activityRequest, "ok", { recovered: true });
      await activity.next((value) => (value as { recovered?: boolean }).recovered === true);
    }
  });

  it("retires a pending join and ignores its late reply before a fresh same-topic join", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const snapshots = new RecordLog<unknown>();
    peer.queueJoinOutcomes(optional, ["pending"]);
    const joining = transport.join(optional, {}, { blocksReconnect: false, onJoined: (value) => snapshots.record(value) });
    const rejected = expect(joining).rejects.toThrow("superseded");
    const old = await peer.joins.next((request) => request.topic === optional);
    await transport.leave(optional);
    await rejected;
    await transport.join(optional, {}, { blocksReconnect: false, onJoined: (value) => snapshots.record(value) });
    peer.settleRequest(old, "ok", { stale: true });
    // A following frame on the same socket is the causal drain barrier.
    const drained = new RecordLog<string>();
    await transport.join("barrier", { done: () => drained.record("done") });
    peer.push("barrier", "done", {});
    await drained.next(() => true);
    expect(snapshots.entries).toEqual([{}]);
    expect(peer.joins.entries.filter((request) => request.topic === optional)).toHaveLength(2);
  });

  it("invalidates on socket loss and permanent close without retrying the closed topic", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const lifecycle = new RecordLog<string>();
    const opts = { blocksReconnect: false, onJoined: () => lifecycle.record("joined"), onUnavailable: () => lifecycle.record("unavailable") };
    await transport.join(optional, {}, opts);
    const cursor = lifecycle.entries.length;
    peer.severAllConnections();
    await lifecycle.next((entry) => entry === "unavailable", cursor);
    await lifecycle.next((entry) => entry === "joined", cursor);
    const closedAt = lifecycle.entries.length;
    peer.push(optional, "phx_close", {});
    await lifecycle.next((entry) => entry === "unavailable", closedAt);
    const count = peer.joins.entries.length;
    await transport.join("barrier", {});
    expect(peer.joins.entries).toHaveLength(count + 1);
    expect(lifecycle.entries.at(-1)).toBe("unavailable");
  });

  it("contains lifecycle callback failures, sync or async, and still delivers the real event", async () => {
    await using kit = await connected();
    const event = createDeferred<void>();
    const lost = createDeferred<void>();
    await kit.transport.join(optional, { changed: () => event.resolve() }, {
      blocksReconnect: false, onJoined: () => { throw new Error("observer"); },
      onUnavailable: async () => { lost.resolve(); throw new Error("observer"); },
    });
    kit.peer.push(optional, "phx_error", {});
    await lost.promise;
    kit.peer.push(optional, "changed", {});
    await event.promise;
    await kit.transport.leave(optional);
  });

  it("rejects an initial failure without blocking another topic", async () => {
    await using kit = await connected();
    kit.peer.queueJoinOutcomes(optional, ["error"]);
    const unavailable = createDeferred<void>();
    await expect(kit.transport.join(optional, {}, { blocksReconnect: false, onUnavailable: () => unavailable.resolve() })).rejects.toThrow("Failed to join");
    await unavailable.promise;
    await kit.transport.join(chat, {});
    expect(kit.peer.joins.entries.map((request) => request.topic)).toEqual([optional, chat]);
  });

  it("settles a real local join timeout and permits fresh admission", async () => {
    await using kit = await connected();
    kit.peer.queueJoinOutcomes(optional, ["pending"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unavailable = createDeferred<void>();
    const joining = kit.transport.join(optional, {}, { blocksReconnect: false, onUnavailable: () => unavailable.resolve() });
    const failed = expect(joining).rejects.toThrow("Timeout joining");
    await kit.peer.joins.next((request) => request.topic === optional);
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    await unavailable.promise;
    vi.useRealTimers();
    await kit.transport.join(optional, {}, { blocksReconnect: false });
    expect(kit.peer.joins.entries.filter((request) => request.topic === optional)).toHaveLength(2);
  });
});

/** One topic owner's view: its snapshots, events and losses, in the order the transport delivered them. */
function owner() {
  const seen = new RecordLog<unknown>();
  return {
    seen,
    /** What the owner was given: snapshots and events, without the loss notices, which may repeat. */
    get data() { return seen.entries.filter((value) => value !== "unavailable"); },
    get lost() { return seen.entries.at(-1) === "unavailable"; },
    handlers: { changed: (payload: unknown) => seen.record(payload) },
    options: { blocksReconnect: false, exemptFromBuffering: true, onJoined: (reply: unknown) => seen.record(reply), onUnavailable: () => seen.record("unavailable") },
  };
}

describe("optional topic ownership on the Phoenix wire", () => {
  it("installs the initial join snapshot before an event sent right behind it", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const view = owner();
    peer.queueJoinOutcomes(optional, ["pending"]);
    const joining = transport.join(optional, view.handlers, view.options);
    const request = await peer.joins.next((entry) => entry.topic === optional);
    peer.settleRequest(request, "ok", { version: 1 });
    peer.push(optional, "changed", { version: 2 });
    await joining;
    await view.seen.next((value) => (value as { version: number }).version === 2);
    expect(view.seen.entries).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it("shares one physical join between duplicate admissions, owned by the first", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const first = owner();
    const second = owner();
    peer.queueJoinOutcomes(optional, ["pending"]);
    const joining = [transport.join(optional, first.handlers, first.options), transport.join(optional, second.handlers, second.options)];
    const request = await peer.joins.next((entry) => entry.topic === optional);
    peer.settleRequest(request, "ok", { owner: "first" });
    await Promise.all(joining);
    peer.push(optional, "changed", { n: 1 });
    await first.seen.next((value) => (value as { n?: number }).n === 1);
    expect(first.data).toEqual([{ owner: "first" }, { n: 1 }]);
    expect(second.seen.entries).toEqual([]);
    expect(peer.joins.entries.filter((entry) => entry.topic === optional)).toHaveLength(1);
  });

  it("detaches the exact channel at once, and a late rejected cleanup cannot touch its replacement", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const retired = owner();
    const live = owner();
    peer.queueLeaveOutcomes(optional, ["pending"]);
    await transport.join(optional, retired.handlers, retired.options);
    const [oldJoin] = peer.joins.entries.filter((entry) => entry.topic === optional);

    // Phoenix 1.8.14 closes a leaving channel locally, so the held acknowledgement does not hold the leave.
    await transport.leave(optional);
    const oldLeave = await peer.leaves.next((entry) => entry.topic === optional);
    expect(oldLeave.joinRef).toBe(oldJoin!.joinRef);

    peer.queueJoinPayloads(optional, [{ owner: "replacement" }]);
    await transport.join(optional, live.handlers, live.options);
    const newJoin = peer.joins.entries.filter((entry) => entry.topic === optional)[1]!;
    expect(newJoin.joinRef).not.toBe(oldJoin!.joinRef);
    peer.push(optional, "changed", { n: 1 });
    await live.seen.next((value) => (value as { n?: number }).n === 1);

    peer.settleRequest(oldLeave, "error", { reason: "rejected" });
    peer.push(optional, "changed", { n: 2 });
    await live.seen.next((value) => (value as { n?: number }).n === 2);
    expect(live.data).toEqual([{ owner: "replacement" }, { n: 1 }, { n: 2 }]);
    expect(live.lost).toBe(false);
    expect(retired.data).toEqual([{}]);
    expect(retired.lost).toBe(true);
  });

  it("keeps the live replacement when two retired owners' cleanups are still held", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const [first, second, live] = [owner(), owner(), owner()];
    peer.queueLeaveOutcomes(optional, ["pending", "pending"]);
    await transport.join(optional, first.handlers, first.options);
    await transport.leave(optional);
    await transport.join(optional, second.handlers, second.options);
    await transport.leave(optional);
    peer.queueJoinPayloads(optional, [{ owner: "live" }]);
    await transport.join(optional, live.handlers, live.options);
    const leaves = peer.leaves.entries.filter((entry) => entry.topic === optional);
    const joins = peer.joins.entries.filter((entry) => entry.topic === optional);
    expect(leaves.map((entry) => entry.joinRef)).toEqual([joins[0]!.joinRef, joins[1]!.joinRef]);

    // Released out of order: one rejected, one acknowledged.
    peer.settleRequest(leaves[1]!, "error");
    peer.settleRequest(leaves[0]!, "ok");
    peer.push(optional, "changed", { n: 1 });
    await live.seen.next((value) => (value as { n?: number }).n === 1);
    expect(live.data).toEqual([{ owner: "live" }, { n: 1 }]);
    expect([first.lost, second.lost, live.lost]).toEqual([true, true, false]);
    await transport.leave(optional);
    await peer.leaves.until(() => peer.leaves.entries.filter((entry) => entry.topic === optional).length === 3);
  });

  it("settles a pending optional join cut off by a transport disconnect", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const view = owner();
    peer.queueJoinOutcomes(optional, ["pending"]);
    const joining = transport.join(optional, view.handlers, view.options);
    const superseded = expect(joining).rejects.toThrow("superseded");
    await peer.joins.next((entry) => entry.topic === optional);
    await transport.disconnect();
    await superseded;
    expect(view.data).toEqual([]);
    expect(view.lost).toBe(true);
  });

  it("leaves a mandatory pending join to settle", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    peer.queueJoinOutcomes(chat, ["pending"]);
    const joining = transport.join(chat, {});
    const request = await peer.joins.next((entry) => entry.topic === chat);
    await transport.leave(chat);
    peer.settleRequest(request, "ok");
    await joining;
    expect(peer.leaves.entries.filter((entry) => entry.topic === chat)).toEqual([]);
  });

  it("carries a pending join across a socket replacement and installs only the replacement's reply", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const view = owner();
    peer.queueJoinOutcomes(optional, ["pending", "pending"]);
    const joining = transport.join(optional, view.handlers, view.options);
    const old = await peer.joins.next((entry) => entry.topic === optional);
    peer.severAllConnections();
    const replacement = await peer.joins.next((entry) => entry.topic === optional, 1);
    expect(replacement.connection).not.toBe(old.connection);
    expect(() => peer.settleRequest(old, "ok", { stale: true })).toThrow("no longer pending");
    peer.settleRequest(replacement, "ok", { fresh: true });
    await joining;
    expect(view.data).toEqual([{ fresh: true }]);
  });
});

describe("optional recovery against mandatory delivery", () => {
  it("rejoins only the lost channel after a channel loss, and every topic after a socket loss", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const view = owner();
    const reconnects = new RecordLog<ReadonlySet<string>>();
    const delivered = new RecordLog<string>();
    transport.onReconnected((snapshot) => reconnects.record(snapshot.attemptedTopics));
    await transport.join(chat, { message: () => delivered.record("message") });
    await transport.join(participants, {});
    await transport.join(optional, view.handlers, view.options);

    let cursor = peer.joins.entries.length;
    peer.push(optional, "phx_error", {});
    await peer.joins.next((entry) => entry.topic === optional, cursor);
    peer.push(chat, "message", {});
    await delivered.next(() => true);
    expect(peer.joins.entries.slice(cursor).map((entry) => entry.topic)).toEqual([optional]);
    expect(reconnects.entries).toEqual([]);

    cursor = peer.joins.entries.length;
    peer.severAllConnections();
    await reconnects.next(() => true);
    await view.seen.next((value) => value === "unavailable");
    expect(new Set(peer.joins.entries.slice(cursor).map((entry) => entry.topic))).toEqual(new Set([chat, participants, optional]));
    expect([...reconnects.entries[0]!].sort()).toEqual([chat, participants]);
  });

  it("delivers mandatory frames while a rejected optional rejoin leaves its view unavailable", async () => {
    await using kit = await connected();
    const { peer, transport } = kit;
    const view = owner();
    const recovery = createDeferred<void>();
    const delivered = new RecordLog<string>();
    transport.onReconnected(() => recovery.resolve());
    await transport.join(chat, { message: () => delivered.record("message") });
    await transport.join(optional, view.handlers, view.options);
    // The retry stays held, so nothing can make the optional topic live again during the test.
    peer.queueJoinOutcomes(optional, ["error", "pending"]);
    peer.severAllConnections();
    await recovery.promise;
    await view.seen.next((value) => value === "unavailable");
    peer.push(chat, "message", {});
    await delivered.next(() => true);
    expect(view.data).toEqual([{}]);
    expect(view.lost).toBe(true);
  });
});
