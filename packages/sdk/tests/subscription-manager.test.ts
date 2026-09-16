import { describe, expect, it } from "vitest";
import { chatRoomTopic, roomParticipantsTopic, agentRoomsTopic } from "@band-ai/band-sdk-core";

import { SubscriptionManager } from "../src/platform/SubscriptionManager";
import { RuntimeStateError } from "../src/core/errors";
import type { StreamingTransport, TopicHandlers } from "../src/platform/streaming/transport";

type JoinOutcome = "ok" | "error";

class FakeTransport implements StreamingTransport {
  public readonly joinCalls: string[] = [];
  public readonly leaveCalls: string[] = [];
  private readonly joinOutcomes = new Map<string, JoinOutcome>();
  private readonly leaveOutcomes = new Map<string, JoinOutcome>();
  private readonly joinGates = new Map<string, Promise<void>>();

  public async connect(): Promise<void> {
    return undefined;
  }

  public async disconnect(): Promise<void> {
    return undefined;
  }

  public isConnected(): boolean {
    return true;
  }

  public async runForever(): Promise<void> {
    return undefined;
  }

  public async join(topic: string, _handlers: TopicHandlers): Promise<void> {
    this.joinCalls.push(topic);
    const gate = this.joinGates.get(topic);
    if (gate) {
      await gate;
    }
    if (this.joinOutcomes.get(topic) === "error") {
      throw new Error(`join failed: ${topic}`);
    }
  }

  public async leave(topic: string): Promise<void> {
    this.leaveCalls.push(topic);
    if (this.leaveOutcomes.get(topic) === "error") {
      throw new Error(`leave failed: ${topic}`);
    }
  }

  /** Blocks every `join(topic, ...)` call until the returned function runs. */
  public gateJoin(topic: string): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.joinGates.set(topic, gate);
    return () => {
      this.joinGates.delete(topic);
      release();
    };
  }

  public failJoin(topic: string): void {
    this.joinOutcomes.set(topic, "error");
  }

  public failLeave(topic: string): void {
    this.leaveOutcomes.set(topic, "error");
  }

  public clearLeaveFailure(topic: string): void {
    this.leaveOutcomes.delete(topic);
  }

  public clearJoinFailure(topic: string): void {
    this.joinOutcomes.delete(topic);
  }

  public joinCountOf(topic: string): number {
    return this.joinCalls.filter((t) => t === topic).length;
  }
}

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
