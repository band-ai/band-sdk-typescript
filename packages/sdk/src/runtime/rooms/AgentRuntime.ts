import type { BandLink } from "../../platform/BandLink";
import type { ContactEvent, PlatformEvent } from "../../platform/events";
import { RuntimeStateError } from "../../core/errors";
import { resolveLogger, type Logger } from "../../core/logger";
import type { MetadataMap, ParticipantRecord } from "../../contracts/dtos";
import { Execution, type ExecutionHandler } from "../Execution";
import type { RoomPauseSource } from "../../contracts/events";
import { MS_PER_SECOND } from "../../core/deadline";
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
import { parseSessionConfig, type AgentConfig, type ResolvedSessionConfig, type SessionConfig } from "../types";
import type { PlatformMessage } from "../types";

interface AgentRuntimeOptions {
  link: BandLink;
  agentId: string;
  onExecute: ExecutionHandler;
  /** Whether a message answers what a room's held turn waits on; see `ExecutionOptions.isControlEvent`. */
  isControlEvent?: (event: PlatformEvent) => boolean;
  onSessionCleanup?: (roomId: string) => Promise<void>;
  onRoomJoined?: (roomId: string, payload: MetadataMap) => Promise<void> | void;
  onRoomLeft?: (roomId: string) => Promise<void> | void;
  /** Handling of an admitted room started: once per execution, so again after a reset. */
  onRoomAdmitted?: (roomId: string) => void;
  /** The agent lost a room's membership; not called for rooms dropped by `stop()`. */
  onRoomRemoved?: (roomId: string) => void;
  /** A reported room's execution stopped: the room was left or reset, or the runtime stopped. */
  onRoomStopped?: (roomId: string) => void;
  /** A room Band stopped is served again: its play push was missed. */
  onMissedPlay?: (roomId: string) => void;
  /** Losing a room's membership ended the pause Band's stop put on it. */
  onBandStopCleared?: (roomId: string) => void;
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
  private readonly isControlEvent: AgentRuntimeOptions["isControlEvent"];
  private readonly onSessionCleanup: NonNullable<AgentRuntimeOptions["onSessionCleanup"]>;
  private readonly onRoomJoined?: AgentRuntimeOptions["onRoomJoined"];
  private readonly onRoomLeft?: AgentRuntimeOptions["onRoomLeft"];
  private readonly onRoomAdmitted?: AgentRuntimeOptions["onRoomAdmitted"];
  private readonly onRoomRemoved?: AgentRuntimeOptions["onRoomRemoved"];
  private readonly onRoomStopped?: AgentRuntimeOptions["onRoomStopped"];
  private readonly onMissedPlay?: AgentRuntimeOptions["onMissedPlay"];
  private readonly onBandStopCleared?: AgentRuntimeOptions["onBandStopCleared"];
  private readonly onContactEvent?: AgentRuntimeOptions["onContactEvent"];
  private readonly onParticipantAdded?: AgentRuntimeOptions["onParticipantAdded"];
  private readonly onParticipantRemoved?: AgentRuntimeOptions["onParticipantRemoved"];
  private readonly onError?: AgentRuntimeOptions["onError"];
  private readonly contextFactory?: AgentRuntimeOptions["contextFactory"];
  private readonly sessionConfig: ResolvedSessionConfig;
  private readonly contexts = new Map<string, ExecutionContext>();
  private readonly executions = new Map<string, Execution>();
  /** Who pauses each room, kept across its executions, so a reset or rejoin starts paused. */
  private readonly roomPauses = new Map<string, Set<RoomPauseSource>>();
  /** Rooms Band played while a reset held them, which their next execution catches up. */
  private readonly owedCatchUps = new Set<string>();
  private readonly executionWatchers = new Map<string, Promise<void>>();
  /** Executions reported through `onRoomAdmitted`, so each start and stop is reported once. */
  private readonly announced = new WeakSet<Execution>();
  private readonly logger: Logger;
  private readonly stoppedSignal = new TerminalSignal();
  private readonly lifecycle: LifecycleTracker<RuntimeLifecycleState>;
  private readonly startGate = new SingleFlight<void>();
  private readonly stopGate = new SingleFlight<boolean>();
  /** Set while a stop waits on a start, so rooms joined meanwhile stop on its terms too. */
  private stopMidStart: { readonly timeoutMs?: number } | null = null;
  /** Cancels the in-flight start's link connect, which can retry for minutes during an outage. */
  private startAbort: AbortController | null = null;

