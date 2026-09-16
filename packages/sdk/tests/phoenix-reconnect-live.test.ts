import { describe, expect, it, vi } from "vitest";
import { chatRoomTopic, roomParticipantsTopic } from "@band-ai/band-sdk-core";

import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";
import { SubscriptionManager } from "../src/platform/SubscriptionManager";
import { FakePhoenixPeer } from "./fakePhoenixPeer";

/**
 * Exercises the real `phoenix` client and a real `ws` socket end to end —
 * no mocked transport — to prove the reconnect-snapshot contract holds
 * against Phoenix's actual rejoin mechanics, not just our model of them.
 */
describe("Phoenix reconnect (real wire)", () => {
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
});
