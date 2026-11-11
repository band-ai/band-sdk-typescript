import { RecoverableTurnError, RuntimeStateError } from "../core/errors";
import type { Logger } from "../core/logger";
import { resolveLogger } from "../core/logger";
import type { BandLink } from "../platform/BandLink";
import { messageIdOf, type PlatformEvent } from "../platform/events";
import type { PlatformMessage } from "./types";
import type { ExecutionContext } from "./ExecutionContext";
import type { ExecutionLifecycleState } from "./lifecycle";
import {
  LifecycleTracker,
  SingleFlight,
  TerminalSignal,
  isLegalExecutionTransition,
} from "./lifecycle";
import type { RetryTracker } from "@band-ai/band-sdk-core";
import { SyncBoundaryTracker, type SyncBoundary } from "./SyncBoundaryTracker";
import { createDeferred, type Deferred } from "../core/deferred";
import { turnFailureLabel } from "../core/coercion";
import type { RoomPauseSource, TurnStopMode } from "../contracts/events";
import { DEFAULT_STOPPED_RESYNC_SECONDS } from "./types";
import { MS_PER_SECOND } from "../core/deadline";

/**
 * `holdRoomUntil` keeps the room's other work queued until a turn that
 * outlives the handler ends. `stopped` aborts, with a {@link TurnStopMode} as
 * its reason, when a pause or an interrupt cuts the turn short; the handler
 * stops waiting on the turn then.
 */
export type ExecutionHandler = (
  context: ExecutionContext,
  event: PlatformEvent,
  admitted: () => boolean,
  holdRoomUntil: (ended: Promise<void>) => void,
  stopped: AbortSignal,
) => Promise<void>;

interface ExecutionOptions {
  roomId: string;
  link: BandLink;
  context: ExecutionContext;
  onExecute: ExecutionHandler;
  /** Whether a message answers what a held turn waits on, so it runs during the hold. */
  isControlEvent?: (event: PlatformEvent) => boolean;
  onFailure?: (error: unknown, event: PlatformEvent) => void | Promise<void>;
  /** Sources already pausing the room, so a new execution starts paused and skips its catch-up. */
  pausedBy?: Iterable<RoomPauseSource>;
  /** Band serves this stopped room again: its play was missed, so the owner of the pause should lift Band's. */
  onMissedPlay?: () => void;
  /** How often a room Band stopped checks whether Band serves it again. */
  stoppedProbeIntervalMs?: number;
  logger?: Logger;
}

interface QueuedEvent {
  event: PlatformEvent;
  syncBoundary: SyncBoundary | null;
  /** Classified once, when a hold first sees it, so an ask made later can't claim it. */
  control?: boolean;
  /** A bootstrap message's caller, told once it ran, or why it never will. */
  bootstrap?: Deferred<Error | null>;
  /** A reconnect's catch-up, deferred until the hold ends. */
  afterHold?: boolean;
}

/** Queued when a room resumes, to catch up on what Band kept for it as a reconnect would. */
const CATCH_UP_EVENT: PlatformEvent = { type: "reconnected", roomId: null, payload: {} };

function toMessageEvent(message: PlatformMessage): PlatformEvent {
  const insertedAt = message.createdAt.toISOString();

  return {
    type: "message_created",
    roomId: message.roomId,
    payload: {
      id: message.id,
      content: message.content,
      sender_id: message.senderId,
      sender_type: message.senderType,
      sender_name: message.senderName ?? null,
      message_type: message.messageType,
      metadata: message.metadata,
      inserted_at: insertedAt,
      updated_at: insertedAt,
    },
  };
}

