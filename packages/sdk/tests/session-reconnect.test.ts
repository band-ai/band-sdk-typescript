import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentControlTopic } from "@band-ai/band-sdk-core";

import { createDeferred } from "../src/core/deferred";
import { RuntimeStateError, TransportError } from "../src/core/errors";
import { BandLink } from "../src/platform/BandLink";
import {
  WebSocketDisconnectError,
  type WebSocketDisconnectReason,
} from "../src/platform/streaming/disconnectReason";
import {
  BOOT_CONNECT_DEADLINE_MS,
  PhoenixChannelsTransport,
} from "../src/platform/streaming/PhoenixChannelsTransport";
import { createNodeWebSocketFactory } from "../src/platform/streaming/nodeWebSocketFactory";
import type { ReconnectSnapshot } from "../src/platform/streaming/transport";
import { AgentRuntime } from "../src/runtime/rooms/AgentRuntime";
import { FakePhoenixPeer, type UpgradeRefusal } from "./fakePhoenixPeer";
import { FAKE_WIRE_CLOCK, FakeRestApi, RecordLog, advanceWireClock, fastSessionPolicy } from "./testUtils";

/**
 * Core `Session` as the transport's only reconnect policy, over the real
 * phoenix client and a real socket. The clock is faked before each transport
 * connects, since Session stamps its epochs with it.
 */

const AGENT_ID = "agent-1";
const CONTROL_TOPIC = agentControlTopic(AGENT_ID);
const ROOM = "chat_room:room-1";
/** Longer than any delay the fast policy picks, plus phoenix's own teardown. */
const PAST_ANY_DELAY_MS = 5_000;

type PolicyOverrides = Parameters<typeof fastSessionPolicy>[0];

function platformRefusal(status: number, code: string, extra: Record<string, unknown> = {}): UpgradeRefusal {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: { code, message: code, ...extra } }),
  };
}

/** Pushes a supersede on the agent's control channel, as the platform does. */
function pushSupersede(
  peer: FakePhoenixPeer,
  { reason = "session.reconnect", retryable = true, retryAfter }: { reason?: string; retryable?: boolean; retryAfter?: number } = {},
): void {
  peer.push(CONTROL_TOPIC, "supersede", {
    reason,
    message: reason,
    retryable,
    ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
    correlation_id: null,
  });
}

/** A real transport for `AGENT_ID` that records every terminal disconnect; disposing it disconnects. */
function transportFor(
  peer: { url: string },
  policy: PolicyOverrides = {},
  websocketFactory?: typeof WebSocket,
) {
  const terminals: WebSocketDisconnectReason[] = [];
  const transport = new PhoenixChannelsTransport({
    wsUrl: peer.url,
    websocketFactory,
    apiKey: "test-key",
    agentId: AGENT_ID,
    sessionPolicy: fastSessionPolicy(policy),
  });
  transport.onTerminal((error) => terminals.push(error.reason));
  return {
    transport,
    terminals,
    [Symbol.asyncDispose]: async () => {
      // Phoenix polls its closing socket on timers already queued on the fake clock.
      const stopping = transport.disconnect().catch(() => undefined);
      await (vi.isFakeTimers() ? onWireClock(stopping) : stopping);
      vi.useRealTimers();
    },
  };
}

/** Starts `peer` with the fake clock installed, so every later Session timestamp is on it. */
async function startPeer(): Promise<FakePhoenixPeer> {
  vi.useFakeTimers(FAKE_WIRE_CLOCK);
  return FakePhoenixPeer.start();
}

/** Resolves once the peer has accepted `count` connections in total. */
async function connectionNumber(peer: FakePhoenixPeer, count: number): Promise<void> {
  await peer.connections.until(() => peer.connections.entries.length >= count);
}

/**
 * Steps the fake clock until `work` settles, for work that waits on both timers
 * and real IO; fails once `budgetMs` of wire time passes without it settling.
 */
async function onWireClock<T>(work: Promise<T>, budgetMs = PAST_ANY_DELAY_MS): Promise<T> {
  let settled = false;
  const tracked = work.finally(() => (settled = true));
  // Handled here so a rejection is not reported while the clock steps; the caller still sees it.
  tracked.catch(() => undefined);
  for (let elapsed = 0; !settled && elapsed < budgetMs; elapsed += 100) {
    await advanceWireClock(100);
  }
  if (!settled) {
    throw new Error(`did not settle within ${budgetMs} ms of wire time`);
  }
  return tracked;
}

