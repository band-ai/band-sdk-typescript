import { describe, expect, it } from "vitest";
import { chatRoomTopic, roomParticipantsTopic, agentRoomsTopic } from "@band-ai/band-sdk-core";

import { SubscriptionManager } from "../src/platform/SubscriptionManager";
import { RuntimeStateError } from "../src/core/errors";
import type { TopicHandlers } from "../src/platform/streaming/transport";
import { FakeTransport } from "./testUtils";

const NO_HANDLERS: TopicHandlers = {};
const ROOM_HANDLERS = { chat: NO_HANDLERS, participants: NO_HANDLERS };

function reconnectSnapshot(
  generation: number,
  joinedTopics: string[],
  attemptedTopics = joinedTopics,
) {
  return {
    generation,
    attemptedTopics: new Set(attemptedTopics),
    joinedTopics: new Set(joinedTopics),
  };
}

describe("SubscriptionManager", () => {
  describe("operation coalescing", () => {
    it("shares the real completion across concurrent same-kind calls", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });

      const [a, b] = await Promise.all([
        manager.subscribeRoom("room-1", ROOM_HANDLERS),
        manager.subscribeRoom("room-1", ROOM_HANDLERS),
      ]);

      expect(a).toBeUndefined();
      expect(b).toBeUndefined();
      expect(transport.joinCountOf(chatRoomTopic("room-1"))).toBe(1);
      expect(transport.joinCountOf(roomParticipantsTopic("room-1"))).toBe(1);
    });

    it("serializes subscribe/unsubscribe/subscribe for the same room", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      const releaseChatJoin = transport.gateJoin(chatRoomTopic("room-1"));

      const subscribe1 = manager.subscribeRoom("room-1", ROOM_HANDLERS);
      const unsubscribe = manager.unsubscribeRoom("room-1");
      const subscribe2 = manager.subscribeRoom("room-1", ROOM_HANDLERS);

      // Nothing beyond the first join can proceed while it is gated.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(transport.leaveCalls).toEqual([]);
      expect(transport.joinCountOf(chatRoomTopic("room-1"))).toBe(1);

      releaseChatJoin();
      await subscribe1;
      await unsubscribe;
      await subscribe2;

      expect(transport.leaveCalls).toContain(chatRoomTopic("room-1"));
      expect(transport.leaveCalls).toContain(roomParticipantsTopic("room-1"));
      // subscribe1's join, then subscribe2's fresh join after the unsubscribe.
      expect(transport.joinCountOf(chatRoomTopic("room-1"))).toBe(2);
    });
  });

  describe("room subscribe", () => {
    it("permits a clean retry after a chat_room join failure", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      transport.failJoin(chatRoomTopic("room-1"));

      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).rejects.toThrow(
        "join failed",
      );

      transport.clearJoinFailure(chatRoomTopic("room-1"));
      transport.joinCalls.length = 0;
      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).resolves.toBeUndefined();
      expect(transport.joinCountOf(chatRoomTopic("room-1"))).toBe(1);
      expect(transport.joinCountOf(roomParticipantsTopic("room-1"))).toBe(1);
    });

    it("permits a clean retry after a participant join failure with a successful rollback", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      transport.failJoin(roomParticipantsTopic("room-1"));

      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).rejects.toThrow(
        "join failed",
      );
      expect(transport.leaveCalls).toEqual([chatRoomTopic("room-1")]);

      transport.clearJoinFailure(roomParticipantsTopic("room-1"));
      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).resolves.toBeUndefined();
    });

    it("blocks retry behind reconnect cleanup when the participant join fails and the rollback also fails", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      transport.failJoin(roomParticipantsTopic("room-1"));
      transport.failLeave(chatRoomTopic("room-1"));

      const failure = await manager.subscribeRoom("room-1", ROOM_HANDLERS).catch((error) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        expect.objectContaining({ message: `join failed: ${roomParticipantsTopic("room-1")}` }),
        expect.objectContaining({ message: `leave failed: ${chatRoomTopic("room-1")}` }),
      ]);

      // The room needs reconciliation now — a fresh subscribe attempt must
      // reject clearly rather than silently retry or look like success.
      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).rejects.toBeInstanceOf(
        RuntimeStateError,
      );
    });

    it("drains a blocked room once a reconnect settles cleanup", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      transport.failJoin(roomParticipantsTopic("room-1"));
      transport.failLeave(chatRoomTopic("room-1"));

      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).rejects.toThrow(AggregateError);
      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).rejects.toBeInstanceOf(
        RuntimeStateError,
      );

      // The transport's own reconnect has since restored a clean topic state.
      transport.clearJoinFailure(roomParticipantsTopic("room-1"));
      transport.clearLeaveFailure(chatRoomTopic("room-1"));
      await manager.reconcileReconnect(reconnectSnapshot(1, []));

      transport.joinCalls.length = 0;
      transport.leaveCalls.length = 0;
      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).resolves.toBeUndefined();
    });
  });

  describe("room unsubscribe", () => {
    it("attempts both room leaves and aggregates failures", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      await manager.subscribeRoom("room-1", ROOM_HANDLERS);

      transport.failLeave(chatRoomTopic("room-1"));
      transport.failLeave(roomParticipantsTopic("room-1"));

      await expect(manager.unsubscribeRoom("room-1")).rejects.toThrow(AggregateError);
      expect(transport.leaveCalls).toEqual(
        expect.arrayContaining([chatRoomTopic("room-1"), roomParticipantsTopic("room-1")]),
      );
    });

    it("is a no-op for a room that was never subscribed", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });

      await expect(manager.unsubscribeRoom("room-1")).resolves.toBeUndefined();
      expect(transport.leaveCalls).toEqual([]);
    });

    it("still rejects with the real leave failures when the session ends while both leaves are in flight", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      await manager.subscribeRoom("room-1", ROOM_HANDLERS);

      transport.failLeave(chatRoomTopic("room-1"));
      transport.failLeave(roomParticipantsTopic("room-1"));
      const releaseChatLeave = transport.gateLeave(chatRoomTopic("room-1"));
      const releaseParticipantsLeave = transport.gateLeave(roomParticipantsTopic("room-1"));

      const unsubscribe = manager.unsubscribeRoom("room-1");
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The session ends while both leave calls are still pending, making the
      // tracker's ticket stale by the time they settle.
      manager.endSession();
      releaseChatLeave();
      releaseParticipantsLeave();

      // A stale ticket must not swallow the two real transport failures.
      const failure = await unsubscribe.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        expect.objectContaining({ message: `leave failed: ${chatRoomTopic("room-1")}` }),
        expect.objectContaining({ message: `leave failed: ${roomParticipantsTopic("room-1")}` }),
      ]);
    });
  });

  describe("agent topics (agent_rooms, agent_contacts)", () => {
    it("uses the same ticketed join/leave behavior as rooms", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      const topic = agentRoomsTopic("agent-1");

      await expect(manager.subscribeAgentTopic(topic, NO_HANDLERS)).resolves.toBeUndefined();
      // Idempotent: already joined.
      await expect(manager.subscribeAgentTopic(topic, NO_HANDLERS)).resolves.toBeUndefined();
      expect(transport.joinCountOf(topic)).toBe(1);

      await expect(manager.unsubscribeAgentTopic(topic)).resolves.toBeUndefined();
      expect(transport.leaveCalls).toEqual([topic]);

      await expect(manager.subscribeAgentTopic(topic, NO_HANDLERS)).resolves.toBeUndefined();
      expect(transport.joinCountOf(topic)).toBe(2);
    });

    it("rejects a fresh join while a topic needs reconciliation, then permits it after reconnect cleanup", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      const topic = agentRoomsTopic("agent-1");

      await manager.subscribeAgentTopic(topic, NO_HANDLERS);
      transport.failLeave(topic);
      await expect(manager.unsubscribeAgentTopic(topic)).rejects.toThrow("leave failed");

      await expect(manager.subscribeAgentTopic(topic, NO_HANDLERS)).rejects.toBeInstanceOf(
        RuntimeStateError,
      );

      transport.clearLeaveFailure(topic);
      await manager.reconcileReconnect(reconnectSnapshot(1, []));

      transport.joinCalls.length = 0;
      await expect(manager.subscribeAgentTopic(topic, NO_HANDLERS)).resolves.toBeUndefined();
      expect(transport.joinCountOf(topic)).toBe(1);
    });

    it("still rejects a real leave failure even when the session ends while it is in flight", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      const topic = agentRoomsTopic("agent-1");
      await manager.subscribeAgentTopic(topic, NO_HANDLERS);

      transport.failLeave(topic);
      const releaseLeave = transport.gateLeave(topic);
      const unsubscribe = manager.unsubscribeAgentTopic(topic);
      await new Promise((resolve) => setTimeout(resolve, 0));

      manager.endSession();
      releaseLeave();

      await expect(unsubscribe).rejects.toThrow("leave failed");
    });
  });

  describe("endSession", () => {
    it("makes a late completion stale and cannot disturb a new session", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      const release = transport.gateJoin(chatRoomTopic("room-1"));

      const staleSubscribe = manager.subscribeRoom("room-1", ROOM_HANDLERS);
      await new Promise((resolve) => setTimeout(resolve, 0));

      manager.endSession();
      release();

      // The stale operation's own promise still reports its real transport
      // outcome; it just leaves no trace in the (now-reset) tracker.
      await expect(staleSubscribe).resolves.toBeUndefined();

      transport.joinCalls.length = 0;
      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).resolves.toBeUndefined();
      // A genuinely fresh claim in the new session, not treated as already
      // subscribed because of the stale session's late success.
      expect(transport.joinCountOf(chatRoomTopic("room-1"))).toBe(1);
    });

    it("discards a late join failure after the session ended rather than blocking a new session's tracker", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      transport.failJoin(chatRoomTopic("room-1"));
      const release = transport.gateJoin(chatRoomTopic("room-1"));

      const staleSubscribe = manager.subscribeRoom("room-1", ROOM_HANDLERS).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 0));

      manager.endSession();
      release();

      // The stale operation's own promise still reports its real failure...
      expect(await staleSubscribe).toBeInstanceOf(Error);

      // ...but a fresh session's claim is unaffected by it: a genuinely new
      // subscribe attempt succeeds cleanly rather than inheriting a phantom
      // failed/blocked state from the ended session.
      transport.clearJoinFailure(chatRoomTopic("room-1"));
      transport.joinCalls.length = 0;
      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).resolves.toBeUndefined();
      expect(transport.joinCountOf(chatRoomTopic("room-1"))).toBe(1);
    });

    it("clears in-flight operations so a new session's calls are not coalesced against the old one", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      const release = transport.gateJoin(chatRoomTopic("room-1"));

      void manager.subscribeRoom("room-1", ROOM_HANDLERS).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));

      manager.endSession();

      transport.joinCalls.length = 0;
      const fresh = manager.subscribeRoom("room-1", ROOM_HANDLERS);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(transport.joinCountOf(chatRoomTopic("room-1"))).toBe(1);

      release();
      await fresh;
    });
  });

  describe("reconnect reconciliation", () => {
    it("does not apply a queued stale snapshot to a fresh subscription generation", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      await manager.subscribeRoom("room-a", ROOM_HANDLERS);
      await manager.subscribeRoom("room-b", ROOM_HANDLERS);

      const releaseChatLeave = transport.gateLeave(chatRoomTopic("room-b"));
      const releaseParticipantsLeave = transport.gateLeave(roomParticipantsTopic("room-b"));
      const firstReconcile = manager.reconcileReconnect(
        reconnectSnapshot(
          1,
          [chatRoomTopic("room-a"), roomParticipantsTopic("room-a")],
          [
            chatRoomTopic("room-a"),
            roomParticipantsTopic("room-a"),
            chatRoomTopic("room-b"),
            roomParticipantsTopic("room-b"),
          ],
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      const staleReconcile = manager.reconcileReconnect(
        reconnectSnapshot(
          2,
          [],
          [chatRoomTopic("room-a"), roomParticipantsTopic("room-a")],
        ),
      );
      await manager.unsubscribeRoom("room-a");
      await manager.subscribeRoom("room-a", ROOM_HANDLERS);
      transport.leaveCalls.length = 0;

      releaseChatLeave();
      releaseParticipantsLeave();
      await Promise.all([firstReconcile, staleReconcile]);

      expect(transport.leaveCalls).not.toContain(chatRoomTopic("room-a"));
      expect(transport.leaveCalls).not.toContain(roomParticipantsTopic("room-a"));
    });

    it("does not judge a subscription created after the reconnect snapshot", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      await manager.subscribeRoom("room-a", ROOM_HANDLERS);

      const snapshot = reconnectSnapshot(1, [
        chatRoomTopic("room-a"),
        roomParticipantsTopic("room-a"),
      ]);
      await manager.subscribeRoom("room-b", ROOM_HANDLERS);
      transport.leaveCalls.length = 0;

      await manager.reconcileReconnect(snapshot);

      expect(transport.leaveCalls).toEqual([]);
      transport.joinCalls.length = 0;
      await expect(manager.subscribeRoom("room-b", ROOM_HANDLERS)).resolves.toBeUndefined();
      expect(transport.joinCalls).toEqual([]);
    });

    it("does nothing for a generation at or below the last reconciled one", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      await manager.subscribeRoom("room-1", ROOM_HANDLERS);

      await manager.reconcileReconnect(
        reconnectSnapshot(1, [chatRoomTopic("room-1"), roomParticipantsTopic("room-1")]),
      );
      transport.leaveCalls.length = 0;

      // A stale/duplicate generation must not re-run reconciliation.
      await manager.reconcileReconnect(reconnectSnapshot(1, []));
      expect(transport.leaveCalls).toEqual([]);
    });

    it("leaves a subscribed room alone when the reconnect snapshot shows both its topics rejoined", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      await manager.subscribeRoom("room-1", ROOM_HANDLERS);

      await manager.reconcileReconnect(
        reconnectSnapshot(1, [chatRoomTopic("room-1"), roomParticipantsTopic("room-1")]),
      );

      expect(transport.leaveCalls).toEqual([]);
      // The room is still considered subscribed — a second subscribe call is
      // a pure no-op, not a fresh join.
      transport.joinCalls.length = 0;
      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).resolves.toBeUndefined();
      expect(transport.joinCalls).toEqual([]);
    });

    it("cleans up a room whose rejoin the snapshot shows as missing, then permits a fresh subscribe", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      await manager.subscribeRoom("room-1", ROOM_HANDLERS);
      transport.leaveCalls.length = 0;

      // Only chat_room rejoined; room_participants is missing from the
      // snapshot, so the room as a whole did not survive the reconnect.
      await manager.reconcileReconnect(
        reconnectSnapshot(
          1,
          [chatRoomTopic("room-1")],
          [chatRoomTopic("room-1"), roomParticipantsTopic("room-1")],
        ),
      );

      expect(transport.leaveCalls).toEqual(
        expect.arrayContaining([chatRoomTopic("room-1"), roomParticipantsTopic("room-1")]),
      );

      transport.joinCalls.length = 0;
      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).resolves.toBeUndefined();
      expect(transport.joinCountOf(chatRoomTopic("room-1"))).toBe(1);
    });

    it("cleans up a missing agent topic the same way", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      const topic = agentRoomsTopic("agent-1");
      await manager.subscribeAgentTopic(topic, NO_HANDLERS);
      transport.leaveCalls.length = 0;

      await manager.reconcileReconnect(reconnectSnapshot(1, [], [topic]));

      expect(transport.leaveCalls).toEqual([topic]);
      transport.joinCalls.length = 0;
      await expect(manager.subscribeAgentTopic(topic, NO_HANDLERS)).resolves.toBeUndefined();
      expect(transport.joinCountOf(topic)).toBe(1);
    });

    it("retains a failed cleanup for the next reconnect rather than acknowledging it early", async () => {
      const transport = new FakeTransport();
      const manager = new SubscriptionManager({ transport });
      await manager.subscribeRoom("room-1", ROOM_HANDLERS);
      transport.failLeave(chatRoomTopic("room-1"));

      await manager.reconcileReconnect(
        reconnectSnapshot(1, [], [chatRoomTopic("room-1"), roomParticipantsTopic("room-1")]),
      );

      // Cleanup failed, so a fresh subscribe still sees the room as blocked.
      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).rejects.toBeInstanceOf(
        RuntimeStateError,
      );

      // The next reconnect retries the same cleanup; once it can actually
      // leave both topics, the room becomes claimable again.
      transport.clearLeaveFailure(chatRoomTopic("room-1"));

      await manager.reconcileReconnect(
        reconnectSnapshot(2, [], [chatRoomTopic("room-1"), roomParticipantsTopic("room-1")]),
      );
      await expect(manager.subscribeRoom("room-1", ROOM_HANDLERS)).resolves.toBeUndefined();
    });
  });
});