export class Execution {
  private readonly roomId: string;
  private readonly link: BandLink;
  private readonly context: ExecutionContext;
  private readonly retryTracker: RetryTracker;
  private readonly onExecute: ExecutionHandler;
  private readonly isControlEvent: (event: PlatformEvent) => boolean;
  private readonly onFailure?: (error: unknown, event: PlatformEvent) => void | Promise<void>;
  private readonly onMissedPlay?: () => void;
  private readonly stoppedProbeIntervalMs: number;
  /** While Band has the room stopped, schedules the next check for a missed play. */
  private stoppedProbe: ReturnType<typeof setTimeout> | null = null;
  private readonly logger: Logger;
  private readonly eventQueue: QueuedEvent[] = [];
  private readonly arrivals: Array<() => void> = [];
  private readonly idleWaiters = new Set<() => void>();
  private readonly stoppedSignal = new TerminalSignal();
  private readonly lifecycle: LifecycleTracker<ExecutionLifecycleState>;
  private readonly processTask: Promise<void>;
  private readonly stopGate = new SingleFlight<boolean>();
  private readonly syncBoundaries = new SyncBoundaryTracker();
  private inFlight = 0;
  /** While set, a turn that outlived its handler still runs: only its decision replies run. */
  private hold: Promise<void> | null = null;
  /** While any source holds the room, no turn starts; Band keeps its messages until the room resumes. */
  private readonly pausedBy: Set<RoomPauseSource>;
  /** Aborts the turn running now, if any, to stop or interrupt it. */
  private runningTurn: AbortController | null = null;
  /**
   * Set once the queue stops accepting new events, ahead of the lifecycle
   * itself reporting `"stopped"` (see {@link runStop}) — closing the queue
   * cannot wait on the drain it is closing for.
   */
  private closed = false;

  public constructor(options: ExecutionOptions) {
    this.roomId = options.roomId;
    this.link = options.link;
    this.context = options.context;
    this.retryTracker = this.context.getRetryTracker();
    this.onExecute = options.onExecute;
    this.isControlEvent = options.isControlEvent ?? (() => false);
    this.onFailure = options.onFailure;
    this.logger = resolveLogger(options.logger);
    this.pausedBy = new Set(options.pausedBy);
    this.onMissedPlay = options.onMissedPlay;
    this.stoppedProbeIntervalMs = options.stoppedProbeIntervalMs ?? DEFAULT_STOPPED_RESYNC_SECONDS * MS_PER_SECOND;
    this.lifecycle = new LifecycleTracker<ExecutionLifecycleState>({ status: "running" }, {
      owner: "Execution",
      logContext: { roomId: this.roomId },
      logger: this.logger,
      isLegalTransition: isLegalExecutionTransition,
      onTransition: (state) => {
        if (state.status === "stopped") {
          this.stoppedSignal.settle(null);
        } else if (state.status === "failed") {
          this.stoppedSignal.settle(state.error);
        }
      },
    });
    this.processTask = this.runProcessLoop();
    if (this.pausedBy.has("band")) this.scheduleStoppedProbe();
    // A non-graceful stop deliberately detaches the loop, so keep its outcome
    // observed here; real callers still see it via waitUntilStopped()/stop().
    void this.processTask.catch(() => undefined);
  }

  /**
   * Whether this `Execution` is still alive, and if not, why it ended.
   *
   * This is the *lifecycle* axis. For "is this turn's handler currently
   * executing" read `ExecutionContext.state` instead, which reports
   * `"starting" | "idle" | "processing"` for the room's context.
   *
   * @see ExecutionContext.state
   */
  public get state(): ExecutionLifecycleState {
    return this.lifecycle.state;
  }

  public async enqueue(event: PlatformEvent): Promise<void> {
    if (event.type === "message_created" && this.isPaused()) {
      // Left on Band, which serves it again once the room resumes.
      this.logger.debug("paused room leaves a live message for later", { roomId: this.roomId, messageId: event.payload.id });
      return;
    }
    let syncBoundary: SyncBoundary | null = null;
    if (event.type === "reconnected") {
      syncBoundary = this.syncBoundaries.beginBoundary();
    } else if (event.type === "message_created") {
      this.syncBoundaries.anchor(event.payload.id);
    }
    this.push({ event, syncBoundary });
  }

