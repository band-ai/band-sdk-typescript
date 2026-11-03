import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentControlTopic } from "@band-ai/band-sdk-core";

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
    onTerminalDisconnect: (reason) => terminals.push(reason),
  });
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

/** Steps the fake clock until `work` settles, for work that waits on both timers and real IO. */
async function onWireClock<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = work.finally(() => (settled = true));
  // Handled here so a rejection is not reported while the clock steps; the caller still sees it.
  tracked.catch(() => undefined);
  for (let elapsed = 0; !settled && elapsed < PAST_ANY_DELAY_MS; elapsed += 100) {
    await advanceWireClock(100);
  }
  return tracked;
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

afterEach(() => {
  vi.useRealTimers();
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
      while (peer.refusals.entries.length === 0) {
        await advanceWireClock(100);
      }
      peer.acceptUpgrades();

      await advanceWireClock(6_800);
      expect(peer.connections.entries).toHaveLength(1);
      await advanceWireClock(400);
      await connectionNumber(peer, 2);
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

      peer.push(CONTROL_TOPIC, "supersede", {
        reason: "session.reconnect",
        message: "reconnect",
        retryable: true,
        retry_after: -1,
        correlation_id: null,
      });
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

    it("treats a negative Retry-After as no hint", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      await agent.transport.connect();

      peer.refuseUpgrades({ status: 503, headers: { "Retry-After": "-5" } });
      peer.severAllConnections();
      await onWireClock(peer.refusals.until(() => peer.refusals.entries.length > 1));

      expect(peer.refusals.entries.length).toBeGreaterThan(1);
      expect(agent.terminals).toEqual([]);
    });
  });

  describe("local stops", () => {
    it("never reconnects after disconnect(), while connected or during a backoff", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer, { baseDelayS: 1, maxDelayS: 1 });
      await agent.transport.connect();
      await onWireClock(agent.transport.disconnect());
      await onWireClock(agent.transport.connect());

      peer.severAllConnections();
      while (agent.transport.isConnected()) {
        await advanceWireClock(100);
      }
      // Now inside the 1 s backoff, with phoenix's reconnect already scheduled.
      await onWireClock(agent.transport.disconnect());
      await advanceWireClock(PAST_ANY_DELAY_MS);

      expect(peer.connections.entries).toHaveLength(2);
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
      while (peer.refusals.entries.length === 0) {
        await advanceWireClock(100);
      }

      const again = agent.transport.connect();
      await advanceWireClock(6_800);
      expect(peer.refusals.entries, "no attempt inside the server's 7 s floor").toHaveLength(1);
      peer.acceptUpgrades();
      await reconnected(peer, 2);
      await again;

      expect(agent.transport.isConnected()).toBe(true);
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
      while (peer.refusals.entries.length < 2) {
        await advanceWireClock(100);
      }
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

      const error = await outcome;
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
      while (peer.refusals.entries.length === 0) {
        await advanceWireClock(100);
      }
      peer.acceptUpgrades();
      await onWireClock(first);
      await onWireClock(agent.transport.disconnect());
      expect(agent.transport.getDisconnectReason()).toMatchObject({ status: 503 });

      const second = agent.transport.connect();

      expect(agent.transport.getDisconnectReason()).toBeNull();
      await onWireClock(second);
    });

    it("rejects connect() on a supersede that arrives while agent_control is joining", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      peer.queueJoinOutcomes(CONTROL_TOPIC, ["pending"]);

      const connecting = agent.transport.connect();
      const outcome = connecting.then(() => null, (error: unknown) => error);
      await peer.joined.next((topic) => topic === CONTROL_TOPIC);
      peer.push(CONTROL_TOPIC, "supersede", {
        reason: "session.already_connected",
        message: "superseded",
        retryable: false,
        correlation_id: null,
      });

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
        while (peer.refusals.entries.length === 0) {
          await advanceWireClock(100);
        }
      }
      await onWireClock(runtime.stop());

      expect(await onWireClock(starting)).toBeInstanceOf(RuntimeStateError);
      const refusals = peer.refusals.entries.length;
      await advanceWireClock(PAST_ANY_DELAY_MS);
      expect(peer.refusals.entries).toHaveLength(refusals);
      expect(agent.terminals).toEqual([]);
    });

    it("aborting connect() rejects it and ends the boot's retries", async () => {
      await using peer = await startPeer();
      await using agent = transportFor(peer);
      peer.refuseUpgrades({ status: 503 });
      const abort = new AbortController();

      const connecting = agent.transport.connect(abort.signal);
      while (peer.refusals.entries.length === 0) {
        await advanceWireClock(100);
      }
      abort.abort();

      await expect(onWireClock(connecting)).rejects.toBeInstanceOf(RuntimeStateError);
      const refusals = peer.refusals.entries.length;
      await advanceWireClock(PAST_ANY_DELAY_MS);
      expect(peer.refusals.entries).toHaveLength(refusals);
    });
  });
});
