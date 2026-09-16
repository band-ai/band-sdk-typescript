import { SubscriptionTracker } from "@band-ai/band-sdk-core";
import type { LeaveOutcome } from "@band-ai/band-sdk-core";
import { chatRoomTopic, roomParticipantsTopic } from "@band-ai/band-sdk-core";
import { RuntimeStateError, TransportError } from "../core/errors";
import type { Logger } from "../core/logger";
import { NoopLogger } from "../core/logger";
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

interface ReconnectWork {
  snapshot: ReconnectSnapshot;
  epoch: number;
  roomCandidates: Array<[string, bigint]>;
  agentTopicCandidates: Array<[string, bigint]>;
}

function roomOperationKey(roomId: string): string {
  return `room:${roomId}`;
}

function topicOperationKey(topic: string): string {
  return `topic:${topic}`;
}

function roomTopics(roomId: string): { chat: string; participants: string } {
  return { chat: chatRoomTopic(roomId), participants: roomParticipantsTopic(roomId) };
}

function isRejected(
  result: PromiseSettledResult<unknown>,
): result is PromiseRejectedResult {
  return result.status === "rejected";
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
  private readonly roomsNeedingReconciliation = new Set<string>();
  private readonly agentTopicsNeedingReconciliation = new Set<string>();
  private reconcileTail: Promise<void> = Promise.resolve();
  private lastReconciledGeneration = 0;
  private sessionEpoch = 0;

  public constructor(options: { transport: StreamingTransport; logger?: Logger }) {
    this.transport = options.transport;
    this.logger = options.logger ?? new NoopLogger();
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
    if (snapshot.generation <= this.lastReconciledGeneration) {
      this.logger.debug("Ignoring stale or duplicate reconnect snapshot", {
        generation: snapshot.generation,
        lastReconciledGeneration: this.lastReconciledGeneration,
      });
      return Promise.resolve();
    }
    this.lastReconciledGeneration = snapshot.generation;

    const epoch = this.sessionEpoch;
    this.tracker.onReconnected();
    const work: ReconnectWork = {
      snapshot,
      epoch,
      roomCandidates: this.tracker.roomRejoinCandidates(),
      agentTopicCandidates: this.tracker.agentTopicRejoinCandidates(),
    };
    this.reconcileTail = this.reconcileTail.then(
      () => this.runReconcile(work),
      () => this.runReconcile(work),
    );
    return this.reconcileTail;
  }

  /**
   * Ends this session: every ticket issued so far goes stale, every in-flight
   * operation's late completion becomes a no-op, and both reconciliation sets
   * start empty for the next session. The epoch guards host-side async work
   * and transport effects that can outlive the core session they started in.
   */
  public endSession(): void {
    this.sessionEpoch += 1;
    this.tracker.endSession();
    this.operations.clear();
    this.roomsNeedingReconciliation.clear();
    this.agentTopicsNeedingReconciliation.clear();
    this.lastReconciledGeneration = 0;
  }

  private leaveOutcome(epoch: number, succeeded: boolean): LeaveOutcome {
    return epoch !== this.sessionEpoch ? "unknown" : succeeded ? "left" : "failed";
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
    const epoch = this.sessionEpoch;
    const ticket = this.tracker.beginRoomSubscribe(roomId);
    if (ticket === undefined) {
      return this.settleIdempotentRoomClaim(roomId);
    }

    const { chat: chatTopic, participants: participantsTopic } = roomTopics(roomId);

    try {
      await this.transport.join(chatTopic, handlers.chat);
    } catch (error) {
      if (epoch === this.sessionEpoch) {
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
      if (epoch !== this.sessionEpoch) {
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
        this.roomsNeedingReconciliation.add(roomId);
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

    if (epoch === this.sessionEpoch) {
      this.tracker.recordBothRoomTopicsJoined(roomId, ticket);
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

  /** Leaves both of a room's topics and returns whichever leave calls rejected. */
  private async settleRoomLeaves(roomId: string): Promise<PromiseRejectedResult[]> {
    const { chat: chatTopic, participants: participantsTopic } = roomTopics(roomId);
    const results = await Promise.allSettled([
      this.transport.leave(chatTopic),
      this.transport.leave(participantsTopic),
    ]);
    return results.filter(isRejected);
  }

  private async claimRoomUnsubscribe(roomId: string): Promise<void> {
    const epoch = this.sessionEpoch;
    const ticket = this.tracker.unsubscribeRoom(roomId);
    if (ticket === undefined) {
      return;
    }

    const failures = await this.settleRoomLeaves(roomId);
    const outcome = this.leaveOutcome(epoch, failures.length === 0);
    if (outcome === "unknown") {
      this.logger.debug("Room unsubscribe settled after session ended, outcome ambiguous", { roomId });
    }

    if (this.tracker.markRoomLeaveComplete(roomId, ticket, outcome) && outcome !== "left") {
      this.roomsNeedingReconciliation.add(roomId);
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
    const epoch = this.sessionEpoch;
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

    if (epoch !== this.sessionEpoch) {
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
    const epoch = this.sessionEpoch;
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
      this.agentTopicsNeedingReconciliation.add(topic);
    }

    if (!left) {
      throw leaveError;
    }
  }

  // ---- reconnect reconciliation -------------------------------------------

  private async runReconcile(work: ReconnectWork): Promise<void> {
    const { snapshot, epoch, roomCandidates, agentTopicCandidates } = work;
    if (epoch !== this.sessionEpoch) {
      this.logger.debug("Reconnect reconciliation settled after session ended, skipping rejoin evaluation", {
        generation: snapshot.generation,
      });
      return;
    }

    for (const [roomId, ticket] of roomCandidates) {
      const { chat: chatTopic, participants: participantsTopic } = roomTopics(roomId);
      if (
        !snapshot.attemptedTopics.has(chatTopic) ||
        !snapshot.attemptedTopics.has(participantsTopic)
      ) {
        continue;
      }
      const present =
        snapshot.joinedTopics.has(chatTopic) &&
        snapshot.joinedTopics.has(participantsTopic);
      if (present) {
        continue;
      }
      if (this.tracker.markRoomRejoinFailed(roomId, ticket)) {
        this.roomsNeedingReconciliation.add(roomId);
      }
    }

    for (const [topic, ticket] of agentTopicCandidates) {
      if (!snapshot.attemptedTopics.has(topic)) {
        continue;
      }
      if (snapshot.joinedTopics.has(topic)) {
        continue;
      }
      if (this.tracker.markAgentTopicRejoinFailed(topic, ticket)) {
        this.agentTopicsNeedingReconciliation.add(topic);
      }
    }

    if (epoch !== this.sessionEpoch) {
      this.logger.debug("Reconnect reconciliation settled after session ended, skipping cleanup drain", {
        generation: snapshot.generation,
      });
      return;
    }

    await this.drainReconciliation(epoch);
  }

  private async drainReconciliation(epoch: number): Promise<void> {
    const rooms = [...this.roomsNeedingReconciliation];
    const topics = [...this.agentTopicsNeedingReconciliation];
    // Disjoint key spaces (room ids vs. topic names) with no shared state
    // between them, so both cleanup sweeps run concurrently.
    const [roomLeaveResults, topicLeaveResults] = await Promise.all([
      Promise.allSettled(rooms.map((roomId) => this.leaveRoomTopicsCleanly(roomId))),
      Promise.allSettled(topics.map((topic) => this.transport.leave(topic))),
    ]);

    if (epoch !== this.sessionEpoch) {
      // The session ended mid-cleanup; a new session starts with empty
      // reconciliation sets, so leave the stale tracker acknowledgements
      // undone rather than resolve them against an ended session.
      this.logger.debug("Reconnect reconciliation cleanup settled after session ended, leaving tracker acknowledgements pending for next reconnect", {
        rooms: rooms.length,
        topics: topics.length,
      });
      return;
    }

    this.acknowledgeCleanup({
      ids: rooms,
      results: roomLeaveResults,
      pending: this.roomsNeedingReconciliation,
      acknowledge: (roomId) => this.tracker.acknowledgeRoomReconciled(roomId),
      failureMessage: "Room reconciliation cleanup failed, retrying on next reconnect",
      logContext: (roomId) => ({ roomId }),
    });

    this.acknowledgeCleanup({
      ids: topics,
      results: topicLeaveResults,
      pending: this.agentTopicsNeedingReconciliation,
      acknowledge: (topic) => this.tracker.acknowledgeAgentTopicReconciled(topic),
      failureMessage: "Agent topic reconciliation cleanup failed, retrying on next reconnect",
      logContext: (topic) => ({ topic }),
    });
  }

  private acknowledgeCleanup(options: {
    ids: string[];
    results: PromiseSettledResult<void>[];
    pending: Set<string>;
    acknowledge: (id: string) => boolean;
    failureMessage: string;
    logContext: (id: string) => Record<string, unknown>;
  }): void {
    options.ids.forEach((id, index) => {
      if (options.results[index]?.status !== "fulfilled") {
        this.logger.warn(options.failureMessage, options.logContext(id));
        return;
      }
      if (options.acknowledge(id)) {
        options.pending.delete(id);
      }
    });
  }

  private async leaveRoomTopicsCleanly(roomId: string): Promise<void> {
    const failures = await this.settleRoomLeaves(roomId);
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure): unknown => failure.reason),
        `Failed to clean up room ${roomId} during reconnect reconciliation`,
      );
    }
  }
}