  public constructor(options: AgentRuntimeOptions) {
    this.link = options.link;
    this.agentId = options.agentId;
    this.onExecute = options.onExecute;
    this.isControlEvent = options.isControlEvent;
    this.onSessionCleanup = options.onSessionCleanup ?? (async () => undefined);
    this.onRoomJoined = options.onRoomJoined;
    this.onRoomLeft = options.onRoomLeft;
    this.onRoomAdmitted = options.onRoomAdmitted;
    this.onRoomRemoved = options.onRoomRemoved;
    this.onRoomStopped = options.onRoomStopped;
    this.onMissedPlay = options.onMissedPlay;
    this.onBandStopCleared = options.onBandStopCleared;
    this.onError = options.onError;
    this.logger = resolveLogger(options.logger);
    this.onContactEvent = options.onContactEvent;
    this.onParticipantAdded = options.onParticipantAdded;
    this.onParticipantRemoved = options.onParticipantRemoved;
    this.contextFactory = options.contextFactory;
    this.sessionConfig = parseSessionConfig(options.sessionConfig);
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
      autoSubscribeExistingRooms: options.agentConfig?.autoSubscribeExistingRooms,
      logger: this.logger,
    });
    this.presence.onRoomJoined = async (roomId, payload) => {
      // The execution may predate admission (a contact hub event), so report it now.
      this.announceExecution(roomId, this.getOrCreateExecution(roomId));
      await this.onRoomJoined?.(roomId, payload);
    };
    this.presence.onRoomLeft = async (roomId, reason) => {
      try {
        // Membership loss revokes admission even when the current handler cannot finish.
        await this.teardownExecution(roomId, 0);
      } finally {
        // Reported even when the adapter's cleanup threw: the membership is gone either way.
        if (reason === "removed") {
          // Band's stop held the agent's handling of the room, which is gone with the membership.
          if (this.resumeRoom(roomId, "band")) {
            this.onBandStopCleared?.(roomId);
          }
          if (this.roomPauses.get(roomId)?.size === 0) {
            this.roomPauses.delete(roomId);
          }
          this.onRoomRemoved?.(roomId);
        }
      }
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
        case "reconnected":
          await this.enqueueUnlessStopping(roomId, event);
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
    const abort = new AbortController();
    // Set before the first await, so any stop that sees this start can abort it.
    this.startAbort = abort;
    try {
      await this.presence.start(abort.signal);
    } catch (error) {
      await this.finishFailedStart();
      throw error;
    } finally {
      this.startAbort = null;
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
    // is serialised. The link connect, which retries through an outage, is
    // aborted first; a channel join the start already sent can still hold the
    // stop until the platform answers it or the session ends.
    // Nothing is awaited when no start is in flight, keeping the transition
    // below observable in the caller's own tick.
    const pendingStart = this.lifecycle.is("starting") ? this.startGate.pending : null;
    if (pendingStart) {
      this.startAbort?.abort();
      // Rooms the start has joined stop taking turns now, not after the joins still to come.
      this.stopMidStart = { timeoutMs };
      for (const execution of this.executions.values()) {
        this.stopExecutionMidStart(execution);
      }
      try {
        await pendingStart;
      } catch (error) {
        // The start's own caller sees this rejection; teardown continues here.
        this.logger.debug("AgentRuntime stop is proceeding after the in-flight start failed", { error });
      } finally {
        this.stopMidStart = null;
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
        this.evictExecution(roomId, execution);
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

  /**
   * Pauses `roomId` for `source`, now and for every later execution of the
   * room, until {@link resumeRoom}; see `Execution.pause`. False when
   * `source` was already pausing it.
   */
  public pauseRoom(roomId: string, source: RoomPauseSource): boolean {
    const execution = this.executions.get(roomId);
    if (execution) {
      return execution.pause(source);
    }
    const sources = this.pausesOf(roomId);
    if (sources.has(source)) {
      return false;
    }
    sources.add(source);
    return true;
  }

  /** Lifts `source`'s pause on `roomId`; false when it was not pausing the room. */
  public resumeRoom(roomId: string, source: RoomPauseSource): boolean {
    const execution = this.executions.get(roomId);
    return execution ? execution.resume(source) : (this.roomPauses.get(roomId)?.delete(source) ?? false);
  }

  /**
   * Band played `roomId`: see `Execution.play`. A room whose execution is
   * not running, because a reset is stopping it or has evicted it, owes a
   * catch-up instead: its next execution, created as soon as no reset holds
   * the room, runs what Band kept in its start-up sweep. Returns whether
   * Band's pause was recorded.
   */
  public playRoom(roomId: string): boolean {
    const execution = this.executions.get(roomId);
    if (execution?.state.status === "running") {
      return execution.play();
    }
    const lifted = this.roomPauses.get(roomId)?.delete("band") ?? false;
    this.owedCatchUps.add(roomId);
    if (!execution) {
      this.settleOwedCatchUp(roomId);
    }
    return lifted;
  }

  /** Gives a room owed a catch-up its execution, if it is still admitted and none is running. */
  private settleOwedCatchUp(roomId: string): void {
    if (!this.owedCatchUps.delete(roomId)) {
      return;
    }
    if (this.lifecycle.is("running") && !this.executions.has(roomId) && this.presence.roster.roomMembership(roomId) === "admitted") {
      this.getOrCreateExecution(roomId);
    }
  }

  /** The room's pause record, which each of its executions shares. */
  private pausesOf(roomId: string): Set<RoomPauseSource> {
    let sources = this.roomPauses.get(roomId);
    if (!sources) {
      sources = new Set();
      this.roomPauses.set(roomId, sources);
    }
    return sources;
  }

  /** Ends `roomId`'s running turn and consumes its message; false when none runs. */
  public interruptTurn(roomId: string): boolean {
    return this.executions.get(roomId)?.interrupt() ?? false;
  }

  /**
   * The rooms Band's control signals reach: those this runtime is handling
   * now, and those Band's stop still holds while their session is reset, so
   * a play meanwhile is not lost.
   */
  public handledRoomIds(): string[] {
    const held = [...this.roomPauses].filter(([roomId, sources]) => sources.has("band") && !this.executions.has(roomId));
    return [...this.executions.keys(), ...held.map(([roomId]) => roomId)];
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

    this.evictExecution(roomId, execution);
    this.contexts.delete(roomId);
    await isolateTeardown(errors, () => this.onSessionCleanup(roomId));
    // After the adapter let go of the old session, so the new one starts clean.
    this.settleOwedCatchUp(roomId);

    if (errors.length > 0) {
      throw combineTeardownErrors(errors, "AgentRuntime failed to tear down cleanly");
    }

    return graceful;
  }

  /**
   * Drops `roomId`'s execution after `execution` stopped. Overlapping teardowns
   * share one execution's stop, so only the one that still finds it reports it.
   */
  private evictExecution(roomId: string, execution: Execution | undefined): void {
    if (execution && this.executions.get(roomId) === execution && this.announced.has(execution)) {
      this.onRoomStopped?.(roomId);
    }
    this.executions.delete(roomId);
  }

  /** Reports `execution` as handling `roomId` once the room is admitted; unadmitted rooms are not news. */
  private announceExecution(roomId: string, execution: Execution): void {
    if (this.announced.has(execution) || this.presence.roster.roomMembership(roomId) !== "admitted") {
      return;
    }
    this.announced.add(execution);
    this.onRoomAdmitted?.(roomId);
  }

  private async enqueueUnlessStopping(roomId: string, event: PlatformEvent): Promise<void> {
    try {
      await this.getOrCreateExecution(roomId).enqueue(event);
    } catch (error) {
      const stopping = this.stopMidStart !== null || this.lifecycle.is("stopping");
      if (!(error instanceof RuntimeStateError) || !stopping) {
        throw error;
      }
      // The stop closed the room first; the message stays on the platform for the next start.
      this.logger.debug("Dropped a room event for a room the stop already closed", { roomId, eventType: event.type });
    }
  }

  private stopExecutionMidStart(execution: Execution): void {
    // performStop() stops it again and collects the outcome.
    void execution.stop(this.stopMidStart?.timeoutMs).catch(() => undefined);
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
      isControlEvent: this.isControlEvent,
      onFailure: async (error, event) => {
        await this.failRuntime(error, event);
      },
      pausedBy: this.pausesOf(roomId),
      onMissedPlay: () => this.onMissedPlay?.(roomId),
      stoppedProbeIntervalMs: this.sessionConfig.stoppedResyncSeconds * MS_PER_SECOND,
      logger: this.logger,
    });
    this.executions.set(roomId, execution);
    this.announceExecution(roomId, execution);
    if (this.stopMidStart) {
      this.stopExecutionMidStart(execution);
    }
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
      ...this.sessionConfig,
      roomId,
      link: this.link,
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
