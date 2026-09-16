import { SubscriptionTracker } from "@band-ai/band-sdk-core";
import type { LeaveOutcome } from "@band-ai/band-sdk-core";
import { RuntimeStateError, TransportError } from "../core/errors";
import type { Logger } from "../core/logger";
import { NoopLogger } from "../core/logger";
import { Epoch } from "../core/epoch";
import { ReconciliationCoordinator } from "./ReconciliationCoordinator";
import { roomTopics, settleRoomLeaves } from "./roomTopics";
import type {
  ReconnectSnapshot,
  StreamingTransport,
  TopicHandlers,
} from "./streaming/transport";

export interface RoomTopicHandlers {
  chat: TopicHandlers;
  participants: TopicHandlers;
}

interface Operation {
  kind: "up" | "down";
  promise: Promise<void>;
}

function roomOperationKey(roomId: string): string {
  return `room:${roomId}`;
}

function topicOperationKey(topic: string): string {
  return `topic:${topic}`;
}

/**
 * Owns the one `SubscriptionTracker` for this agent session and turns its
 * transport-independent decisions into real Phoenix joins/leaves. Every
 * public operation is keyed and coalesced so concurrent callers for the same
 * room or topic share one in-flight attempt rather than racing the tracker.
 *
 * Never mirrors tracker state: `roomStatus`/`agentTopicStatus` are always
 * read fresh from the tracker, and every ticket lives only as long as the
 * operation that claimed it.
 */
export class SubscriptionManager {
  private readonly tracker = new SubscriptionTracker();
  private readonly transport: StreamingTransport;
  private readonly logger: Logger;
  private readonly operations = new Map<string, Operation>();
  private readonly epoch = new Epoch();
  private readonly reconciliation: ReconciliationCoordinator;

  public constructor(options: { transport: StreamingTransport; logger?: Logger }) {
    this.transport = options.transport;
    this.logger = options.logger ?? new NoopLogger();
    this.reconciliation = new ReconciliationCoordinator(
      this.tracker,
      this.transport,
      this.logger,
      this.epoch,
    );
  }

  public subscribeRoom(roomId: string, handlers: RoomTopicHandlers): Promise<void> {
    return this.runOperation(roomOperationKey(roomId), "up", () =>
      this.claimRoomSubscribe(roomId, handlers),
    );
  }

  public unsubscribeRoom(roomId: string): Promise<void> {
    return this.runOperation(roomOperationKey(roomId), "down", () =>
      this.claimRoomUnsubscribe(roomId),
    );
  }

  public subscribeAgentTopic(topic: string, handlers: TopicHandlers): Promise<void> {
    return this.runOperation(topicOperationKey(topic), "up", () =>
      this.claimAgentTopicJoin(topic, handlers),
    );
  }

  public unsubscribeAgentTopic(topic: string): Promise<void> {
    return this.runOperation(topicOperationKey(topic), "down", () =>
      this.claimAgentTopicLeave(topic),
    );
  }

  /** Serialized: each generation's reconciliation completes before the next begins. */
  public reconcileReconnect(snapshot: ReconnectSnapshot): Promise<void> {
    return this.reconciliation.reconcileReconnect(snapshot);
  }

  /**
   * Ends this session: every ticket issued so far goes stale, every in-flight
   * operation's late completion becomes a no-op, and both reconciliation sets
   * start empty for the next session. The epoch guards host-side async work
   * and transport effects that can outlive the core session they started in.
   */
  public endSession(): void {
    this.epoch.bump();
    this.tracker.endSession();
    this.operations.clear();
    this.reconciliation.reset();
  }

  private leaveOutcome(epoch: number, succeeded: boolean): LeaveOutcome {
    return this.epoch.isStale(epoch) ? "unknown" : succeeded ? "left" : "failed";
  }

  // ---- generic operation coalescing -------------------------------------

