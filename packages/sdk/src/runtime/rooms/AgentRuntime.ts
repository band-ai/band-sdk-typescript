import type { ThenvoiLink } from "../../platform/ThenvoiLink";
import type { ContactEvent, PlatformEvent } from "../../platform/events";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import type { MetadataMap, ParticipantRecord } from "../../contracts/dtos";
import { Execution } from "../Execution";
import { ExecutionContext, type ExecutionContextOptions } from "../ExecutionContext";
import { hydrateTrackedRooms, trackRoomJoin, trackRoomLeave } from "./subscriptions";
import type { AgentConfig, SessionConfig } from "../types";
import type { PlatformMessage } from "../types";

interface AgentRuntimeOptions {
  link: ThenvoiLink;
  agentId: string;
  onExecute: (context: ExecutionContext, event: PlatformEvent) => Promise<void>;
  onSessionCleanup?: (roomId: string) => Promise<void>;
  onRoomJoined?: (roomId: string, payload: MetadataMap) => Promise<void> | void;
  onRoomLeft?: (roomId: string) => Promise<void> | void;
  onContactEvent?: (event: ContactEvent) => Promise<void>;
  onParticipantAdded?: (roomId: string, participant: ParticipantRecord) => Promise<void> | void;
  onParticipantRemoved?: (roomId: string, participantId: string) => Promise<void> | void;
  onError?: (error: unknown, event: PlatformEvent) => void;
  roomFilter?: (room: MetadataMap) => boolean;
  contextFactory?: (roomId: string, defaults: ExecutionContextOptions) => ExecutionContext;
  sessionConfig?: SessionConfig;
  agentConfig?: AgentConfig;
  logger?: Logger;
}

export class AgentRuntime {
  private readonly link: ThenvoiLink;
  private readonly agentId: string;
  private readonly onExecute: (context: ExecutionContext, event: PlatformEvent) => Promise<void>;
  private readonly onSessionCleanup: (roomId: string) => Promise<void>;
  private readonly onRoomJoined?: (roomId: string, payload: MetadataMap) => Promise<void> | void;
  private readonly onRoomLeft?: (roomId: string) => Promise<void> | void;
  private readonly onContactEvent?: (event: ContactEvent) => Promise<void>;
  private readonly onParticipantAdded?: (roomId: string, participant: ParticipantRecord) => Promise<void> | void;
  private readonly onParticipantRemoved?: (roomId: string, participantId: string) => Promise<void> | void;
  private readonly onError?: (error: unknown, event: PlatformEvent) => void;
  private readonly roomFilter?: (room: MetadataMap) => boolean;
  private readonly contextFactory?: (roomId: string, defaults: ExecutionContextOptions) => ExecutionContext;
  private readonly sessionConfig: Required<SessionConfig>;
  private readonly autoSubscribeExistingRooms: boolean;
  private readonly subscribedRooms = new Set<string>();
  private readonly contexts = new Map<string, ExecutionContext>();
  private readonly executions = new Map<string, Execution>();
  private readonly executionWatchers = new Map<string, Promise<void>>();
  private readonly logger: Logger;
  private running = false;
  private stopping = false;
  private stopController = new AbortController();
  private consumeTask: Promise<void> | null = null;
  private fatalError: unknown = null;

  public constructor(options: AgentRuntimeOptions) {
    this.link = options.link;
    this.agentId = options.agentId;
    this.onExecute = options.onExecute;
    this.onSessionCleanup = options.onSessionCleanup ?? (async () => undefined);
    this.onRoomJoined = options.onRoomJoined;
    this.onRoomLeft = options.onRoomLeft;
    this.onError = options.onError;
    this.logger = options.logger ?? new NoopLogger();
    this.onContactEvent = options.onContactEvent;
    this.onParticipantAdded = options.onParticipantAdded;
    this.onParticipantRemoved = options.onParticipantRemoved;
    this.roomFilter = options.roomFilter;
    this.contextFactory = options.contextFactory;
    this.sessionConfig = {
      enableContextCache: options.sessionConfig?.enableContextCache ?? true,
      contextCacheTtlSeconds: options.sessionConfig?.contextCacheTtlSeconds ?? 300,
      maxContextMessages: options.sessionConfig?.maxContextMessages ?? 100,
      maxMessageRetries: options.sessionConfig?.maxMessageRetries ?? 1,
      enableContextHydration: options.sessionConfig?.enableContextHydration ?? true,
    };
    this.autoSubscribeExistingRooms = options.agentConfig?.autoSubscribeExistingRooms ?? false;
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.stopping = false;
    this.fatalError = null;
    if (!this.stopController.signal.aborted) {
      this.stopController.abort();
    }
    this.stopController = new AbortController();

    try {
      await this.link.connect();
    } catch (error) {
      await this.handleStartFailure();
      throw error;
    }

    try {
      await this.link.subscribeAgentRooms();
    } catch {
      this.logger.warn("AgentRuntime failed to subscribe agent_rooms channel, continuing without it");
    }

    try {
      await this.subscribeExistingRooms();
    } catch (error) {
      await this.handleStartFailure();
      throw error;
    }

    this.consumeTask = this.consumeLoop(this.stopController.signal);

    if (!this.link.capabilities.contacts) {
      return;
    }

    try {
      await this.link.subscribeAgentContacts();
    } catch {
      this.logger.warn("AgentRuntime failed to subscribe agent_contacts channel, continuing without it");
    }
  }

