import type { Logger } from "../core/logger";
import { NoopLogger } from "../core/logger";
import type { ThenvoiLink } from "../platform/ThenvoiLink";
import type { PlatformEvent } from "../platform/events";
import type { PlatformMessage } from "./types";
import type { ExecutionContext } from "./ExecutionContext";
import type { MessageRetryTracker } from "./retryTracker";

export type ExecutionHandler = (
  context: ExecutionContext,
  event: PlatformEvent,
) => Promise<void>;

interface ExecutionOptions {
  roomId: string;
  link: ThenvoiLink;
  context: ExecutionContext;
  onExecute: ExecutionHandler;
  onFailure?: (error: unknown, event: PlatformEvent) => void | Promise<void>;
  logger?: Logger;
  /**
   * When true (default), the loop runs `recoverStaleProcessingMessages` +
   * `synchronizeWithNext` at startup to catch up after a crash/disconnect.
   * Set to `false` for rooms we just discovered via `autoSubscribeExistingRooms`
   * — those have no in-flight `processing` state for *this* agent yet, so the
   * 2 REST calls per room are pure waste and burn the per-agent rate limit
   * when the agent is subscribed to many rooms.
   */
  skipStartupCatchup?: boolean;
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
  private readonly link: ThenvoiLink;
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
  private processTask: Promise<void>;
  private firstWsMessageId: string | null = null;
  private syncComplete = false;
  private running = true;
  private inFlight = 0;
  private readonly skipStartupCatchup: boolean;

  public constructor(options: ExecutionOptions) {
    this.roomId = options.roomId;
    this.link = options.link;
    this.context = options.context;
    this.retryTracker = this.context.getRetryTracker();
    this.onExecute = options.onExecute;
    this.onFailure = options.onFailure;
    this.skipStartupCatchup = options.skipStartupCatchup ?? false;
    this.logger = options.logger ?? new NoopLogger();
    this.processTask = this.processLoop();
  }

  public enqueue(event: PlatformEvent): Promise<void> {
    if (event.type === "message_created" && !this.syncComplete && this.firstWsMessageId === null) {
      this.firstWsMessageId = event.payload.id;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      this.eventQueue.push(event);
    }

    return Promise.resolve();
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
    const graceful = await this.waitForIdle(timeoutMs);
    this.running = false;
    this.resolveEventWaiters(null);

    if (graceful || timeoutMs === undefined) {
      await this.processTask;
    }

    return graceful;
  }

  public async waitUntilStopped(): Promise<void> {
    await this.processTask;
  }

  private async processLoop(): Promise<void> {
    if (this.skipStartupCatchup) {
      // No prior `processing` state for *this* agent in this room (we just
      // discovered the room via auto-subscribe), so the WebSocket is
      // authoritative — skip the 2 REST polls and let the live channel push
      // events. This is what keeps an agent subscribed to N rooms from
      // firing 2N REST calls per startup and tripping the rate limiter.
      this.syncComplete = true;
      this.notifyIfIdle();
    } else {
      await this.recoverStaleProcessingMessages();
      await this.synchronizeWithNext();
    }

    while (this.running) {
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
      if (!this.running) {
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
    while (this.running) {
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
      this.running = false;
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

    if (!this.running) {
      return null;
    }

    return new Promise<PlatformEvent | null>((resolve) => {
      this.waiters.push(resolve);
    });
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
