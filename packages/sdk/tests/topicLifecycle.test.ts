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

  it("contains lifecycle callback exceptions and still delivers the real event", async () => {
    await using kit = await connected();
    const event = createDeferred<void>();
    await kit.transport.join(optional, { changed: () => event.resolve() }, {
      blocksReconnect: false, onJoined: () => { throw new Error("observer"); },
      onUnavailable: () => { throw new Error("observer"); },
    });
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