  /** Runs `message` in its place in the room's queue, like any other turn, and resolves once it ran. */
  public async bootstrapMessage(message: PlatformMessage): Promise<void> {
    const bootstrap = createDeferred<Error | null>();
    this.push({ event: toMessageEvent(message), syncBoundary: null, bootstrap });
    const dropped = await bootstrap.promise;
    if (dropped) throw dropped;
  }

  /**
   * Pauses the room for `source`. The first source to pause it stops the
   * running turn, whose message Band serves again once the room resumes.
   * Returns whether `source` was not already pausing it.
   */
  public pause(source: RoomPauseSource): boolean {
    if (this.pausedBy.has(source)) {
      return false;
    }
    this.pausedBy.add(source);
    if (source === "band") this.scheduleStoppedProbe();
    const stoppedTurn = this.pausedBy.size === 1 && this.stopRunningTurn("stop");
    this.logger.info("room paused", { roomId: this.roomId, source, stoppedTurn });
    this.notifyIfIdle();
    return true;
  }

  /**
   * Lifts `source`'s pause. Once no source pauses the room it catches up on
   * what Band kept for it, the stopped turn's message first. Returns whether
   * `source` was pausing the room.
   */
  public resume(source: RoomPauseSource): boolean {
    if (!this.pausedBy.delete(source)) {
      return false;
    }
    if (source === "band") this.clearStoppedProbe();
    this.logger.info("room resumed", { roomId: this.roomId, source, stillPausedBy: [...this.pausedBy] });
    if (!this.isPaused() && this.isActive()) {
      // After any hold: a stopped turn the adapter could not cancel may still be running.
      this.push({ event: CATCH_UP_EVENT, syncBoundary: this.syncBoundaries.beginBoundary(), afterHold: true });
    }
    return true;
  }

  /** Ends the running turn and consumes its message; false when no turn is running. */
  public interrupt(): boolean {
    return this.stopRunningTurn("interrupt");
  }

  public isPaused(): boolean {
    return this.pausedBy.size > 0;
  }

  /**
   * Checks for a missed play after the interval, through the queue like a
   * reconnect's catch-up; the check schedules the next one while Band still
   * has the room stopped.
   */
  private scheduleStoppedProbe(): void {
    this.clearStoppedProbe();
    if (!this.isActive()) return;
    this.stoppedProbe = setTimeout(() => {
      this.stoppedProbe = null;
      if (this.pausedBy.has("band") && this.isActive()) {
        this.push({ event: CATCH_UP_EVENT, syncBoundary: null });
      }
    }, this.stoppedProbeIntervalMs);
    this.stoppedProbe.unref?.();
  }

  private clearStoppedProbe(): void {
    if (this.stoppedProbe !== null) {
      clearTimeout(this.stoppedProbe);
      this.stoppedProbe = null;
    }
  }

  private stopRunningTurn(mode: TurnStopMode): boolean {
    const turn = this.runningTurn;
    if (!turn || turn.signal.aborted) {
      return false;
    }
    turn.abort(mode);
    return true;
  }

  /** Runs `onExecute` for one turn that a pause or interrupt can cut short; resolves how it was, if it was. */
  private async runTurn(event: PlatformEvent): Promise<TurnStopMode | null> {
    const turn = new AbortController();
    this.runningTurn = turn;
    try {
      await this.onExecute(this.context, event, () => this.isActive(), (ended) => this.holdRoomUntil(ended), turn.signal);
    } finally {
      if (this.runningTurn === turn) this.runningTurn = null;
    }
    return turn.signal.aborted ? (turn.signal.reason as TurnStopMode) : null;
  }

  private push(queued: QueuedEvent): void {
    if (this.lifecycle.is("stopped") || this.lifecycle.is("failed") || this.closed) {
      // `closed` can be true slightly ahead of `status` reaching "stopped" (see
      // runStop): the queue stops accepting before the final drain it is
      // closing for has finished, so report the status as-is rather than
      // claiming "stopped" prematurely.
      throw new RuntimeStateError(
        `Execution for room ${this.roomId} has already ended or is stopping (status: ${this.lifecycle.state.status}); enqueue() is a no-op after stop()`,
      );
    }

    this.eventQueue.push(queued);
    this.wake();
    this.logger.debug("event queued for room", {
      roomId: this.roomId,
      eventType: queued.event.type,
      messageId: messageIdOf(queued.event),
    });
  }