  private async handleStartFailure(): Promise<void> {
    this.running = false;
    this.stopping = false;
    this.stopController.abort();
    if (this.consumeTask) {
      await this.consumeTask;
      this.consumeTask = null;
    }
    await this.link.disconnect();
  }

  public async stop(timeoutMs?: number): Promise<boolean> {
    if (!this.running || this.stopping) {
      return true;
    }

    this.stopping = true;
    this.running = false;
    this.stopController.abort();
    if (this.consumeTask) {
      await this.consumeTask;
      this.consumeTask = null;
    }

    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    let graceful = true;

    for (const execution of this.executions.values()) {
      const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
      const stopped = await execution.stop(remaining);
      if (!stopped) {
        graceful = false;
      }
    }

    for (const roomId of [...this.subscribedRooms]) {
      await this.leaveTrackedRoom(roomId);
    }

    for (const roomId of [...this.contexts.keys()]) {
      await this.onSessionCleanup(roomId);
    }

    this.subscribedRooms.clear();
    this.contexts.clear();
    this.executions.clear();
    this.executionWatchers.clear();

    if (this.link.capabilities.contacts) {
      await this.link.unsubscribeAgentContacts();
    }

    await this.link.disconnect();
    if (this.fatalError) {
      throw this.fatalError instanceof Error ? this.fatalError : new Error(String(this.fatalError));
    }
    return graceful;
  }

  public getContext(roomId: string): ExecutionContext | undefined {
    return this.contexts.get(roomId);
  }

  public async waitUntilStopped(): Promise<void> {
    if (this.consumeTask) {
      await this.consumeTask;
    } else {
      await this.link.runForever(this.stopController.signal);
    }

    if (this.fatalError) {
      throw this.fatalError instanceof Error ? this.fatalError : new Error(String(this.fatalError));
    }
  }

  public getContexts(): ExecutionContext[] {
    return [...this.contexts.values()];
  }

