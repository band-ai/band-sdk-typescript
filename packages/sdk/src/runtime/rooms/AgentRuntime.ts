import type { BandLink } from "../../platform/BandLink";
import type { ContactEvent, PlatformEvent } from "../../platform/events";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import type { MetadataMap, ParticipantRecord } from "../../contracts/dtos";
import { Execution } from "../Execution";
import { ExecutionContext, type ExecutionContextOptions } from "../ExecutionContext";
import type { RuntimeLifecycleState } from "../lifecycle";
import {
  LifecycleTracker,
  SingleFlight,
  TerminalSignal,
  isLegalRuntimeTransition,
  startWithGate,
} from "../lifecycle";
import { hydrateTrackedRooms, trackRoomJoin, trackRoomLeave } from "./subscriptions";
import { combineTeardownErrors, isolateTeardown } from "../../core/teardown";
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
  private readonly roomFilter?: (room: MetadataMap) => boolean;
  private readonly contextFactory?: (roomId: string, defaults: ExecutionContextOptions) => ExecutionContext;
  private readonly sessionConfig: Required<SessionConfig>;
  private readonly autoSubscribeExistingRooms: boolean;
  private readonly subscribedRooms = new Set<string>();
  private readonly contexts = new Map<string, ExecutionContext>();
  private readonly executions = new Map<string, Execution>();
  private readonly executionWatchers = new Map<string, Promise<void>>();
  private readonly logger: Logger;
  private readonly stoppedSignal = new TerminalSignal();
  private readonly lifecycle: LifecycleTracker<RuntimeLifecycleState>;
  private stopController = new AbortController();
  private consumeTask: Promise<void> | null = null;
  private readonly startGate = new SingleFlight<void>();
  private readonly stopGate = new SingleFlight<boolean>();

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
    this.lifecycle = new LifecycleTracker<RuntimeLifecycleState>({ status: "not_started" }, {
      owner: "AgentRuntime",
      logContext: { agentId: this.agentId },
      logger: this.logger,
      isLegalTransition: isLegalRuntimeTransition,
      onTransition: (state) => {
        if (state.status === "stopped") {
          this.stoppedSignal.settle(null);
        } else if (state.status === "failed") {
          this.stoppedSignal.settle(state.error);
        }
      },
    });
  }

  /** Current lifecycle state of this runtime. */
  public get state(): RuntimeLifecycleState {
    return this.lifecycle.state;
  }

  /**
   * Connect, subscribe, and begin consuming platform events.
   *
   * Repeated or concurrent calls join the in-flight start instead of starting a
   * second consume loop. Calling `start()` while a `stop()` is still in flight
   * rejects with a `RuntimeStateError`.
   */
  public async start(): Promise<void> {
    await startWithGate({
      lifecycle: this.lifecycle,
      startGate: this.startGate,
      stopGate: this.stopGate,
      stoppedSignal: this.stoppedSignal,
      ownerName: "AgentRuntime",
      runStart: () => this.runStart(),
    });
  }

  private async runStart(): Promise<void> {
    // A fresh controller per run; the previous one is never aborted here because
    // another caller may still be observing it.
    this.stopController = new AbortController();

    try {
      await this.link.connect();
    } catch (error) {
      await this.finishFailedStart();
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
      await this.finishFailedStart();
      throw error;
    }

    this.consumeTask = this.consumeLoop(this.stopController.signal);
    if (this.lifecycle.is("starting")) {
      this.lifecycle.transition({ status: "running" }, "started");
    }

    if (!this.link.capabilities.contacts) {
      return;
    }

    try {
      await this.link.subscribeAgentContacts();
    } catch {
      this.logger.warn("AgentRuntime failed to subscribe agent_contacts channel, continuing without it");
    }
  }

  private async finishFailedStart(): Promise<void> {
    try {
      await this.handleStartFailure();
    } catch (cleanupError) {
      this.markFailed(cleanupError, "start-cleanup-failed");
      throw cleanupError;
    }

    if (this.lifecycle.is("starting")) {
      this.lifecycle.transition({ status: "stopped" }, "start-failed");
    }
  }

  private async handleStartFailure(): Promise<void> {
    this.stopController.abort();
    if (this.consumeTask) {
      await this.consumeTask;
      this.consumeTask = null;
    }
    await this.link.disconnect();
  }

  /**
   * Tear the runtime down.
   *
   * A concurrent second call joins the in-flight teardown and mirrors its
   * outcome — including rejecting with the *same* `Error` instance — instead of
   * reporting a shutdown it did not perform.
   */
  public async stop(timeoutMs?: number): Promise<boolean> {
    return await this.stopGate.run(() => this.runStop(timeoutMs));
  }

  private async runStop(timeoutMs?: number): Promise<boolean> {
    // A stop landing mid-start must not report a teardown of resources that
    // start() has not created yet, so wait for it to settle first. Nothing is
    // awaited when no start is in flight, keeping the transition below
    // observable in the caller's own tick.
    const pendingStart = this.lifecycle.is("starting") ? this.startGate.pending : null;
    if (pendingStart) {
      try {
        await pendingStart;
      } catch (error) {
        // The start's own caller sees this rejection; teardown continues here.
        this.logger.debug("AgentRuntime stop is proceeding after the in-flight start failed", { error });
      }
    }

    if (this.lifecycle.is("not_started") || this.lifecycle.is("stopped")) {
      return true;
    }

    const fatalError = this.lifecycle.is("failed") ? this.lifecycle.state.error : null;

    this.startGate.reset();
    this.lifecycle.transition({ status: "stopping" }, "stop");

    try {
      return await this.performStop(timeoutMs, fatalError);
    } catch (error) {
      // Never leave the runtime latched in "stopping": a teardown that blew up
      // must still be re-attemptable and must not block a later start().
      this.markFailed(error, "stop-failed");
      throw error;
    }
  }

  private async performStop(timeoutMs: number | undefined, fatalError: Error | null): Promise<boolean> {
    // Every step below is isolated: one room's failed teardown must not skip the
    // remaining rooms, the map clearing, or the link disconnect.
    const errors: unknown[] = [];

    this.stopController.abort();
    const consumeTask = this.consumeTask;
    if (consumeTask) {
      this.consumeTask = null;
      await isolateTeardown(errors, () => consumeTask);
    }

    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const remaining = (): number | undefined =>
      deadline === undefined ? undefined : Math.max(0, deadline - Date.now());

    let graceful = true;

    for (const execution of this.executions.values()) {
      await isolateTeardown(errors, async () => {
        graceful = (await execution.stop(remaining())) && graceful;
      });
    }

    for (const roomId of [...this.subscribedRooms]) {
      await isolateTeardown(errors, () => this.leaveTrackedRoom(roomId, remaining()));
    }

    for (const roomId of [...this.contexts.keys()]) {
      await isolateTeardown(errors, () => this.onSessionCleanup(roomId));
    }

    this.subscribedRooms.clear();
    this.contexts.clear();
    this.executions.clear();
    this.executionWatchers.clear();

    if (this.link.capabilities.contacts) {
      await isolateTeardown(errors, () => this.link.unsubscribeAgentContacts());
    }

    await isolateTeardown(errors, () => this.link.disconnect());

    const failure = this.lifecycle.is("failed") ? this.lifecycle.state.error : fatalError;
    if (failure) {
      if (!this.lifecycle.is("failed")) {
        this.lifecycle.transition({ status: "failed", error: failure }, "stopped-after-failure");
      }
      errors.unshift(failure);
    }

    if (errors.length > 0) {
      throw combineTeardownErrors(errors, "AgentRuntime failed to tear down cleanly");
    }

    this.lifecycle.transition({ status: "stopped" }, "stopped");
    return graceful;
  }

  public getContext(roomId: string): ExecutionContext | undefined {
    return this.contexts.get(roomId);
  }

  /**
   * Resolve once the runtime has actually stopped, or reject with the fatal
   * error that ended it.
   *
   * A runtime that was never started stays pending until it stops or fails;
   * starting it does not resolve a pending wait.
   */
  public async waitUntilStopped(): Promise<void> {
    const task = this.consumeTask;
    if (!task) {
      await this.stoppedSignal.wait();
      return;
    }

    await task;
    if (this.lifecycle.is("failed")) {
      throw this.lifecycle.state.error;
    }
  }

  private markFailed(error: unknown, trigger: string): boolean {
    if (this.lifecycle.is("not_started")) {
      return false;
    }

    return this.lifecycle.fail(error, trigger);
  }

  public getContexts(): ExecutionContext[] {
    return [...this.contexts.values()];
  }

  private async consumeLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let event: PlatformEvent | null;
      try {
        event = await this.link.nextEvent(signal);
      } catch (error: unknown) {
        await this.failRuntime(error, syntheticRuntimeFailureEvent(this.agentId));
        return;
      }

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
            this.getOrCreateExecution(roomId);
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
    const errors: unknown[] = [];
    let graceful = true;

    if (execution) {
      // Isolated so a failed execution still gets evicted from the maps.
      await isolateTeardown(errors, async () => {
        graceful = await execution.stop(timeoutMs);
      });
    }

    this.executions.delete(roomId);
    this.contexts.delete(roomId);
    await isolateTeardown(errors, () => this.onSessionCleanup(roomId));

    if (errors.length > 0) {
      throw combineTeardownErrors(errors, "AgentRuntime failed to tear down cleanly");
    }

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
        this.getOrCreateExecution(roomId);
        await this.onRoomJoined?.(roomId, payload);
      },
      onError: async (error) => {
        this.logger.warn("AgentRuntime failed to subscribe existing rooms", {
          error,
        });
      },
    });
  }

  private async leaveTrackedRoom(roomId: string, timeoutMs?: number): Promise<void> {
    const errors: unknown[] = [];
    await trackRoomLeave({
      link: this.link,
      roomId,
      trackedRooms: this.subscribedRooms,
      onLeft: async (leftRoomId) => {
        const execution = this.executions.get(leftRoomId);
        if (execution) {
          // Isolated so a failed execution still gets evicted from the maps.
          await isolateTeardown(errors, () => execution.stop(timeoutMs));
        }

        this.contexts.delete(leftRoomId);
        this.executions.delete(leftRoomId);
        await isolateTeardown(errors, () => this.onSessionCleanup(leftRoomId));
      },
    });

    if (errors.length > 0) {
      throw combineTeardownErrors(errors, "AgentRuntime failed to tear down cleanly");
    }
  }

  private async failRuntime(error: unknown, event: PlatformEvent): Promise<void> {
    if (this.markFailed(error, "runtime-error")) {
      this.logger.error("Fatal runtime error handling platform event", {
        eventType: event.type,
        roomId: event.roomId,
        error,
      });
      this.notifyOnError(error, event);
    } else {
      // The lifecycle is already terminal, so the transition is a no-op — but the
      // error itself still deserves a trace instead of being dropped silently.
      this.logger.debug("Runtime error after the lifecycle already ended", {
        status: this.lifecycle.state.status,
        eventType: event.type,
        roomId: event.roomId,
        error,
      });
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

function assertNever(value: never): never {
  throw new Error(`Unhandled platform event: ${JSON.stringify(value)}`);
}
