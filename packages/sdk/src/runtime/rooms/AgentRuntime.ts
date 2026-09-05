import type { BandLink } from "../../platform/BandLink";
import type { ContactEvent, PlatformEvent } from "../../platform/events";
import { TransportError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import type { MetadataMap, ParticipantRecord } from "../../contracts/dtos";
import { Execution } from "../Execution";
import { ExecutionContext, type ExecutionContextOptions } from "../ExecutionContext";
import { RoomPresence } from "./RoomPresence";
import type { AgentConfig, SessionConfig } from "../types";
import type { PlatformMessage } from "../types";

interface AgentRuntimeOptions {
  link: BandLink;
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
  public readonly presence: RoomPresence;
  private readonly link: BandLink;
  private readonly agentId: string;
  private readonly onExecute: (context: ExecutionContext, event: PlatformEvent) => Promise<void>;
  private readonly onSessionCleanup: (roomId: string) => Promise<void>;
  private readonly onRoomJoined?: (roomId: string, payload: MetadataMap) => Promise<void> | void;
  private readonly onRoomLeft?: (roomId: string) => Promise<void> | void;
  private readonly onContactEvent?: (event: ContactEvent) => Promise<void>;
  private readonly onParticipantAdded?: (roomId: string, participant: ParticipantRecord) => Promise<void> | void;
  private readonly onParticipantRemoved?: (roomId: string, participantId: string) => Promise<void> | void;
  private readonly onError?: (error: unknown, event: PlatformEvent) => void;
  private readonly contextFactory?: (roomId: string, defaults: ExecutionContextOptions) => ExecutionContext;
  private readonly sessionConfig: Required<SessionConfig>;
  private readonly contexts = new Map<string, ExecutionContext>();
  private readonly executions = new Map<string, Execution>();
  private readonly executionWatchers = new Map<string, Promise<void>>();
  private readonly logger: Logger;
  private running = false;
  private stopping = false;
  private presenceWatcher: Promise<void> | null = null;
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
    this.contextFactory = options.contextFactory;
    this.sessionConfig = {
      enableContextCache: options.sessionConfig?.enableContextCache ?? true,
      contextCacheTtlSeconds: options.sessionConfig?.contextCacheTtlSeconds ?? 300,
      maxContextMessages: options.sessionConfig?.maxContextMessages ?? 100,
      maxMessageRetries: options.sessionConfig?.maxMessageRetries ?? 1,
      enableContextHydration: options.sessionConfig?.enableContextHydration ?? true,
    };

    this.presence = new RoomPresence({
      link: this.link,
      roomFilter: options.roomFilter,
      autoSubscribeExistingRooms: options.agentConfig?.autoSubscribeExistingRooms ?? false,
      logger: this.logger,
    });
    this.presence.onRoomJoined = async (roomId, payload) => {
      this.getOrCreateExecution(roomId);
      await this.onRoomJoined?.(roomId, payload);
    };
    this.presence.onRoomLeft = async (roomId) => {
      await this.executions.get(roomId)?.stop();
      this.contexts.delete(roomId);
      this.executions.delete(roomId);
      await this.onSessionCleanup(roomId);
      await this.onRoomLeft?.(roomId);
    };
    this.presence.onRoomEvent = async (roomId, event) => {
      switch (event.type) {
        case "participant_added": {
          const context = this.getOrCreateContext(roomId);
          const participant = {
            id: event.payload.id,
            name: event.payload.name,
            type: event.payload.type,
            handle: event.payload.handle,
          };
          context.addParticipant(participant);
          await this.onParticipantAdded?.(roomId, participant);
          return;
        }
        case "participant_removed": {
          const context = this.getOrCreateContext(roomId);
          context.removeParticipant(event.payload.id);
          await this.onParticipantRemoved?.(roomId, event.payload.id);
          return;
        }
        case "message_created":
          await this.getOrCreateExecution(roomId).enqueue(event);
          return;
      }
    };
    this.presence.onContactEvent = this.onContactEvent ?? null;
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.stopping = false;
    this.fatalError = null;

    try {
      await this.presence.start();
    } catch (error) {
      await this.handleStartFailure();
      throw error;
    }

    this.presenceWatcher = this.presence
      .waitUntilStopped()
      .catch((error: unknown) => this.failRuntime(error, syntheticRuntimeFailureEvent(this.agentId)))
      .finally(() => {
        this.presenceWatcher = null;
      });
  }

  private async handleStartFailure(): Promise<void> {
    this.running = false;
    this.stopping = false;
    await this.link.disconnect();
  }

  public async stop(timeoutMs?: number): Promise<boolean> {
    if (this.stopping || (!this.running && !this.fatalError)) {
      return true;
    }

    this.stopping = true;
    this.running = false;

    this.presence.abortEventLoop();
    await this.presence.waitUntilStopped().catch(() => undefined);

    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    let graceful = true;

    // Deleted as each stops, so `presence.stop()`'s onRoomLeft callback below
    // finds nothing left to stop and never re-blocks an already-timed-out
    // execution on a second, unbounded `waitForIdle`.
    for (const [roomId, execution] of [...this.executions]) {
      const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
      const stopped = await execution.stop(remaining);
      if (!stopped) {
        graceful = false;
      }
      this.executions.delete(roomId);
    }

    await this.presence.stop();

    for (const roomId of [...this.contexts.keys()]) {
      await this.onSessionCleanup(roomId);
    }

    this.contexts.clear();
    this.executions.clear();
    this.executionWatchers.clear();

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
    await this.presence.waitUntilStopped().catch(() => undefined);

    if (this.fatalError) {
      throw this.fatalError instanceof Error ? this.fatalError : new Error(String(this.fatalError));
    }
  }

  public getContexts(): ExecutionContext[] {
    return [...this.contexts.values()];
  }

  public async enqueueEvent(roomId: string, event: PlatformEvent): Promise<void> {
    await this.getOrCreateExecution(roomId).enqueue(event);
  }

  public async bootstrapRoomMessage(roomId: string, message: PlatformMessage): Promise<void> {
    await this.presence.admitRoom(roomId, {}, false);
    if (this.presence.roster.roomMembership(roomId) !== "admitted") {
      throw new TransportError(`Failed to subscribe to room ${roomId}`);
    }
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

  private getOrCreateExecution(roomId: string): Execution {
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
      logger: this.logger,
    };
    const context = this.contextFactory
      ? this.contextFactory(roomId, defaults)
      : new ExecutionContext(defaults);
    this.contexts.set(roomId, context);
    return context;
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

    this.presence.abortEventLoop();
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

function syntheticRuntimeFailureEvent(agentId: string): PlatformEvent {
  return {
    type: "message_created",
    roomId: null,
    payload: {
      id: "runtime-failed",
      content: "",
      sender_id: agentId,
      sender_type: "Agent",
      sender_name: null,
      message_type: "text",
      metadata: {},
      inserted_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    },
  };
}