  /** Nothing in flight and nothing that may run now; work waiting on a hold does not count. */
  public isIdle(): boolean {
    return this.syncBoundaries.isComplete && this.inFlight === 0 && !this.eventQueue.some((queued) => this.mayRun(queued));
  }

  public async waitForIdle(timeoutMs?: number): Promise<boolean> {
    if (this.isIdle()) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const idleWaiter = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        this.idleWaiters.delete(idleWaiter);
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
        resolve(true);
      };

      this.idleWaiters.add(idleWaiter);
      if (timeoutMs === undefined) {
        return;
      }

      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        this.idleWaiters.delete(idleWaiter);
        resolve(false);
      }, timeoutMs);
    });
  }

  public async stop(timeoutMs?: number): Promise<boolean> {
    return await this.stopGate.run(() => this.runStop(timeoutMs));
  }

  private async runStop(timeoutMs?: number): Promise<boolean> {
    if (this.lifecycle.is("failed")) {
      await this.closeWorkingState();
    }
    if (this.lifecycle.is("stopped")) {
      return this.lifecycle.state.graceful;
    }

    // stop() is single-flight, so the only remaining state here is "running".
    this.lifecycle.transition({ status: "stopping" }, "stop");

    // A zero budget closes the queue now, so the loop starts no turn after this call.
    const graceful = timeoutMs === 0 ? this.isIdle() : await this.waitForIdle(timeoutMs);

    if (this.lifecycle.is("failed")) {
      await this.closeWorkingState();
    }

    // Closing the queue is independent of — and precedes — the lifecycle
    // itself reporting "stopped": enqueue() must reject from this point on
    // even though the drain below hasn't finished yet.
    this.closed = true;
    this.clearStoppedProbe();
    this.wake();

    if (graceful || timeoutMs === undefined) {
      await this.processTask;
    }
    this.dropQueued();

    // Only now — after the process loop has actually finished draining, or been
    // deliberately detached past a timeout — does external state (and
    // waitUntilStopped()) report "stopped". Transitioning before the drain
    // completes let a concurrent getOrCreateExecution() observe "stopped" while
    // this Execution was still mid-teardown.
    await this.closeWorkingState();
    this.lifecycle.transition({ status: "stopped", graceful }, graceful ? "stopped" : "stopped-forced");

    return graceful;
  }

  /**
   * Resolve once this `Execution` has reached a terminal state — including a
   * forced, non-graceful stop that detached the process loop — or reject with
   * the error that ended it.
   */
  public async waitUntilStopped(): Promise<void> {
    await this.stoppedSignal.wait();
  }

  private async runProcessLoop(): Promise<void> {
    try {
      await this.processLoop();
    } catch (error) {
      this.closed = true;
      this.clearStoppedProbe();
      this.dropQueued();
      await this.context.closeWorkingState();
      this.markFailed(error, "process-loop-failed");
      throw error;
    }
  }

  private async processLoop(): Promise<void> {
    if (this.isPaused()) {
      // Resuming catches up, the stale processing messages included: Band serves those through /next too.
      this.syncBoundaries.completeBoundary(this.syncBoundaries.initial);
    } else {
      await this.recoverStaleProcessingMessages();
      await this.synchronizeWithNext(this.syncBoundaries.initial);
    }

    while (this.isActive()) {
      const queued = await this.nextQueuedEvent();
      if (!queued) {
        return;
      }
      const { event } = queued;

      if (queued.bootstrap) {
        await this.runBootstrap(event);
        queued.bootstrap.resolve(null);
        this.notifyIfIdle();
        continue;
      }

      if (event.type === "reconnected") {
        await this.catchUp(queued);
        continue;
      }

      if (event.type === "message_created" && this.syncBoundaries.isExecuted(event.payload.id)) {
        this.logger.debug("skipping live message already executed", {
          roomId: this.roomId,
          messageId: event.payload.id,
        });
        this.notifyIfIdle();
        continue;
      }

      await this.executeEvent(event);
    }
  }

  private holdRoomUntil(ended: Promise<void>): void {
    const hold: Promise<void> = ended.then(() => {
      if (this.hold !== hold) return;
      this.hold = null;
      this.logger.debug("room released by its held turn", { roomId: this.roomId });
      this.wake();
      this.notifyIfIdle();
    });
    this.hold = hold;
    this.logger.debug("room held until its turn ends", { roomId: this.roomId });
  }

  /** Whether `queued` may run now: anything without a hold; during one, controls and live reconnects. */
  private mayRun(queued: QueuedEvent): boolean {
    if (this.isPaused()) return queued.event.type === "reconnected" && !queued.afterHold;
    if (!this.hold) return true;
    if (queued.event.type === "reconnected") return !queued.afterHold;
    if (queued.control === undefined) {
      queued.control = this.isControlEvent(queued.event);
      if (!queued.control) {
        this.logger.debug("event waits for the room's held turn", {
          roomId: this.roomId,
          eventType: queued.event.type,
          messageId: messageIdOf(queued.event),
        });
      }
    }
    return queued.control;
  }

  /**
   * A reconnect catches up on what the socket missed. During a hold the sweep
   * defers itself; a decision reply the socket missed waits on Band until the
   * held turn ends, by its ask's own expiry at the latest.
   */
  private async catchUp(queued: QueuedEvent): Promise<void> {
    if (this.isPaused()) {
      this.syncBoundaries.completeBoundary(queued.syncBoundary ?? { messageId: null });
      await this.probeForMissedPlay();
      this.notifyIfIdle();
      return;
    }
    // Busy for the whole sweep, so a stop does not count the room idle between its messages.
    this.inFlight += 1;
    try {
      await this.synchronizeWithNext(queued.syncBoundary ?? { messageId: null });
    } finally {
      this.inFlight -= 1;
      this.notifyIfIdle();
    }
  }

  /**
   * Band serves a stopped room nothing from /next, so a message there after a
   * reconnect means a play arrived while the socket was down: Band's pause is over.
   */
  private async probeForMissedPlay(): Promise<void> {
    if (!this.pausedBy.has("band")) return;
    let next: PlatformMessage | null;
    try {
      next = await this.link.getNextMessage(this.roomId);
    } catch (error: unknown) {
      this.logger.warn("Failed to probe a stopped room for a missed play", { roomId: this.roomId, error });
      if (this.stoppedProbe === null) this.scheduleStoppedProbe();
      return;
    }
    if (next && this.pausedBy.has("band")) {
      this.logger.info("stopped room is served again; its play was missed", { roomId: this.roomId, messageId: next.id });
      this.onMissedPlay?.();
    } else if (this.pausedBy.has("band") && this.stoppedProbe === null) {
      this.scheduleStoppedProbe();
    }
  }

  /** Leaves the rest of a catch-up for once the hold ends, ahead of the work waiting on it. */
  private deferCatchUp(): void {
    if (!this.eventQueue.some((entry) => entry.afterHold)) {
      this.eventQueue.unshift({ event: CATCH_UP_EVENT, syncBoundary: null, afterHold: true });
    }
  }

  /** A bootstrap message runs as backlog does: once, unless catch-up already ran it. */
  private async runBootstrap(event: PlatformEvent): Promise<void> {
    const messageId = messageIdOf(event);
    if (!messageId || this.syncBoundaries.isExecuted(messageId)) return;
    await this.runOnce(event, messageId);
  }

  /**
   * Runs a message outside its live delivery, recorded whatever the outcome
   * so the live delivery, which can land before or after a boundary is
   * anchored, and later catch-ups skip it.
   */
  private async runOnce(event: PlatformEvent, messageId: string): Promise<void> {
    // A stopped message is Band's to serve again, so it is not recorded as run.
    if ((await this.executeSyncMessage(event, messageId)) !== "stop") {
      this.syncBoundaries.recordExecuted(messageId);
    }
  }

  private async recoverStaleProcessingMessages(): Promise<void> {
    let staleMessages: PlatformMessage[];
    try {
      staleMessages = await this.link.getStaleProcessingMessages(this.roomId);
    } catch {
      this.logger.warn("Failed to fetch stale processing messages, skipping recovery", {
        roomId: this.roomId,
      });
      return;
    }

    if (staleMessages.length === 0) {
      return;
    }

    this.logger.info("Recovering stale processing messages", {
      roomId: this.roomId,
      count: staleMessages.length,
    });

    for (const message of staleMessages) {
      // A recovered turn that is handed back holds the room; the catch-up serves the rest.
      if (!this.isActive() || this.hold || this.isPaused()) {
        break;
      }

      if (this.retryTracker.isPermanentlyFailed(message.id)) {
        this.logger.warn("Skipping permanently failed stale message", {
          roomId: this.roomId,
          messageId: message.id,
        });
        continue;
      }

      await this.runOnce(toMessageEvent(message), message.id);
    }
  }

  private async synchronizeWithNext(boundary: SyncBoundary): Promise<void> {
    // A pause ends the sweep; resuming starts a new one.
    while (this.isActive() && !this.isPaused()) {
      // A message this sweep ran handed its turn back: the rest waits like any other work.
      if (this.hold) {
        this.deferCatchUp();
        break;
      }
      const nextMessage = await this.link.getNextMessage(this.roomId);
      // A forced stop can close the execution, or a pause hold the room, while the backlog read is in flight.
      if (!this.isActive() || this.isPaused()) {
        break;
      }
      this.logger.debug("Sync scan read /messages/next", {
        roomId: this.roomId,
        messageId: nextMessage?.id ?? null,
      });
      if (!nextMessage) {
        break;
      }

      // Band serves the oldest message not yet processed, a failed one
      // included. A message runs once per process, so one run here and still
      // served failed, or its processed mark did not land: settle it as
      // processed, the only mark that moves /next past it.
      const messageId = nextMessage.id;
      if (this.syncBoundaries.isExecuted(messageId)) {
        if (this.retryTracker.isPermanentlyFailed(messageId)) {
          this.logger.warn("Message still heads /next after it was given up on; ending sync", { roomId: this.roomId, messageId });
          break;
        }
        await this.giveUp(messageId);
      } else {
        await this.runOnce(toMessageEvent(nextMessage), messageId);
      }

      // Caught up to live traffic once the boundary's own message is settled.
      if (this.syncBoundaries.isSyncPoint(boundary, messageId)) {
        this.logger.debug("Sync scan reached its boundary", { roomId: this.roomId, messageId });
        break;
      }
    }

    this.syncBoundaries.completeBoundary(boundary);
    this.notifyIfIdle();
  }

  /** Runs one backlog message; resolves how a pause or interrupt cut it short, if one did. */
  private async executeSyncMessage(event: PlatformEvent, messageId: string): Promise<TurnStopMode | null> {
    if (this.retryTracker.isPermanentlyFailed(messageId) || this.retryTracker.recordAttempt(messageId)[1]) {
      this.logger.error("Message exceeded max retries during sync, giving up on it", {
        roomId: this.roomId,
        messageId,
        maxRetries: this.retryTracker.maxRetries,
      });
      await this.giveUp(messageId);
      return null;
    }

    this.inFlight += 1;
    this.context.setState("processing");

    try {
      const stopped = await this.runTurn(event);
      if (stopped === "stop") {
        // Our own pause cut it short; that is no attempt against its retries.
        this.retryTracker.discardAttempt(messageId);
      } else {
        this.retryTracker.markSuccess(messageId);
      }
      return stopped;
    } catch (error: unknown) {
      if (error instanceof RecoverableTurnError) {
        this.warnTurnFailed(error, { messageId });
        return null;
      }
      this.logger.error("Sync message execution failed", {
        roomId: this.roomId,
        messageId,
        error: turnFailureLabel(error),
      });
      return null;
    } finally {
      this.inFlight -= 1;
      this.context.setState("idle");
    }
  }

  // One turn's failure (a refused post, a provider failure, a missing reply):
  // an ordinary outcome, so a warning with no stack, but with what tells the
  // failures apart and why a post failed.
  private warnTurnFailed(error: RecoverableTurnError, context: Record<string, unknown>): void {
    this.logger.warn("Turn failed without stopping the room", {
      roomId: this.roomId,
      ...context,
      error: error.message,
      name: error.name,
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    });
  }

  private async executeEvent(event: PlatformEvent): Promise<void> {
    this.inFlight += 1;
    this.context.setState("processing");

    try {
      await this.runTurn(event);
    } catch (error: unknown) {
      // Scoped to the turn that raised it: `PlatformRuntime` has already
      // marked the message failed, and the queue below is every *other*
      // message in this room. Tearing all of that down — and, through
      // onFailure, the whole runtime — is the right answer to a broken
      // adapter and the wrong one to a single reply that would not post.
      if (error instanceof RecoverableTurnError) {
        this.warnTurnFailed(error, { eventType: event.type });
        return;
      }

      if (this.onFailure) {
        await this.onFailure(error, event);
      } else {
        this.logger.error("Execution queue task failed", {
          roomId: this.roomId,
          eventType: event.type,
          error,
        });
      }
      this.closed = true;
      await this.context.closeWorkingState();
      this.markFailed(error, "execution-failed");
      this.dropQueued();
      this.wake();
      throw error;
    } finally {
      this.inFlight -= 1;
      this.context.setState("idle");
      this.notifyIfIdle();
    }
  }

  /** The first queued event that may run, waiting through a hold for one; null once the queue closes. */
  private async nextQueuedEvent(): Promise<QueuedEvent | null> {
    for (;;) {
      if (this.closed || !this.isActive()) {
        return null;
      }
      const index = this.eventQueue.findIndex((queued) => this.mayRun(queued));
      if (index >= 0) {
        return this.eventQueue.splice(index, 1)[0];
      }
      await new Promise<void>((resolve) => {
        this.arrivals.push(resolve);
      });
    }
  }

  /** True while the process loop should keep draining (`running` or mid-`stop()`, until the queue closes). */
  private isActive(): boolean {
    const status = this.lifecycle.state.status;
    return !this.closed && (status === "running" || status === "stopping");
  }

  /** A failure path may share this close and fail first; its error, not the stop, is the outcome. */
  private async closeWorkingState(): Promise<void> {
    await this.context.closeWorkingState();
    if (this.lifecycle.is("failed")) throw this.lifecycle.state.error;
  }

  private markFailed(error: unknown, trigger: string): void {
    this.lifecycle.fail(error, trigger);
  }

  private notifyIfIdle(): void {
    if (!this.isIdle()) {
      return;
    }

    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  /** Wakes the loop to look at the queue again: an event arrived, a hold ended, or the queue closed. */
  private wake(): void {
    for (const arrival of this.arrivals.splice(0, this.arrivals.length)) {
      arrival();
    }
  }

  /** Discards what is still queued; a bootstrap caller learns its message will not run here. */
  private dropQueued(): void {
    for (const { bootstrap } of this.eventQueue.splice(0, this.eventQueue.length)) {
      bootstrap?.resolve(new RuntimeStateError(`Execution for room ${this.roomId} stopped before its bootstrap message ran`));
    }
  }

  /** Band has no give-up state: a message leaves /next only once claimed and marked processed. */
  private async giveUp(messageId: string): Promise<void> {
    this.retryTracker.markPermanentlyFailed(messageId);
    try {
      await this.link.markProcessing(this.roomId, messageId);
      await this.link.markProcessed(this.roomId, messageId);
    } catch (error: unknown) {
      this.logger.warn("Failed to settle a given-up message", { roomId: this.roomId, messageId, error });
    }
  }
}