  private runOperation(
    key: string,
    kind: Operation["kind"],
    claim: () => Promise<void>,
  ): Promise<void> {
    const existing = this.operations.get(key);
    if (existing?.kind === kind) {
      return existing.promise;
    }

    const promise = existing ? existing.promise.then(claim, claim) : claim();
    const operation: Operation = { kind, promise };
    this.operations.set(key, operation);

    // `.then(cleanup, cleanup)` rather than `.finally()`: a `.finally()`
    // callback's derived promise still rejects when `promise` does, and
    // nothing else observes that derived promise — `.then` with the same
    // handler on both branches absorbs the outcome instead of re-throwing
    // it as a second, unhandled rejection.
    const cleanup = (): void => {
      if (this.operations.get(key) === operation) {
        this.operations.delete(key);
      }
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  // ---- room subscribe/unsubscribe ----------------------------------------

  private async claimRoomSubscribe(roomId: string, handlers: RoomTopicHandlers): Promise<void> {
    const epoch = this.epoch.current;
    const ticket = this.tracker.beginRoomSubscribe(roomId);
    if (ticket === undefined) {
      return this.settleIdempotentRoomClaim(roomId);
    }

    const { chat: chatTopic, participants: participantsTopic } = roomTopics(roomId);

    try {
      await this.transport.join(chatTopic, handlers.chat);
    } catch (error) {
      if (!this.epoch.isStale(epoch)) {
        this.tracker.recordChatRoomJoinFailed(roomId, ticket);
      } else {
        this.logger.debug("Room chat-topic join settled after session ended, ignoring stale ticket", {
          roomId,
        });
      }
      throw error;
    }

    try {
      await this.transport.join(participantsTopic, handlers.participants);
    } catch (participantError) {
      if (this.epoch.isStale(epoch)) {
        this.logger.debug(
          "Room participants-topic join settled after session ended, ignoring stale ticket",
          { roomId },
        );
        throw participantError;
      }

      let chatRoomLeft = false;
      let rollbackError: unknown;
      try {
        await this.transport.leave(chatTopic);
        chatRoomLeft = true;
      } catch (error) {
        rollbackError = error;
      }

      const result = this.tracker.recordRoomParticipantsJoinFailed(roomId, ticket, chatRoomLeft);
      if (result === "rollback_failed") {
        this.reconciliation.markRoomNeedsReconciliation(roomId);
        throw new AggregateError(
          [
            participantError,
            rollbackError ??
              new TransportError(`Failed to roll back chat_room join for room ${roomId}`),
          ],
          `Failed to subscribe to room ${roomId} and roll back its chat_room join`,
        );
      }
      throw participantError;
    }

    if (!this.epoch.isStale(epoch)) {
      this.tracker.recordBothRoomTopicsJoined(roomId, ticket);
    } else {
      this.logger.debug("Room subscribe settled after session ended, discarding stale success", {
        roomId,
      });
    }
  }

  /** Resolves or rejects an idempotent no-op claim (the tracker reported no new ticket to act on). */
  private settleIdempotentClaim(matched: boolean, describe: () => string): Promise<void> {
    return matched ? Promise.resolve() : Promise.reject(new RuntimeStateError(describe()));
  }

  private settleIdempotentRoomClaim(roomId: string): Promise<void> {
    const status = this.tracker.roomStatus(roomId);
    return this.settleIdempotentClaim(
      status === "subscribed",
      () => `Room ${roomId} cannot be subscribed while it is "${status}"`,
    );
  }

  private async claimRoomUnsubscribe(roomId: string): Promise<void> {
    const epoch = this.epoch.current;
    const ticket = this.tracker.unsubscribeRoom(roomId);
    if (ticket === undefined) {
      return;
    }

    const failures = await settleRoomLeaves(this.transport, roomId);
    const outcome = this.leaveOutcome(epoch, failures.length === 0);
    if (outcome === "unknown") {
      this.logger.debug("Room unsubscribe settled after session ended, outcome ambiguous", { roomId });
    }

    if (this.tracker.markRoomLeaveComplete(roomId, ticket, outcome) && outcome !== "left") {
      this.reconciliation.markRoomNeedsReconciliation(roomId);
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure): unknown => failure.reason),
        `Failed to fully unsubscribe from room ${roomId}`,
      );
    }
  }

  // ---- agent topic join/leave (agent_rooms, agent_contacts) --------------

  private async claimAgentTopicJoin(topic: string, handlers: TopicHandlers): Promise<void> {
    const epoch = this.epoch.current;
    const ticket = this.tracker.beginAgentTopicJoin(topic);
    if (ticket === undefined) {
      return this.settleIdempotentTopicClaim(topic);
    }

    let joined = false;
    let joinError: unknown;
    try {
      await this.transport.join(topic, handlers);
      joined = true;
    } catch (error) {
      joinError = error;
    }

    if (this.epoch.isStale(epoch)) {
      this.tracker.recordAgentTopicJoinAmbiguous(topic, ticket);
      this.logger.debug("Agent topic join settled after session ended, marking ambiguous for reconciliation", {
        topic,
      });
    } else {
      this.tracker.recordAgentTopicJoin(topic, ticket, joined);
    }

    if (!joined) {
      throw joinError;
    }
  }

  private settleIdempotentTopicClaim(topic: string): Promise<void> {
    const status = this.tracker.agentTopicStatus(topic);
    return this.settleIdempotentClaim(
      status === "joined",
      () => `Topic ${topic} cannot be joined while it is "${status}"`,
    );
  }

  private async claimAgentTopicLeave(topic: string): Promise<void> {
    const epoch = this.epoch.current;
    const ticket = this.tracker.leaveAgentTopic(topic);
    if (ticket === undefined) {
      return;
    }

    let left = true;
    let leaveError: unknown;
    try {
      await this.transport.leave(topic);
    } catch (error) {
      left = false;
      leaveError = error;
    }

    const outcome = this.leaveOutcome(epoch, left);
    if (outcome === "unknown") {
      this.logger.debug("Agent topic unsubscribe settled after session ended, outcome ambiguous", { topic });
    }
    if (this.tracker.markAgentTopicLeaveComplete(topic, ticket, outcome) && outcome !== "left") {
      this.reconciliation.markAgentTopicNeedsReconciliation(topic);
    }

    if (!left) {
      throw leaveError;
    }
  }
}