/** Waits on real IO alone, with the fake clock still, until `holds()` is true. */
async function ioUntil(holds: () => boolean): Promise<void> {
  await new Promise<void>((resolve) => {
    const poll = () => (holds() ? resolve() : setImmediate(poll));
    poll();
  });
}

/** Resolves once the client has handled an upgrade refusal, which starts Session's delay. */
async function clientSawRefusal(transport: PhoenixChannelsTransport): Promise<void> {
  await ioUntil(() => transport.getDisconnectReason()?.source === "upgrade");
}

/** Steps the fake clock until `holds()` is true. */
async function wireUntil(holds: () => boolean, budgetMs?: number): Promise<void> {
  await onWireClock(ioUntil(holds), budgetMs);
}

/** Steps the fake clock until `transport.isConnected()` reads `connected`. */
async function connectedState(transport: PhoenixChannelsTransport, connected: boolean, budgetMs?: number): Promise<void> {
  await wireUntil(() => transport.isConnected() === connected, budgetMs);
}

/** Steps the fake clock until the peer has refused at least `count` upgrades. */
async function refused(peer: FakePhoenixPeer, count = 1): Promise<void> {
  await onWireClock(peer.refusals.until(() => peer.refusals.entries.length >= count));
}

/** Advances the clock until the peer has accepted `count` connections in total. */
async function reconnected(peer: FakePhoenixPeer, count: number): Promise<void> {
  await onWireClock(connectionNumber(peer, count));
}

/**
 * A TCP front for `peer` that forwards, or while `hanging` accepts the
 * connection and never answers its upgrade, as a stuck load balancer does.
 */
