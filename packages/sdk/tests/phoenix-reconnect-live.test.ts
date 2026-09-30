import { describe, expect, it, vi } from "vitest";
import { chatRoomTopic, roomParticipantsTopic } from "@band-ai/band-sdk-core";

import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";
import { SubscriptionManager } from "../src/platform/SubscriptionManager";
import { BandLink } from "../src/platform/BandLink";
import { AgentRuntime } from "../src/runtime/rooms/AgentRuntime";
import type { PlatformEvent } from "../src/platform/events";
import type { Logger } from "../src/core/logger";
import { FakePhoenixPeer } from "./fakePhoenixPeer";
import { FakeRestApi } from "./testUtils";

function wireMessage(id: string, content: string) {
  return {
    id,
    content,
    message_type: "text",
    sender_id: "user-1",
    sender_type: "User",
    sender_name: "User",
    metadata: {},
    inserted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const TWO_ROOMS = ["room-1", "room-2"] as const;

/** An agent on the real transport, in two rooms; `next` answers each room's `/messages/next`. Disposing it stops the runtime. */
async function startAgentInTwoRooms(
  peer: FakePhoenixPeer,
  next: (roomId: string) => ReturnType<typeof wireMessage> | null,
) {
  const transport = new PhoenixChannelsTransport({
    wsUrl: peer.url,
    apiKey: "test-key",
    agentId: "agent-1",
    reconnectAfterMs: () => 10,
  });
  const calls = { listChats: 0, next: new Map<string, number>() };
  const link = new BandLink({
    agentId: "agent-1",
    apiKey: "test-key",
    transport,
    restApi: new FakeRestApi({
      listChats: async () => {
        calls.listChats += 1;
        return {
          data: TWO_ROOMS.map((id) => ({ id, title: id })),
          metadata: { page: 1, pageSize: 100, totalPages: 1, totalCount: TWO_ROOMS.length },
        };
      },
      getNextMessage: async ({ chatId }) => {
        calls.next.set(chatId, (calls.next.get(chatId) ?? 0) + 1);
        return next(chatId);
      },
    }),
  });
  const executed: PlatformEvent[] = [];
  const runtime = new AgentRuntime({
    link,
    agentId: "agent-1",
    agentConfig: { autoSubscribeExistingRooms: true },
    onExecute: async (_context, event) => {
      executed.push(event);
    },
  });
  const stop = async () => {
    await runtime.stop().catch(() => undefined);
  };
  try {
    await runtime.start();
    // Both rooms are tracked and each has finished its startup sweep.
    await vi.waitFor(() => {
      expect(runtime.presence.roster.trackedRoomIds()).toEqual(expect.arrayContaining([...TWO_ROOMS]));
      for (const room of TWO_ROOMS) {
        expect(calls.next.get(room)).toBeGreaterThan(0);
      }
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { executed, calls, [Symbol.asyncDispose]: stop };
}

/**
 * Exercises the real `phoenix` client and a real `ws` socket end to end —
 * no mocked transport — to prove the reconnect-snapshot contract holds
 * against Phoenix's actual rejoin mechanics, not just our model of them.
 */
describe("Phoenix reconnect (real wire)", () => {
  it("rejects an in-flight join when disconnect removes its real Phoenix reply route", async () => {
    const peer = await FakePhoenixPeer.start();
    const transport = new PhoenixChannelsTransport({
      wsUrl: peer.url,
      apiKey: "test-key",
      reconnectAfterMs: () => 10,
    });
    const topic = "room:pending-disconnect";

    try {
      await transport.connect();
      peer.queueJoinOutcomes(topic, ["pending"]);
      const join = transport.join(topic, {});

      await vi.waitFor(
        () =>
          expect(peer.receivedEvents).toEqual(
            expect.arrayContaining([{ topic, event: "phx_join" }]),
          ),
        { timeout: 5000 },
      );

      await transport.disconnect();
      await expect(join).rejects.toThrow("superseded by transport disconnect");
    } finally {
      await transport.disconnect().catch(() => undefined);
      await peer.stop();
    }
  }, 10_000);

  it("publishes the recovery boundary before a message delivered by a rejoined room", async () => {
    const peer = await FakePhoenixPeer.start();
    const transport = new PhoenixChannelsTransport({
      wsUrl: peer.url,
      apiKey: "test-key",
      agentId: "agent-1",
      reconnectAfterMs: () => 10,
    });
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "test-key",
      transport,
      restApi: new FakeRestApi(),
    });

    try {
      await link.connect();
      await link.subscribeRoom("room-1");

      peer.queueJoinOutcomes(roomParticipantsTopic("room-1"), ["pending"]);
      peer.receivedEvents.length = 0;
      peer.severAllConnections();

      await vi.waitFor(
        () =>
          expect(peer.receivedEvents).toEqual(
            expect.arrayContaining([
              { topic: chatRoomTopic("room-1"), event: "phx_join" },
              { topic: roomParticipantsTopic("room-1"), event: "phx_join" },
            ]),
          ),
        { timeout: 5000 },
      );

      let eventResolved = false;
      const firstEvent = link.nextEvent().then((event) => {
        eventResolved = true;
        return event;
      });
      peer.push(
        chatRoomTopic("room-1"),
        "message_created",
        wireMessage("message-after-rejoin", "after reconnect"),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(eventResolved).toBe(false);

      peer.settleJoin(roomParticipantsTopic("room-1"), "ok");
      await expect(firstEvent).resolves.toEqual({
        type: "reconnected",
        roomId: null,
        payload: {},
      });
      await expect(link.nextEvent()).resolves.toMatchObject({
        type: "message_created",
        payload: { id: "message-after-rejoin" },
      });
    } finally {
      await link.disconnect().catch(() => undefined);
      await peer.stop();
    }
  }, 10_000);

  it("cleans up a room whose participant topic is rejected on automatic rejoin, then lets a fresh subscribe succeed", async () => {
    const peer = await FakePhoenixPeer.start();
    const transport = new PhoenixChannelsTransport({
      wsUrl: peer.url,
      apiKey: "test-key",
      agentId: "agent-1",
      reconnectAfterMs: () => 10,
    });
    const manager = new SubscriptionManager({ transport });

    let reconcileStarted = false;
    let reconcileDone: Promise<void> = Promise.resolve();
    transport.onReconnected((snapshot) => {
      reconcileStarted = true;
      reconcileDone = manager.reconcileReconnect(snapshot);
      return reconcileDone;
    });

    try {
      await transport.connect();
      await manager.subscribeRoom("room-1", { chat: {}, participants: {} });

      // The rejoin that follows the severed connection fails specifically
      // for room_participants; chat_room rejoins cleanly.
      peer.queueJoinOutcomes(roomParticipantsTopic("room-1"), ["error"]);
      peer.receivedEvents.length = 0;
      peer.severAllConnections();

      await vi.waitFor(() => expect(reconcileStarted).toBe(true), { timeout: 5000 });
      await reconcileDone;

      // Reconciliation cleaned up both of the room's topics on the wire —
      // a partially-rejoined room is not left half-subscribed.
      const leftTopics = peer.receivedEvents
        .filter((e) => e.event === "phx_leave")
        .map((e) => e.topic);
      expect(leftTopics).toEqual(
        expect.arrayContaining([chatRoomTopic("room-1"), roomParticipantsTopic("room-1")]),
      );

      // A fresh subscribe now succeeds normally.
      await expect(
        manager.subscribeRoom("room-1", { chat: {}, participants: {} }),
      ).resolves.toBeUndefined();
    } finally {
      await transport.disconnect().catch(() => undefined);
      await peer.stop();
    }
  }, 10_000);

  it("does not leave a room when a second reconnect supersedes unanswered rejoins", async () => {
    const peer = await FakePhoenixPeer.start();
    const transport = new PhoenixChannelsTransport({
      wsUrl: peer.url,
      apiKey: "test-key",
      reconnectAfterMs: () => 10,
    });
    const manager = new SubscriptionManager({ transport });
    transport.onReconnected((snapshot) => manager.reconcileReconnect(snapshot));
    const chatTopic = chatRoomTopic("room-1");
    const participantsTopic = roomParticipantsTopic("room-1");

    try {
      await transport.connect();
      await manager.subscribeRoom("room-1", { chat: {}, participants: {} });

      peer.queueJoinOutcomes(chatTopic, ["pending"]);
      peer.queueJoinOutcomes(participantsTopic, ["pending"]);
      peer.receivedEvents.length = 0;
      peer.severAllConnections();

      await vi.waitFor(
        () =>
          expect(peer.receivedEvents).toEqual(
            expect.arrayContaining([
              { topic: chatTopic, event: "phx_join" },
              { topic: participantsTopic, event: "phx_join" },
            ]),
          ),
        { timeout: 5000 },
      );

      peer.severAllConnections();
      await vi.waitFor(
        () =>
          expect(
            peer.receivedEvents.filter(
              (event) => event.event === "phx_join" && event.topic === chatTopic,
            ),
          ).toHaveLength(2),
        { timeout: 5000 },
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        peer.receivedEvents.filter(
          (event) =>
            event.event === "phx_leave" &&
            (event.topic === chatTopic || event.topic === participantsTopic),
        ),
      ).toEqual([]);
    } finally {
      await transport.disconnect().catch(() => undefined);
      await peer.stop();
    }
  }, 10_000);

  it("recovers a message missed during the outage through the real AgentRuntime dispatch path, never exposing the synthetic event to the adapter", async () => {
    const peer = await FakePhoenixPeer.start();
    const transport = new PhoenixChannelsTransport({
      wsUrl: peer.url,
      apiKey: "test-key",
      agentId: "agent-1",
      reconnectAfterMs: () => 10,
    });

    let releaseMissedMessage = false;
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "test-key",
      transport,
      restApi: new FakeRestApi({
        listChats: async () => ({
          data: [{ id: "room-1", title: "Room 1" }],
          metadata: { page: 1, pageSize: 100, totalPages: 1, totalCount: 1 },
        }),
        getNextMessage: async () => {
          if (!releaseMissedMessage) {
            return null;
          }
          releaseMissedMessage = false;
          return wireMessage("missed-message", "sent during the outage");
        },
      }),
    });

    const executedEvents: PlatformEvent[] = [];
    const runtime = new AgentRuntime({
      link,
      agentId: "agent-1",
      agentConfig: { autoSubscribeExistingRooms: true },
      onExecute: async (_context, event) => {
        executedEvents.push(event);
      },
    });

    try {
      await runtime.start();
      await vi.waitFor(() => expect(runtime.presence.roster.trackedRoomIds()).toContain("room-1"));

      // The message "arrives" while disconnected: the REST backlog will
      // return it once, only after the connection is severed below.
      releaseMissedMessage = true;
      peer.receivedEvents.length = 0;
      peer.severAllConnections();

      await vi.waitFor(
        () =>
          expect(peer.receivedEvents).toEqual(
            expect.arrayContaining([
              { topic: chatRoomTopic("room-1"), event: "phx_join" },
              { topic: roomParticipantsTopic("room-1"), event: "phx_join" },
            ]),
          ),
        { timeout: 5000 },
      );

      await vi.waitFor(
        () =>
          expect(executedEvents).toEqual([
            expect.objectContaining({
              type: "message_created",
              payload: expect.objectContaining({ id: "missed-message" }),
            }),
          ]),
        { timeout: 5000 },
      );

      // The synthetic reconnect boundary itself must never reach the adapter.
      expect(executedEvents.some((event) => event.type === "reconnected")).toBe(false);
    } finally {
      await runtime.stop().catch(() => undefined);
      await peer.stop();
    }
  }, 10_000);

  it("recovers room membership changes made during the outage through a real reconnect snapshot", async () => {
    const peer = await FakePhoenixPeer.start();
    const transport = new PhoenixChannelsTransport({
      wsUrl: peer.url,
      apiKey: "test-key",
      agentId: "agent-1",
      reconnectAfterMs: () => 10,
    });

    let snapshotRooms: Array<{ id: string; title: string }> = [{ id: "room-1", title: "Room 1" }];
    const link = new BandLink({
      agentId: "agent-1",
      apiKey: "test-key",
      transport,
      restApi: new FakeRestApi({
        listChats: async () => ({
          data: snapshotRooms,
          metadata: { page: 1, pageSize: 100, totalPages: 1, totalCount: snapshotRooms.length },
        }),
      }),
    });

    const runtime = new AgentRuntime({
      link,
      agentId: "agent-1",
      agentConfig: { autoSubscribeExistingRooms: true },
      onExecute: async () => {},
    });

    try {
      await runtime.start();
      await vi.waitFor(() => expect(runtime.presence.roster.trackedRoomIds()).toContain("room-1"));

      // While disconnected, the REST snapshot changes: room-1 drops off,
      // room-2 is newly listed.
      snapshotRooms = [{ id: "room-2", title: "Room 2" }];
      peer.receivedEvents.length = 0;
      peer.severAllConnections();

      // Phoenix's own reconnect machinery rejoins room-1's topics
      // automatically at the transport level, unaware of the REST-level
      // membership change — recovery has to come from the reconnect
      // snapshot's REST reconciliation, not from anything the rejoin itself
      // reports.
      await vi.waitFor(
        () =>
          expect(peer.receivedEvents).toEqual(
            expect.arrayContaining([
              { topic: chatRoomTopic("room-1"), event: "phx_join" },
              { topic: roomParticipantsTopic("room-1"), event: "phx_join" },
            ]),
          ),
        { timeout: 5000 },
      );

      await vi.waitFor(
        () => expect(runtime.presence.roster.trackedRoomIds()).toEqual(["room-2"]),
        { timeout: 5000 },
      );

      // The stale room-1 topics were actually left on the wire, and
      // room-2's were actually joined — not just updated in local roster
      // state.
      await vi.waitFor(() =>
        expect(peer.receivedEvents).toEqual(
          expect.arrayContaining([
            { topic: chatRoomTopic("room-1"), event: "phx_leave" },
            { topic: roomParticipantsTopic("room-1"), event: "phx_leave" },
            { topic: chatRoomTopic("room-2"), event: "phx_join" },
            { topic: roomParticipantsTopic("room-2"), event: "phx_join" },
          ]),
        ),
      );
    } finally {
      await runtime.stop().catch(() => undefined);
      await peer.stop();
    }
  }, 10_000);

  describe("a channel that rejoins on a socket that never dropped", () => {
    const CHAT_TOPIC = chatRoomTopic("room-1");
    const missedMessage = () => wireMessage("missed-message", "sent while the channel was gone");
    const executedMissed = (executed: PlatformEvent[]) =>
      expect(executed).toEqual([
        expect.objectContaining({ type: "message_created", payload: expect.objectContaining({ id: "missed-message" }) }),
      ]);

    it("is caught up by its own room's sweep alone, without the adapter seeing the synthetic event", async () => {
      await using peer = await FakePhoenixPeer.start();
      let missed: ReturnType<typeof wireMessage> | null = null;
      await using agent = await startAgentInTwoRooms(peer, (roomId) => {
        const message = roomId === "room-1" ? missed : null;
        missed = null;
        return message;
      });
      const { executed, calls } = agent;

      const listedBefore = calls.listChats;
      const otherRoomSweepsBefore = calls.next.get("room-2");
      peer.receivedEvents.length = 0;

      // The message is only in the REST backlog: the channel was not there to receive it.
      missed = missedMessage();
      peer.push(CHAT_TOPIC, "phx_error", {});

      await vi.waitFor(() => executedMissed(executed), { timeout: 10_000 });
      expect(executed.some((event) => event.type === "reconnected")).toBe(false);
      expect(calls.listChats).toBe(listedBefore);
      expect(calls.next.get("room-2")).toBe(otherRoomSweepsBefore);
      expect(peer.receivedEvents).toEqual([{ topic: CHAT_TOPIC, event: "phx_join" }]);
    }, 15_000);

    it("is caught up only once the rejoin succeeds, not while it is still failing", async () => {
      await using peer = await FakePhoenixPeer.start();
      const joinsOfRoom = () =>
        peer.receivedEvents.filter((event) => event.topic === CHAT_TOPIC && event.event === "phx_join").length;
      let missed: ReturnType<typeof wireMessage> | null = null;
      let joinsWhenServed: number | undefined;
      await using agent = await startAgentInTwoRooms(peer, (roomId) => {
        if (roomId !== "room-1" || !missed) {
          return null;
        }
        joinsWhenServed = joinsOfRoom();
        const message = missed;
        missed = null;
        return message;
      });

      peer.receivedEvents.length = 0;
      peer.queueJoinOutcomes(CHAT_TOPIC, ["error", "ok"]);
      missed = missedMessage();
      peer.push(CHAT_TOPIC, "phx_error", {});

      await vi.waitFor(() => executedMissed(agent.executed), { timeout: 15_000 });
      // The failed rejoin and the one that succeeded: the sweep ran after the second.
      expect(joinsWhenServed).toBe(2);
    }, 20_000);
  });

  describe("intentional disconnects stay disconnected", () => {
    const HEARTBEAT_INTERVAL_MS = 100;
    // Phoenix gives up waiting on a stalled close after ~1.5s, then a heartbeat
    // timeout schedules its reconnect; this leaves room for both.
    const SUPPRESSED_RECONNECT_TIMEOUT_MS = 5_000;

    /** A real transport whose debug log records every reconnect the gate refuses. */
    function transportOn(peer: FakePhoenixPeer, agentId?: string) {
      const suppressedReconnects: unknown[] = [];
      const logger: Logger = {
        debug: (message, context) => {
          if (message.startsWith("Suppressed phoenix reconnect")) {
            suppressedReconnects.push(context);
          }
        },
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      };
      const transport = new PhoenixChannelsTransport({
        wsUrl: peer.url,
        apiKey: "test-key",
        agentId,
        logger,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        reconnectAfterMs: () => 10,
      });
      return { transport, suppressedReconnects };
    }

    async function expectNoReconnect(
      peer: FakePhoenixPeer,
      transport: PhoenixChannelsTransport,
      suppressedReconnects: unknown[],
    ): Promise<void> {
      await vi.waitFor(() => expect(suppressedReconnects.length).toBeGreaterThan(0), {
        timeout: SUPPRESSED_RECONNECT_TIMEOUT_MS,
      });
      expect(peer.connectionCount).toBe(1);
      expect(transport.isConnected()).toBe(false);
    }

    it("never reconnects after a supersede whose close handshake stalls", async () => {
      await using peer = await FakePhoenixPeer.start();
      const { transport, suppressedReconnects } = transportOn(peer, "agent-1");
      try {
        await transport.connect();

        peer.stallReads();
        peer.push("agent_control:agent-1", "supersede", {
          reason: "session.already_connected",
          message: "superseded",
          retryable: false,
          correlation_id: null,
        });

        await expectNoReconnect(peer, transport, suppressedReconnects);
        expect(transport.getDisconnectReason()?.code).toBe("session.already_connected");
      } finally {
        await transport.disconnect().catch(() => undefined);
      }
    }, 10_000);

    it("never reconnects after disconnect() when its close handshake stalls", async () => {
      await using peer = await FakePhoenixPeer.start();
      const { transport, suppressedReconnects } = transportOn(peer);
      try {
        await transport.connect();

        peer.stallReads();
        await transport.disconnect();

        await expectNoReconnect(peer, transport, suppressedReconnects);
      } finally {
        await transport.disconnect().catch(() => undefined);
      }
    }, 10_000);
  });
});
