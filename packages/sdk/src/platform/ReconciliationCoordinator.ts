import type { SubscriptionTracker } from "@band-ai/band-sdk-core";
import type { Logger } from "../core/logger";
import { Serializer } from "../core/singleFlight";
import type { Epoch } from "../core/epoch";
import type { ReconnectSnapshot, StreamingTransport } from "./streaming/transport";
import { roomTopics, settleRoomLeaves } from "./roomTopics";

interface ReconnectWork {
  snapshot: ReconnectSnapshot;
  epoch: number;
  roomCandidates: Array<[string, bigint]>;
  agentTopicCandidates: Array<[string, bigint]>;
}

/**
 * Owns the set of rooms/topics a reconnect (or a failed direct operation)
 * has left in a possibly-inconsistent state, and drains them: evaluating
 * which of the tracker's rejoin candidates actually came back per the
 * reconnect snapshot, then cleanly leaving whatever didn't. Reconciliations
 * are serialized — each reconnect generation's sweep completes before the
 * next begins — since they mutate the same pending sets and tracker.
 */
export class ReconciliationCoordinator {
  private readonly roomsNeedingReconciliation = new Set<string>();
  private readonly agentTopicsNeedingReconciliation = new Set<string>();
  private readonly reconcileTail = new Serializer();
  private lastReconciledGeneration = 0;

  public constructor(
    private readonly tracker: SubscriptionTracker,
    private readonly transport: StreamingTransport,
    private readonly logger: Logger,
    private readonly epoch: Epoch,
  ) {}

  public markRoomNeedsReconciliation(roomId: string): void {
    this.roomsNeedingReconciliation.add(roomId);
  }

  public markAgentTopicNeedsReconciliation(topic: string): void {
    this.agentTopicsNeedingReconciliation.add(topic);
  }

  /** Called on session end: every pending sweep is moot against a tracker that has itself just been reset. */
  public reset(): void {
    this.roomsNeedingReconciliation.clear();
    this.agentTopicsNeedingReconciliation.clear();
    this.lastReconciledGeneration = 0;
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

    const epoch = this.epoch.current;
    this.tracker.onReconnected();
    const work: ReconnectWork = {
      snapshot,
      epoch,
      roomCandidates: this.tracker.roomRejoinCandidates(),
      agentTopicCandidates: this.tracker.agentTopicRejoinCandidates(),
    };
    return this.reconcileTail.run(() => this.runReconcile(work));
  }

  private async runReconcile(work: ReconnectWork): Promise<void> {
    const { snapshot, epoch, roomCandidates, agentTopicCandidates } = work;
    if (this.epoch.isStale(epoch)) {
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
        this.markRoomNeedsReconciliation(roomId);
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
        this.markAgentTopicNeedsReconciliation(topic);
      }
    }

    if (this.epoch.isStale(epoch)) {
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

    if (this.epoch.isStale(epoch)) {
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
    const failures = await settleRoomLeaves(this.transport, roomId);
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure): unknown => failure.reason),
        `Failed to clean up room ${roomId} during reconnect reconciliation`,
      );
    }
  }
}