async function startFront(peer: FakePhoenixPeer) {
  const target = new URL(peer.url);
  const front = { hanging: false, accepted: new RecordLog<number>(), url: "" };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => undefined);
    front.accepted.record(front.accepted.entries.length + 1);
    if (front.hanging) {
      return;
    }
    const upstream = net.connect(Number(target.port), target.hostname);
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  front.url = `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/socket`;
  return Object.assign(front, {
    [Symbol.asyncDispose]: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

/** An upgrade endpoint that refuses with `status` and headers, then never finishes the body it announced. */
async function startStalledRefusal(status: number, headers: Record<string, string>) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("error", () => undefined);
    client.once("data", () => {
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
      client.write(`HTTP/1.1 ${status} Refused\r\n${lines}Content-Length: 200\r\n\r\npartial`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/socket`,
    [Symbol.asyncDispose]: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("core Session owns reconnects (real wire)", () => {
  describe("retryable closes reconnect", () => {
    it.each([1000, 1001])("reconnects and rejoins after the server closes with %i", async (code) => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();

      peer.closeConnections(code);
      await reconnected(peer, 2);

      await peer.joined.next((topic) => topic === CONTROL_TOPIC, 1);
      expect(agent.terminals).toEqual([]);
    });

    it("reconnects after the network drops the socket", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();

      peer.severAllConnections();
      await reconnected(peer, 2);

      expect(agent.terminals).toEqual([]);
    });

    it("drops a reconnected socket whose agent_control rejoin fails, and reconnects again", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();
      const snapshots: ReconnectSnapshot[] = [];
      const recovered = createDeferred<void>();
      agent.transport.onReconnected((snapshot) => {
        snapshots.push(snapshot);
        if (snapshot.joinedTopics.has(CONTROL_TOPIC)) {
          recovered.resolve();
        }
      });
      peer.queueJoinOutcomes(CONTROL_TOPIC, ["error"]);

      peer.severAllConnections();
      await reconnected(peer, 3);
      await onWireClock(recovered.promise);

      // Replies on the dropped socket settle nothing, so it is not reported as a reconnect that joined nothing.
      expect(snapshots.map((snapshot) => [...snapshot.joinedTopics])).toEqual([[CONTROL_TOPIC]]);
      expect(agent.terminals).toEqual([]);
    });

    it("settles no rejoin on a socket dropped for a failed agent_control rejoin", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();
      await onWireClock(agent.transport.join(ROOM, {}));
      const rejoins: string[] = [];
      agent.transport.onTopicRejoined((topic) => rejoins.push(topic));
      const snapshots: ReconnectSnapshot[] = [];
      const recovered = createDeferred<void>();
      agent.transport.onReconnected((snapshot) => {
        snapshots.push(snapshot);
        recovered.resolve();
      });
      // The room's ok follows the control error on the socket being dropped.
      peer.queueJoinOutcomes(CONTROL_TOPIC, ["error"]);

      peer.severAllConnections();
      await reconnected(peer, 3);
      await onWireClock(recovered.promise);

      expect(rejoins).toEqual([]);
      expect(snapshots.map((snapshot) => [...snapshot.joinedTopics].sort())).toEqual([[CONTROL_TOPIC, ROOM].sort()]);
    });

    it("reports no reconnect for a socket a retryable supersede drops mid-rejoin", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();
      await onWireClock(agent.transport.join(ROOM, {}));
      const snapshotConnections: number[] = [];
      const recovered = createDeferred<void>();
      agent.transport.onReconnected(() => {
        snapshotConnections.push(peer.connections.entries.length);
        recovered.resolve();
      });
      peer.queueJoinOutcomes(ROOM, ["pending"]);
      peer.severAllConnections();
      await reconnected(peer, 2);
      await connectedState(agent.transport, true);

      // The room's held ok lands right behind the supersede, on the socket it drops.
      peer.inOneChunk(() => {
        pushSupersede(peer);
        peer.settleJoin(ROOM, "ok");
      });
      await reconnected(peer, 3);
      await onWireClock(recovered.promise);

      expect(snapshotConnections).toEqual([3]);
    });

    it("reports no reconnect when a room still rejoining on a superseded socket is left", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();
      await onWireClock(agent.transport.join(ROOM, {}));
      const snapshotConnections: number[] = [];
      const recovered = createDeferred<void>();
      agent.transport.onReconnected(() => {
        snapshotConnections.push(peer.connections.entries.length);
        recovered.resolve();
      });
      peer.queueJoinOutcomes(ROOM, ["pending"]);
      peer.severAllConnections();
      await reconnected(peer, 2);
      await connectedState(agent.transport, true);

      // The room was all the dropped socket's rejoin still waited on.
      pushSupersede(peer);
      await connectedState(agent.transport, false);
      // Hold the next socket closed until leave finishes — don't race a delay.
      peer.refuseUpgrades({ status: 503 });
      await refused(peer);
      await onWireClock(agent.transport.leave(ROOM));
      peer.acceptUpgrades();
      await reconnected(peer, 3);
      await onWireClock(recovered.promise);

      expect(snapshotConnections).toEqual([3]);
    });

    it("stops reporting connected once a heartbeat timeout's close stalls", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer, { heartbeatIntervalS: 0.1, deadThresholdS: 0.2, baseDelayS: 20, maxDelayS: 20 });
      await agent.transport.connect();

      // The peer stops reading, so it never answers phoenix's close either.
      peer.stallReads();
      await connectedState(agent.transport, false);

      expect(agent.transport.getDisconnectReason()).toMatchObject({ source: "websocket_close" });
      expect(peer.connections.entries).toHaveLength(1);
    });

    it("reconnects after phoenix's heartbeat timeout closes a silent socket", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer, { heartbeatIntervalS: 0.1, deadThresholdS: 0.2 });
      await agent.transport.connect();

      peer.stallReads();
      await reconnected(peer, 2);

      expect(agent.terminals).toEqual([]);
    });
  });

  describe("terminal verdicts end the session once", () => {
    it("ends on close 1008 without reconnecting", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();
      const running = agent.transport.runForever(new AbortController().signal);

      peer.closeConnections(1008);
      await expect(running).rejects.toBeInstanceOf(WebSocketDisconnectError);
      await advanceWireClock(PAST_ANY_DELAY_MS);

      expect(peer.connections.entries).toHaveLength(1);
      expect(agent.terminals).toEqual([
        expect.objectContaining({ source: "websocket_close", closeCode: 1008, retryable: false }),
      ]);
    });

    it.each([
      [401, { status: 401 }, "upgrade_rejected"],
      [403, { status: 403 }, "upgrade_rejected"],
      [400, platformRefusal(400, "invalid_on_conflict"), "invalid_on_conflict"],
      [409, platformRefusal(409, "connection_conflict"), "connection_conflict"],
    ] as const)("ends when a reconnect is refused with %i", async (status, refusal, code) => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();

      peer.refuseUpgrades(refusal);
      peer.severAllConnections();
      await advanceWireClock(PAST_ANY_DELAY_MS);

      expect(peer.refusals.entries).toEqual([status]);
      expect(agent.terminals).toEqual([
        expect.objectContaining({ source: "upgrade", status, code, retryable: false }),
      ]);
    });

    it("ends on a supersede push, and ignores the close that follows it", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();

      await peer.supersede(AGENT_ID);
      await advanceWireClock(100);
      peer.closeConnections(1000);
      await advanceWireClock(PAST_ANY_DELAY_MS);

      expect(peer.connections.entries).toHaveLength(1);
      expect(agent.terminals).toEqual([
        expect.objectContaining({ source: "agent_control", code: "session.already_connected" }),
      ]);
    });

    it("ends with rapid_disconnect once sockets keep dropping right after connecting", async () => {
      const threshold = 3;
      await using peer = await startPeer();
      await using agent = transportFor(peer, { rapidDisconnectUptimeS: 10, rapidThreshold: threshold });
      await agent.transport.connect();

      for (let accepted = 1; accepted <= threshold; accepted += 1) {
        await reconnected(peer, accepted);
        peer.closeConnections(1000);
        await advanceWireClock(200);
      }
      await advanceWireClock(PAST_ANY_DELAY_MS);

      expect(peer.connections.entries).toHaveLength(threshold);
      expect(agent.terminals).toEqual([
        expect.objectContaining({ code: "websocket.rapid_disconnect", retryable: false }),
      ]);
    });

    it("reports rapid_disconnect when retryable supersedes trip the breaker", async () => {
      const threshold = 2;
      await using peer = await startPeer();
      await using agent = transportFor(peer, { rapidDisconnectUptimeS: 10, rapidThreshold: threshold });
      await agent.transport.connect();

      for (let accepted = 1; accepted <= threshold; accepted += 1) {
        await reconnected(peer, accepted);
        await onWireClock(peer.joined.until(() => peer.joined.entries.filter((topic) => topic === CONTROL_TOPIC).length >= accepted));
        pushSupersede(peer);
        await advanceWireClock(200);
      }
      await wireUntil(() => agent.terminals.length > 0);

      expect(agent.terminals).toEqual([
        expect.objectContaining({ code: "websocket.rapid_disconnect", retryable: false }),
      ]);
    });

    it("fails a join no reconnect will answer: one in flight, and one waiting on the reconnect", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();
      await onWireClock(agent.transport.join("chat_room:held", {}));

      // The reconnect waits on the held room's rejoin, so a new join waits behind it.
      peer.queueJoinOutcomes("chat_room:held", ["pending"]);
      peer.severAllConnections();
      await reconnected(peer, 2);
      await onWireClock(peer.joins.until(() => peer.joins.entries.filter((join) => join.topic === "chat_room:held").length >= 2));
      const waiting = agent.transport.join("chat_room:waiting", {});
      peer.queueJoinOutcomes("chat_room:sent", ["pending"]);
      const inFlight = agent.transport.join("chat_room:sent", {}, { blocksReconnect: false });
      await onWireClock(peer.joins.until(() => peer.joins.entries.some((join) => join.topic === "chat_room:sent")));

      const outcomes = Promise.all([waiting, inFlight].map((join) => join.then(() => null, (error: unknown) => error)));
      peer.closeConnections(1008);

      expect(await onWireClock(outcomes)).toEqual([expect.any(WebSocketDisconnectError), expect.any(WebSocketDisconnectError)]);
    });
  });

  describe("refusals and outages retry", () => {
    it.each([
      ["a Retry-After header", { status: 429, headers: { "Retry-After": "7" } }],
      ["a body retry_after", platformRefusal(503, "tracking_failed", { retry_after: 7 })],
    ] as const)("waits at least the server's hint from %s", async (_hint, refusal) => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();

      peer.refuseUpgrades(refusal);
      peer.severAllConnections();
      await refused(peer);
      await clientSawRefusal(agent.transport);
      peer.acceptUpgrades();

      await advanceWireClock(6_800);
      expect(peer.connections.entries).toHaveLength(1);
      await advanceWireClock(400);
      await reconnected(peer, 2);
      expect(peer.refusals.entries).toHaveLength(1);
      expect(agent.terminals).toEqual([]);
    });

    it("keeps retrying through an outage longer than the rapid window", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer, { rapidDisconnectUptimeS: 10, rapidWindowS: 1, rapidThreshold: 2 });
      await agent.transport.connect();

      peer.refuseUpgrades({ status: 503 });
      peer.severAllConnections();
      await advanceWireClock(3_000);
      await onWireClock(peer.refusals.until(() => peer.refusals.entries.length > 2));

      peer.acceptUpgrades();
      await reconnected(peer, 2);
      expect(agent.terminals).toEqual([]);
    });

    it("reconnects on a retryable supersede whose retry_after is negative", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();

      pushSupersede(peer, { retryAfter: -1 });
      await reconnected(peer, 2);

      expect(agent.terminals).toEqual([]);
    });

    it("retries an attempt whose upgrade is never answered", async () => {
      // Real time: the handshake timeout is a socket timer the fake clock doesn't drive.
      vi.useRealTimers();
      await using peer = await FakePhoenixPeer.start();
      await using front = await startFront(peer);
      await using agent = transportFor(front, {}, createNodeWebSocketFactory(undefined, 50));
      front.hanging = true;

      const connecting = agent.transport.connect();
      await front.accepted.until(() => front.accepted.entries.length >= 2);
      front.hanging = false;
      await connecting;

      expect(agent.transport.isConnected()).toBe(true);
    });

    it("reports a refusal whose body never finishes, with its status and Retry-After", async () => {
      vi.useRealTimers();
      await using server = await startStalledRefusal(503, { "Retry-After": "60" });
      await using agent = transportFor(server, {}, createNodeWebSocketFactory(undefined, 100));

      const connecting = agent.transport.connect().catch(() => undefined);
      await vi.waitFor(() => expect(agent.transport.getDisconnectReason()).toMatchObject({ status: 503, retryAfter: 60 }));

      await agent.transport.disconnect();
      await connecting;
    });

    it.each(["-5", "soon"])("treats a Retry-After of %j as no hint", async (retryAfter) => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();

      peer.refuseUpgrades({ status: 503, headers: { "Retry-After": retryAfter } });
      peer.severAllConnections();
      await onWireClock(peer.refusals.until(() => peer.refusals.entries.length > 1));

      expect(peer.refusals.entries.length).toBeGreaterThan(1);
      expect(agent.terminals).toEqual([]);
    });
  });

  describe("local stops", () => {
    it("never reconnects after disconnect(), while connected or during a backoff", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();
      await onWireClock(agent.transport.disconnect());
      await onWireClock(agent.transport.connect());

      // Hold the reconnect inside a 7 s floor, with phoenix's next attempt already scheduled.
      peer.refuseUpgrades({ status: 503, headers: { "Retry-After": "7" } });
      peer.severAllConnections();
      await refused(peer);
      await onWireClock(agent.transport.disconnect());
      peer.acceptUpgrades();
      await advanceWireClock(10_000);

      expect(peer.connections.entries).toHaveLength(2);
      expect(peer.refusals.entries).toHaveLength(1);
      expect(agent.terminals).toEqual([]);
    });

    it("connects again after a local stop", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();
      await onWireClock(agent.transport.disconnect());

      await onWireClock(agent.transport.connect());

      expect(agent.transport.isConnected()).toBe(true);
      expect(peer.connections.entries).toHaveLength(2);
    });

    it("joins a reconnect in progress instead of restarting it", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();
      peer.refuseUpgrades({ status: 503, headers: { "Retry-After": "7" } });
      peer.severAllConnections();
      await refused(peer);
      await clientSawRefusal(agent.transport);

      const again = agent.transport.connect();
      await advanceWireClock(6_800);
      expect(peer.refusals.entries, "no attempt inside the server's 7 s floor").toHaveLength(1);
      peer.acceptUpgrades();
      await reconnected(peer, 2);
      await again;

      expect(agent.transport.isConnected()).toBe(true);
    });

    it("starts a fresh run for a connect made while disconnect() is still tearing down", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();
      peer.refuseUpgrades({ status: 503, headers: { "Retry-After": "400" } });
      peer.severAllConnections();
      await refused(peer);

      // The stopped run would wait out the 400 s floor; only a fresh run connects now.
      const stopping = agent.transport.disconnect();
      const again = agent.transport.connect();
      peer.acceptUpgrades();
      await onWireClock(stopping);

      await onWireClock(again);
      expect(agent.transport.isConnected()).toBe(true);
    });
  });

  describe("a close the transport starts itself", () => {
    it("is not blamed for a later run's close when phoenix gives up on it", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      peer.queueJoinOutcomes(CONTROL_TOPIC, ["pending"]);
      const first = agent.transport.connect().catch(() => undefined);
      await onWireClock(peer.joined.next((topic) => topic === CONTROL_TOPIC));

      // The join times out against a silent peer, so its drop's close goes unanswered;
      // the stop lands before ws gives up on it, and phoenix stops waiting first.
      peer.stallReads();
      await advanceWireClock(10_200);
      // It rejects: the close handshake never finished, which is the point.
      await onWireClock(agent.transport.disconnect().catch(() => undefined));
      await onWireClock(first);
      peer.resumeReads();

      await onWireClock(agent.transport.connect());
      peer.closeConnections(1008);
      await wireUntil(() => agent.terminals.length > 0);

      expect(agent.terminals).toEqual([expect.objectContaining({ code: "websocket.closed", closeCode: 1008 })]);
    });

    it("does not report connected over a socket a supersede dropped in the same chunk as the agent_control reply", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      const snapshots: ReconnectSnapshot[] = [];
      agent.transport.onReconnected((snapshot) => {
        snapshots.push(snapshot);
      });
      peer.queueJoinOutcomes(CONTROL_TOPIC, ["pending"]);
      const connecting = agent.transport.connect();
      await onWireClock(peer.joins.until(() => peer.joins.entries.some((join) => join.topic === CONTROL_TOPIC)));

      peer.inOneChunk(() => {
        peer.settleJoin(CONTROL_TOPIC, "ok");
        pushSupersede(peer, { retryAfter: 1 });
      });
      // Both frames are handled before the join's continuation runs; that continuation is what this checks.
      await ioUntil(() => agent.transport.getDisconnectReason()?.source === "agent_control");

      expect(agent.transport.isConnected(), "the superseded connection is closing").toBe(false);
      await reconnected(peer, 2);
      await onWireClock(connecting);
      await advanceWireClock(100);
      expect(agent.transport.isConnected()).toBe(true);
      // The superseded socket never became usable, so the next one is the boot, not a reconnect.
      expect(snapshots).toEqual([]);
    });

    it("counts one supersede per connection, so a repeated push does not inflate the backoff", async () => {
      // Full jitter, so the delay is exactly base * factor^failures.
      vi.spyOn(Math, "random").mockReturnValue(1);
      await using peer = await startPeer();
      await using agent = transportFor(peer, { baseDelayS: 10, factor: 2, maxDelayS: 100 });
      await agent.transport.connect();

      peer.inOneChunk(() => {
        pushSupersede(peer);
        pushSupersede(peer);
      });
      // One counted failure waits 10 s; a second would wait 20 s.
      await advanceWireClock(15_000);

      expect(peer.connections.entries).toHaveLength(2);
    });

    it("stops reporting connected at once, even if phoenix later drops that close", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();

      peer.stallReads();
      await advanceWireClock(100, 10);
      pushSupersede(peer, { retryAfter: 20 });
      // Before phoenix's ~1.5 s close polling gives up and reports the close itself.
      await connectedState(agent.transport, false, 1_000);
      peer.resumeReads();
      await advanceWireClock(21_000, 100);
      await connectedState(agent.transport, true);

      peer.closeConnections(1008);
      await wireUntil(() => agent.terminals.length > 0);
      expect(agent.terminals).toEqual([expect.objectContaining({ source: "websocket_close", closeCode: 1008 })]);
    });
  });

  describe("a connect that joins a running reconnect", () => {
    it("can time out without ending that reconnect", async () => {
      const retryFloorS = 400;
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();
      peer.refuseUpgrades({ status: 503, headers: { "Retry-After": String(retryFloorS) } });
      peer.severAllConnections();
      await refused(peer);

      const joinedTimeoutMs = BOOT_CONNECT_DEADLINE_MS + 1_000;
      const joined = agent.transport.connect().then(() => null, (error: unknown) => error);
      await advanceWireClock(joinedTimeoutMs, 1_000);
      expect(await joined).toBeInstanceOf(TransportError);

      // The running reconnect still waits out the floor, then connects.
      peer.acceptUpgrades();
      await advanceWireClock(retryFloorS * 1_000 - joinedTimeoutMs + 1_000, 1_000);
      await reconnected(peer, 2);
      await connectedState(agent.transport, true);
    });
  });

  describe("boot", () => {
    it("rejects a boot refused with 403 as terminal", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      peer.refuseUpgrades({ status: 403 });

      await expect(onWireClock(agent.transport.connect())).rejects.toBeInstanceOf(WebSocketDisconnectError);

      expect(agent.transport.getDisconnectReason()).toMatchObject({ source: "upgrade", status: 403 });
      await expect(onWireClock(agent.transport.connect())).rejects.toBeInstanceOf(WebSocketDisconnectError);
    });

    it("retries a refused boot until an attempt is accepted", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      peer.refuseUpgrades({ status: 503 });

      const connecting = agent.transport.connect();
      await refused(peer, 2);
      peer.acceptUpgrades();
      await reconnected(peer, 1);
      await connecting;

      expect(agent.transport.isConnected()).toBe(true);
    });

    it("gives up at the boot deadline with the last refusal as the cause, then can connect again", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer, { baseDelayS: 10, maxDelayS: 10 });
      peer.refuseUpgrades({ status: 503 });

      const connecting = agent.transport.connect();
      const outcome = connecting.then(() => null, (error: unknown) => error);
      await advanceWireClock(BOOT_CONNECT_DEADLINE_MS + 1_000, 1_000);

      // The deadline's teardown polls phoenix's close on the fake clock, so keep it running.
      const error = await onWireClock(outcome);
      expect(error).toBeInstanceOf(TransportError);
      expect((error as Error).cause).toMatchObject({ source: "upgrade", status: 503, retryable: true });
      expect(agent.transport.getDisconnectReason()).toMatchObject({ status: 503 });

      peer.acceptUpgrades();
      await onWireClock(agent.transport.connect());
      expect(agent.transport.isConnected()).toBe(true);
    });

    it("retries when the mandatory agent_control join fails, without reporting a reconnect", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      const link = new BandLink({ agentId: AGENT_ID, apiKey: "test-key", transport: agent.transport, restApi: new FakeRestApi() });
      peer.queueJoinOutcomes(CONTROL_TOPIC, ["error"]);

      const connecting = link.connect();
      await reconnected(peer, 2);
      await connecting;

      expect(agent.transport.isConnected()).toBe(true);
      expect(agent.terminals).toEqual([]);
      // A boot that never connected has no session to resume, so nothing queues a catch-up.
      const abort = new AbortController();
      const next = link.nextEvent(abort.signal);
      abort.abort();
      await expect(next).resolves.toBeNull();
    });

    it("starts each run with no disconnect reason from the last one", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      peer.refuseUpgrades({ status: 503 });
      const first = agent.transport.connect();
      await refused(peer);
      peer.acceptUpgrades();
      await onWireClock(first);
      await onWireClock(agent.transport.disconnect());
      expect(agent.transport.getDisconnectReason()).toMatchObject({ status: 503 });

      const second = agent.transport.connect();

      expect(agent.transport.getDisconnectReason()).toBeNull();
      await onWireClock(second);
    });

    it("names the failed agent_control join as the cause when the boot times out", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer, { baseDelayS: 20, maxDelayS: 20 });
      peer.queueJoinOutcomes(CONTROL_TOPIC, Array.from({ length: 100 }, () => "error" as const));

      const outcome = agent.transport.connect().then(() => null, (error: unknown) => error);
      await advanceWireClock(BOOT_CONNECT_DEADLINE_MS + 1_000, 1_000);

      // The deadline's teardown polls phoenix's close on the fake clock, so keep it running.
      const error = await onWireClock(outcome);
      expect(error).toBeInstanceOf(TransportError);
      expect((error as Error).cause).toMatchObject({ code: "websocket.control_join_failed" });
    });

    it("does not wait out a silent peer's close before retrying a timed-out agent_control join", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      peer.queueJoinOutcomes(CONTROL_TOPIC, ["pending"]);

      const connecting = agent.transport.connect();
      await onWireClock(peer.joined.next((topic) => topic === CONTROL_TOPIC));
      peer.stallReads();
      // Phoenix's 10 s join timeout, then a close bounded well under ws's 30 s default.
      await onWireClock(connectionNumber(peer, 2), 15_000);
      peer.resumeReads();
      await onWireClock(connecting);
    });

    it("rejects connect() on a supersede that arrives while agent_control is joining", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      peer.queueJoinOutcomes(CONTROL_TOPIC, ["pending"]);

      const connecting = agent.transport.connect();
      const outcome = connecting.then(() => null, (error: unknown) => error);
      await peer.joined.next((topic) => topic === CONTROL_TOPIC);
      pushSupersede(peer, { reason: "session.already_connected", retryable: false });

      expect(await outcome).toBeInstanceOf(WebSocketDisconnectError);
      await advanceWireClock(PAST_ANY_DELAY_MS);
      expect(peer.connections.entries).toHaveLength(1);
      expect(agent.terminals).toHaveLength(1);
    });

    it("reports a boot refusal through BandLink", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      const link = new BandLink({ agentId: AGENT_ID, apiKey: "test-key", transport: agent.transport, restApi: new FakeRestApi() });
      peer.refuseUpgrades({ status: 403 });

      await expect(onWireClock(link.connect())).rejects.toBeInstanceOf(WebSocketDisconnectError);

      expect(link.getDisconnectReason()).toMatchObject({ source: "upgrade", status: 403 });
    });
  });

  describe("stopping a boot that is still retrying", () => {
    function runtimeOn(transport: PhoenixChannelsTransport): AgentRuntime {
      const link = new BandLink({ agentId: AGENT_ID, apiKey: "test-key", transport, restApi: new FakeRestApi() });
      return new AgentRuntime({ link, agentId: AGENT_ID, onExecute: async () => undefined });
    }

    it.each([
      ["once the boot is retrying", true],
      ["in the same tick as start()", false],
    ])("stop() returns without waiting out the boot deadline, %s", async (_when, waitForRetry) => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      const runtime = runtimeOn(agent.transport);
      peer.refuseUpgrades({ status: 503 });

      const starting = runtime.start().then(() => null, (error: unknown) => error);
      if (waitForRetry) {
        await refused(peer);
      }
      await onWireClock(runtime.stop());

      expect(await onWireClock(starting)).toBeInstanceOf(RuntimeStateError);
      const refusals = peer.refusals.entries.length;
      await advanceWireClock(PAST_ANY_DELAY_MS);
      expect(peer.refusals.entries).toHaveLength(refusals);
      expect(agent.terminals).toEqual([]);
    });

    it("neither start() nor stop() hangs when the session ends under start()'s agent_rooms join", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      const runtime = runtimeOn(agent.transport);
      const agentRooms = `agent_rooms:${AGENT_ID}`;
      peer.queueJoinOutcomes(agentRooms, ["pending"]);

      const starting = runtime.start().then(() => null, (error: unknown) => error);
      await onWireClock(peer.joins.until(() => peer.joins.entries.some((join) => join.topic === agentRooms)));
      peer.closeConnections(1008);

      await onWireClock(starting);
      // The session's end failed the runtime, so stop() reports that failure rather than hang.
      await expect(onWireClock(runtime.stop())).rejects.toBeInstanceOf(WebSocketDisconnectError);
      expect(runtime.state.status).toBe("failed");
    });

    it("aborting connect() rejects it and ends the boot's retries", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      peer.refuseUpgrades({ status: 503 });
      const abort = new AbortController();

      const connecting = agent.transport.connect(abort.signal);
      await refused(peer);
      abort.abort();

      await expect(onWireClock(connecting)).rejects.toBeInstanceOf(RuntimeStateError);
      const refusals = peer.refusals.entries.length;
      await advanceWireClock(PAST_ANY_DELAY_MS);
      expect(peer.refusals.entries).toHaveLength(refusals);
    });
  });
});
