import { RuntimeStateError } from "../core/errors";
import type { Logger } from "../core/logger";
import { NoopLogger } from "../core/logger";
import type { BandLink } from "../platform/BandLink";
import type { PlatformEvent } from "../platform/events";
import type { PlatformMessage } from "./types";
import type { ExecutionContext } from "./ExecutionContext";
import type { ExecutionLifecycleState } from "./lifecycle";
import {
  LifecycleTracker,
  SingleFlight,
  TerminalSignal,
  isLegalExecutionTransition,
  toLifecycleError,
} from "./lifecycle";
import type { MessageRetryTracker } from "./retryTracker";

export type ExecutionHandler = (
  context: ExecutionContext,
  event: PlatformEvent,
) => Promise<void>;

interface ExecutionOptions {
  roomId: string;
  link: BandLink;
  context: ExecutionContext;
  onExecute: ExecutionHandler;
  onFailure?: (error: unknown, event: PlatformEvent) => void | Promise<void>;
  logger?: Logger;
}

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
  private readonly retryTracker: MessageRetryTracker;
  private readonly onExecute: ExecutionHandler;
  private readonly onFailure?: (error: unknown, event: PlatformEvent) => void | Promise<void>;
  private readonly logger: Logger;
  private readonly eventQueue: PlatformEvent[] = [];
  private readonly waiters: Array<(event: PlatformEvent | null) => void> = [];
  private readonly idleWaiters = new Set<() => void>();
  private readonly drainedWsMessageIds = new Set<string>();
  private readonly syncProcessedIds = new Set<string>();
  private readonly stoppedSignal = new TerminalSignal();
  private readonly lifecycle: LifecycleTracker<ExecutionLifecycleState>;
  private readonly processTask: Promise<void>;
  private readonly stopGate = new SingleFlight<boolean>();
  private firstWsMessageId: string | null = null;
  private syncComplete = false;
  private inFlight = 0;
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
    this.onFailure = options.onFailure;
    this.logger = options.logger ?? new NoopLogger();
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
    const status = this.lifecycle.state.status;
    if (status === "stopped" || status === "failed" || this.closed) {
      // `closed` can be true slightly ahead of `status` reaching "stopped" (see
      // runStop): the queue stops accepting before the final drain it is
      // closing for has finished, so report the status as-is rather than
      // claiming "stopped" prematurely.
      throw new RuntimeStateError(
        `Execution for room ${this.roomId} has already ended or is stopping (status: ${status}); enqueue() is a no-op after stop()`,
      );
    }

    if (event.type === "message_created" && !this.syncComplete && this.firstWsMessageId === null) {
      this.firstWsMessageId = event.payload.id;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      this.eventQueue.push(event);
    }
  }

  public async bootstrapMessage(message: PlatformMessage): Promise<void> {
    // Record the ID before executing so that the concurrent synchronizeWithNext()
    // loop (started in the constructor) will skip this message if it encounters
    // it in the REST queue, preventing duplicate processing.
    this.syncProcessedIds.add(message.id);
    await this.executeSyncMessage(toMessageEvent(message), message.id);
  }

  public isIdle(): boolean {
    return this.syncComplete && this.inFlight === 0 && this.eventQueue.length === 0;
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
    const initial = this.lifecycle.state;
    if (initial.status === "failed") {
      throw initial.error;
    }
    if (initial.status === "stopped") {
      return initial.graceful;
    }

    // stop() is single-flight, so the only remaining state here is "running".
    this.lifecycle.transition({ status: "stopping" }, "stop");

    const graceful = await this.waitForIdle(timeoutMs);

    const drained = this.lifecycle.state;
    if (drained.status === "failed") {
      throw drained.error;
    }

    // Closing the queue is independent of — and precedes — the lifecycle
    // itself reporting "stopped": enqueue() must reject from this point on
    // even though the drain below hasn't finished yet.
    this.closed = true;
    this.resolveEventWaiters(null);

    if (graceful || timeoutMs === undefined) {
      await this.processTask;
    }

    // Only now — after the process loop has actually finished draining, or been
    // deliberately detached past a timeout — does external state (and
    // waitUntilStopped()) report "stopped". Transitioning before the drain
    // completes let a concurrent getOrCreateExecution() observe "stopped" while
    // this Execution was still mid-teardown.
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
      this.markFailed(error, "process-loop-failed");
      throw error;
    }
  }

  private async processLoop(): Promise<void> {
    await this.recoverStaleProcessingMessages();
    await this.synchronizeWithNext();

    while (this.isActive()) {
      const event = await this.nextQueuedEvent();
      if (!event) {
        return;
      }

      if (event.type === "message_created" && this.drainedWsMessageIds.has(event.payload.id)) {
        this.drainedWsMessageIds.delete(event.payload.id);
        this.notifyIfIdle();
        continue;
      }

      await this.executeEvent(event);
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
      if (!this.isActive()) {
        break;
      }

      if (this.retryTracker.isPermanentlyFailed(message.id)) {
        this.logger.warn("Skipping permanently failed stale message", {
          roomId: this.roomId,
          messageId: message.id,
        });
        continue;
      }

      await this.executeSyncMessage(toMessageEvent(message), message.id);
      this.syncProcessedIds.add(message.id);
    }
  }

  private async synchronizeWithNext(): Promise<void> {
    while (this.isActive()) {
      const nextMessage = await this.link.getNextMessage(this.roomId);
      if (!nextMessage) {
        break;
      }

      if (this.syncProcessedIds.has(nextMessage.id)) {
        const isSyncPoint = this.firstWsMessageId !== null && nextMessage.id === this.firstWsMessageId;
        if (isSyncPoint) {
          this.drainedWsMessageIds.add(nextMessage.id);
          this.firstWsMessageId = null;
          break;
        }
        continue;
      }

      if (this.retryTracker.isPermanentlyFailed(nextMessage.id)) {
        this.logger.warn("Skipping permanently failed message during sync", {
          roomId: this.roomId,
          messageId: nextMessage.id,
        });
        await this.markMessageFailed(nextMessage.id, "Message permanently failed after max retries");
        const isSyncPoint = this.firstWsMessageId !== null && nextMessage.id === this.firstWsMessageId;
        if (isSyncPoint) {
          this.drainedWsMessageIds.add(nextMessage.id);
          this.firstWsMessageId = null;
          break;
        }
        continue;
      }

      const isSyncPoint = this.firstWsMessageId !== null && nextMessage.id === this.firstWsMessageId;
      await this.executeSyncMessage(toMessageEvent(nextMessage), nextMessage.id);
      this.syncProcessedIds.add(nextMessage.id);

      if (isSyncPoint) {
        this.drainedWsMessageIds.add(nextMessage.id);
        this.firstWsMessageId = null;
        break;
      }
    }

    this.syncProcessedIds.clear();
    this.syncComplete = true;
    this.notifyIfIdle();
  }

  private async executeSyncMessage(event: PlatformEvent, messageId: string): Promise<void> {
    const [, exceeded] = this.retryTracker.recordAttempt(messageId);
    if (exceeded) {
      this.logger.error("Message exceeded max retries during sync, marking permanently failed", {
        roomId: this.roomId,
        messageId,
        maxRetries: this.retryTracker.maxRetries,
      });
      await this.markMessageFailed(messageId, "Message permanently failed after max retries");
      return;
    }

    this.inFlight += 1;
    this.context.setState("processing");

    try {
      await this.onExecute(this.context, event);
      this.retryTracker.markSuccess(messageId);
    } catch (error: unknown) {
      const label = error instanceof Error ? error.message : String(error);
      this.logger.error("Sync message execution failed", {
        roomId: this.roomId,
        messageId,
        error: label,
      });
    } finally {
      this.inFlight -= 1;
      this.context.setState("idle");
    }
  }

  private async executeEvent(event: PlatformEvent): Promise<void> {
    this.inFlight += 1;
    this.context.setState("processing");

    try {
      await this.onExecute(this.context, event);
    } catch (error: unknown) {
      if (this.onFailure) {
        await this.onFailure(error, event);
      } else {
        this.logger.error("Execution queue task failed", {
          roomId: this.roomId,
          eventType: event.type,
          error,
        });
      }
      this.markFailed(error, "execution-failed");
      this.eventQueue.splice(0, this.eventQueue.length);
      this.resolveEventWaiters(null);
      throw error;
    } finally {
      this.inFlight -= 1;
      this.context.setState("idle");
      this.notifyIfIdle();
    }
  }

  private async nextQueuedEvent(): Promise<PlatformEvent | null> {
    const queued = this.eventQueue.shift();
    if (queued) {
      return queued;
    }

    if (!this.isActive()) {
      return null;
    }

    return new Promise<PlatformEvent | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** True while the process loop should keep draining (`running` or mid-`stop()`). */
  private isActive(): boolean {
    const status = this.lifecycle.state.status;
    return status === "running" || status === "stopping";
  }

  private markFailed(error: unknown, trigger: string): void {
    const status = this.lifecycle.state.status;
    if (status === "stopped" || status === "failed") {
      return;
    }

    this.lifecycle.transition({ status: "failed", error: toLifecycleError(error) }, trigger);
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

  private resolveEventWaiters(event: PlatformEvent | null): void {
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiters) {
      waiter(event);
    }
  }

  private async markMessageFailed(messageId: string, error: string): Promise<void> {
    try {
      await this.link.markFailed(this.roomId, messageId, error, { bestEffort: true });
    } catch {
      this.logger.warn("Failed to mark message as failed on server", {
        roomId: this.roomId,
        messageId,
      });
    }
  }
}
