import type { BandLink } from "../../platform/BandLink";
import type { ContactEvent, PlatformEvent } from "../../platform/events";
import { resolveLogger, type Logger } from "../../core/logger";
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
import { combineTeardownErrors, isolateTeardown } from "../../core/teardown";
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
  private readonly onExecute: AgentRuntimeOptions["onExecute"];
  private readonly onSessionCleanup: NonNullable<AgentRuntimeOptions["onSessionCleanup"]>;
  private readonly onRoomJoined?: AgentRuntimeOptions["onRoomJoined"];
  private readonly onRoomLeft?: AgentRuntimeOptions["onRoomLeft"];
  private readonly onContactEvent?: AgentRuntimeOptions["onContactEvent"];
  private readonly onParticipantAdded?: AgentRuntimeOptions["onParticipantAdded"];
  private readonly onParticipantRemoved?: AgentRuntimeOptions["onParticipantRemoved"];
  private readonly onError?: AgentRuntimeOptions["onError"];
  private readonly contextFactory?: AgentRuntimeOptions["contextFactory"];
  private readonly sessionConfig: Required<SessionConfig>;
  private readonly contexts = new Map<string, ExecutionContext>();
  private readonly executions = new Map<string, Execution>();
  private readonly executionWatchers = new Map<string, Promise<void>>();
  private readonly logger: Logger;
  private readonly stoppedSignal = new TerminalSignal();
  private readonly lifecycle: LifecycleTracker<RuntimeLifecycleState>;
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
    this.logger = resolveLogger(options.logger);
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
      await this.teardownExecution(roomId);
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
        default:
          assertNever(event);
      }
    };
    this.presence.onContactEvent = this.onContactEvent ?? null;
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
    try {
      await this.presence.start();
    } catch (error) {
      await this.finishFailedStart();
      throw error;
    }

    if (this.lifecycle.is("starting")) {
      this.lifecycle.transition({ status: "running" }, "started");
    }

    // The event loop outlives start(): its failure is the runtime's failure.
    void this.presence
      .waitUntilStopped()
      .catch((error: unknown) => this.failRuntime(error, syntheticRuntimeFailureEvent(this.agentId)));
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
    this.presence.abortEventLoop();
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
    // start() has not created yet, so wait for it to settle first — which is
    // also what `RoomPresence` does internally, since its own start/stop pair
    // is serialised. Unlike `PlatformRuntime` there is no third-party adapter
    // here whose startup could park forever, so waiting cannot strand the
    // caller. Nothing is awaited when no start is in flight, keeping the
    // transition below observable in the caller's own tick.
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
    // remaining rooms, the presence teardown, the map clearing, or the link
    // disconnect.
    const errors: unknown[] = [];

    this.presence.abortEventLoop();
    await isolateTeardown(errors, () => this.presence.waitUntilStopped());

    let graceful = true;

    // All stopped (and deleted) before `presence.stop()` runs below, so its
    // onRoomLeft callback finds nothing left to stop and never re-blocks an
    // already-timed-out execution on a second, unbounded `waitForIdle`. Each
    // execution owns fully independent state, so stopping them concurrently
    // (sharing one `timeoutMs` budget rather than a shrinking per-iteration
    // remainder) is both safe and fair regardless of iteration order.
    await Promise.all(
      [...this.executions].map(async ([roomId, execution]) => {
        await isolateTeardown(errors, async () => {
          graceful = (await execution.stop(timeoutMs)) && graceful;
        });
        this.executions.delete(roomId);
      }),
    );

    await isolateTeardown(errors, () => this.presence.stop());

    for (const roomId of [...this.contexts.keys()]) {
      await isolateTeardown(errors, () => this.onSessionCleanup(roomId));
    }

    this.contexts.clear();
    this.executions.clear();
    this.executionWatchers.clear();

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
    // Driven by the lifecycle rather than by `presence`'s event task: a runtime
    // that has not started one yet, or that is between runs, must still park
    // here until this runtime itself reaches a terminal state.
    await this.stoppedSignal.wait();
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

  public async enqueueEvent(roomId: string, event: PlatformEvent): Promise<void> {
    await this.getOrCreateExecution(roomId).enqueue(event);
  }

  public async bootstrapRoomMessage(roomId: string, message: PlatformMessage): Promise<void> {
    await this.presence.admitRoomOrThrow(roomId);
    await this.getOrCreateExecution(roomId).bootstrapMessage(message);
  }

  public async resetRoomSession(roomId: string, timeoutMs?: number): Promise<boolean> {
    return await this.teardownExecution(roomId, timeoutMs);
  }

  private async teardownExecution(roomId: string, timeoutMs?: number): Promise<boolean> {
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
      logger: this.logger,
    };
    const context = this.contextFactory
      ? this.contextFactory(roomId, defaults)
      : new ExecutionContext(defaults);
    this.contexts.set(roomId, context);
    return context;
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

function assertNever(value: never): never {
  throw new Error(`Unhandled room event: ${JSON.stringify(value)}`);
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