  private async consumeLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const event = await this.link.nextEvent(signal);
      if (!event) {
        return;
      }
      try {
        await this.handleEvent(event);
      } catch (error: unknown) {
        await this.failRuntime(error, event);
        return;
      }
    }
  }

  private async handleEvent(event: PlatformEvent): Promise<void> {
    switch (event.type) {
      case "room_added":
        await trackRoomJoin({
          link: this.link,
          roomId: event.roomId,
          payload: event.payload as MetadataMap,
          trackedRooms: this.subscribedRooms,
          roomFilter: this.roomFilter,
          onJoined: async (roomId) => {
            // `room_added` from the platform: same fresh-room argument as
            // the bulk hydrate path — no in-flight processing state to
            // recover, so skip the startup REST polls.
            this.getOrCreateExecution(roomId, { skipStartupCatchup: true });
            await this.onRoomJoined?.(roomId, event.payload as MetadataMap);
          },
        });
        return;
      case "room_removed":
      case "room_deleted":
        if (event.roomId) {
          await this.onRoomLeft?.(event.roomId);
          await this.leaveTrackedRoom(event.roomId);
        }
        return;
      case "participant_added":
        if (event.roomId) {
          const context = this.getOrCreateContext(event.roomId);
          const participant = {
            id: event.payload.id,
            name: event.payload.name,
            type: event.payload.type,
            handle: event.payload.handle,
          };
          context.addParticipant(participant);
          await this.onParticipantAdded?.(event.roomId, participant);
        }
        return;
      case "participant_removed":
        if (event.roomId) {
          const context = this.getOrCreateContext(event.roomId);
          context.removeParticipant(event.payload.id);
          await this.onParticipantRemoved?.(event.roomId, event.payload.id);
        }
        return;
      case "contact_request_received":
      case "contact_request_updated":
      case "contact_added":
      case "contact_removed":
        await this.onContactEvent?.(event);
        return;
      case "message_created":
        if (!event.roomId) {
          return;
        }

        await this.getOrCreateExecution(event.roomId).enqueue(event);
        return;
    }

    return assertNever(event);
  }

  public async enqueueEvent(roomId: string, event: PlatformEvent): Promise<void> {
    await this.getOrCreateExecution(roomId).enqueue(event);
  }

  public async bootstrapRoomMessage(roomId: string, message: PlatformMessage): Promise<void> {
    await this.link.subscribeRoom(roomId);
    this.subscribedRooms.add(roomId);
    await this.getOrCreateExecution(roomId).bootstrapMessage(message);
  }

  public async resetRoomSession(roomId: string, timeoutMs?: number): Promise<boolean> {
    const execution = this.executions.get(roomId);
    let graceful = true;
    if (execution) {
      graceful = await execution.stop(timeoutMs);
    }

    this.executions.delete(roomId);
    this.contexts.delete(roomId);
    await this.onSessionCleanup(roomId);
    return graceful;
  }

  private getOrCreateExecution(roomId: string, options?: { skipStartupCatchup?: boolean }): Execution {
    const existing = this.executions.get(roomId);
    if (existing) {
      return existing;
    }

    const execution = new Execution({
      roomId,
      link: this.link,
      context: this.getOrCreateContext(roomId),
      onExecute: this.onExecute,
      onFailure: async (error, event) => {
        await this.failRuntime(error, event);
      },
      logger: this.logger,
      ...(options?.skipStartupCatchup ? { skipStartupCatchup: true } : {}),
    });
    this.executions.set(roomId, execution);
    const watcher = execution.waitUntilStopped()
      .catch(async (error: unknown) => {
        await this.failRuntime(error, {
          type: "message_created",
          roomId,
          payload: {
            id: "execution-failed",
            content: "",
            sender_id: this.agentId,
            sender_type: "Agent",
            sender_name: null,
            message_type: "text",
            metadata: {},
            inserted_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
          },
        });
      })
      .finally(() => {
        this.executionWatchers.delete(roomId);
      });
    this.executionWatchers.set(roomId, watcher);
    return execution;
  }

  public getOrCreateContext(roomId: string): ExecutionContext {
    const existing = this.contexts.get(roomId);
    if (existing) {
      return existing;
    }

    const defaults: ExecutionContextOptions = {
      roomId,
      link: this.link,
      maxContextMessages: this.sessionConfig.maxContextMessages,
      maxMessageRetries: this.sessionConfig.maxMessageRetries,
      enableContextCache: this.sessionConfig.enableContextCache,
      contextCacheTtlSeconds: this.sessionConfig.contextCacheTtlSeconds,
      enableContextHydration: this.sessionConfig.enableContextHydration,
    };
    const context = this.contextFactory
      ? this.contextFactory(roomId, defaults)
      : new ExecutionContext(defaults);
    this.contexts.set(roomId, context);
    return context;
  }

  private async subscribeExistingRooms(): Promise<void> {
    if (!this.autoSubscribeExistingRooms) {
      return;
    }

    await hydrateTrackedRooms({
      link: this.link,
      trackedRooms: this.subscribedRooms,
      roomFilter: this.roomFilter,
      onJoined: async (roomId, payload) => {
        // Auto-subscribe rehydrate path: nothing in `processing` state for
        // this agent in this room yet (we just rejoined it). Skip the
        // startup REST catch-up to avoid 2 calls per existing room — the
        // WebSocket pushes any new activity live.
        this.getOrCreateExecution(roomId, { skipStartupCatchup: true });
        await this.onRoomJoined?.(roomId, payload);
      },
      onError: async (error) => {
        this.logger.warn("AgentRuntime failed to subscribe existing rooms", {
          error,
        });
      },
    });
  }

  private async leaveTrackedRoom(roomId: string): Promise<void> {
    await trackRoomLeave({
      link: this.link,
      roomId,
      trackedRooms: this.subscribedRooms,
      onLeft: async (leftRoomId) => {
        await this.executions.get(leftRoomId)?.stop();
        this.contexts.delete(leftRoomId);
        this.executions.delete(leftRoomId);
        await this.onSessionCleanup(leftRoomId);
      },
    });
  }

  private async failRuntime(error: unknown, event: PlatformEvent): Promise<void> {
    if (!this.fatalError) {
      this.fatalError = error;
      this.running = false;
      this.logger.error("Fatal runtime error handling platform event", {
        eventType: event.type,
        roomId: event.roomId,
        error,
      });
      this.notifyOnError(error, event);
    }

    if (!this.stopController.signal.aborted) {
      this.stopController.abort();
    }
  }

  private notifyOnError(error: unknown, event: PlatformEvent): void {
    if (!this.onError) {
      return;
    }

    try {
      this.onError(error, event);
    } catch (observerError: unknown) {
      this.logger.error("Error in runtime onError callback", {
        eventType: event.type,
        roomId: event.roomId,
        error: observerError,
      });
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled platform event: ${JSON.stringify(value)}`);
}
