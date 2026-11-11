import { bindWorkingCycle } from "./workingState";
import { isSyntheticTurn, type FrameworkAdapter, type FrameworkAdapterInput, type Preprocessor } from "../contracts/protocols";
import { messageIdOf, type ContactEvent, type PlatformEvent } from "../platform/events";
import { BandLink, type BandLinkOptions } from "../platform/BandLink";
import { AgentRuntime } from "./rooms/AgentRuntime";
import { stopModeOf } from "./Execution";
import {
  parseSessionConfig,
  type AgentConfig,
  type ContactEventConfig,
  type ResolvedSessionConfig,
  type SessionConfig,
} from "./types";
import type { PlatformMessage } from "./types";
import type { ParticipantRecord, MetadataMap } from "../contracts/dtos";
import { RuntimeStateError, ValidationError } from "../core/errors";
import { DefaultPreprocessor } from "./preprocessing/DefaultPreprocessor";
import { toPlatformMessage } from "./formatters";
import { ContactEventHandler } from "./ContactEventHandler";
import type { ExecutionContext, ExecutionContextOptions } from "./ExecutionContext";
import type { RuntimeLifecycleState } from "./lifecycle";
import { LifecycleTracker, SingleFlight, isLegalRuntimeTransition, startWithGate, toLifecycleError } from "./lifecycle";
import { combineTeardownErrors, isolateTeardown } from "../core/teardown";
import { resolveLogger, type Logger } from "../core/logger";
import { turnFailureLabel } from "../core/coercion";
import { evaluateAdapterResult, isSelfEcho } from "@band-ai/band-sdk-core";
import type { AgentEventListener, TurnStopMode } from "../contracts/events";
import type { AgentControl, AgentControlMode } from "../platform/control";
import { ControlDeduplicator, controlTargets } from "./control";
import { untilStopped } from "../core/signals";
import { revokedOnStop } from "./turnRevocation";
import { AgentEventHub } from "./agentEvents";

/** Trigger of the cleanup `stop()` that `start()` runs on its own failure path. */
const START_CLEANUP_TRIGGER = "start-failed";

export interface PlatformRuntimeOptions {
  agentId: string;
  apiKey: string;
  wsUrl?: string;
  restUrl?: string;
  link?: BandLink;
  linkOptions?: Omit<BandLinkOptions, "agentId" | "apiKey">;
  preprocessor?: Preprocessor<PlatformEvent>;
  sessionConfig?: SessionConfig;
  contactConfig?: ContactEventConfig;
  agentConfig?: AgentConfig;
  logger?: Logger;
  onParticipantAdded?: (roomId: string, participant: ParticipantRecord) => Promise<void> | void;
  onParticipantRemoved?: (roomId: string, participantId: string) => Promise<void> | void;
  roomFilter?: (room: MetadataMap) => boolean;
  contextFactory?: (roomId: string, defaults: ExecutionContextOptions) => ExecutionContext;
  identity?: {
    name: string;
    description?: string | null;
  };
}

/** A turn's claim and acknowledgements: a failed mark is logged, never the turn's failure. */
const TURN_MARK = { bestEffort: true } as const;

/**
 * A turn's message as settling sees it: Band holds and settles it (`settles`),
 * or the runtime made it itself (`synthetic`) and only the room holds it.
 */
interface TurnMessage {
  id: string;
  settles: boolean;
  synthetic: boolean;
}

export class PlatformRuntime implements AsyncDisposable {
  private readonly _agentId: string;
  private readonly _apiKey: string;
  private readonly _wsUrl?: string;
  private readonly _restUrl?: string;
  private readonly preprocessor: Preprocessor<PlatformEvent>;
  private readonly sessionConfig: ResolvedSessionConfig;
  private readonly contactConfig?: ContactEventConfig;
  private readonly agentConfig?: AgentConfig;
  private readonly linkOptions?: Omit<BandLinkOptions, "agentId" | "apiKey">;
  private readonly configuredIdentity?: {
    name: string;
    description?: string | null;
  };
  private readonly logger: Logger;
  private readonly _onParticipantAdded?: (roomId: string, participant: ParticipantRecord) => Promise<void> | void;
  private readonly _onParticipantRemoved?: (roomId: string, participantId: string) => Promise<void> | void;
  private readonly _roomFilter?: (room: MetadataMap) => boolean;
  private readonly _contextFactory?: (roomId: string, defaults: ExecutionContextOptions) => ExecutionContext;

  private readonly events: AgentEventHub;
  /** Stops relaying link changes and control signals; held from start until the matching stop. */
  private stopObservingLink: (() => void) | null = null;
  private readonly controlIds = new ControlDeduplicator();
  private readonly lifecycle: LifecycleTracker<RuntimeLifecycleState>;
  private linkInstance?: BandLink;
  private initPromise: Promise<void> | null = null;
  private runtime?: AgentRuntime;
  private contactHandler?: ContactEventHandler;
  private activeAdapter?: FrameworkAdapter;
  private readonly startGate = new SingleFlight<void>();
  private readonly stopGate = new SingleFlight<boolean>();
  private _agentName = "";
  private _agentDescription = "";
  private contactHubRoomId?: string;
  private contactsSubscribed = false;

  public constructor(options: PlatformRuntimeOptions) {
    if (!options.agentId || options.agentId.trim() === "") {
      throw new ValidationError(
        "agentId is required and must be a non-empty string. Use loadAgentConfig() to load credentials from agent_config.yaml.",
      );
    }

    if (!options.apiKey || options.apiKey.trim() === "") {
      throw new ValidationError(
        "apiKey is required and must be a non-empty string. Use loadAgentConfig() to load credentials from agent_config.yaml.",
      );
    }

    this._agentId = options.agentId;
    this._apiKey = options.apiKey;
    this._wsUrl = options.wsUrl;
    this._restUrl = options.restUrl;
    this.linkInstance = options.link;
    // An explicit top-level logger wins over a link-specific one; absent
    // both, `logger` stays unset so `BandLink` falls back to its own default
    // rather than being forced into this runtime's `NoopLogger`.
    this.linkOptions = {
      ...options.linkOptions,
      logger: options.logger ?? options.linkOptions?.logger,
    };
    this.preprocessor = options.preprocessor ?? new DefaultPreprocessor();
    this.sessionConfig = parseSessionConfig(options.sessionConfig);
    this.contactConfig = options.contactConfig;
    this.agentConfig = options.agentConfig;
    this.logger = resolveLogger(options.logger);
    this.events = new AgentEventHub(this.logger);
    this.configuredIdentity = options.identity;
    this._onParticipantAdded = options.onParticipantAdded;
    this._onParticipantRemoved = options.onParticipantRemoved;
    this._roomFilter = options.roomFilter;
    this._contextFactory = options.contextFactory;
    this.lifecycle = new LifecycleTracker<RuntimeLifecycleState>({ status: "not_started" }, {
      owner: "PlatformRuntime",
      logContext: { agentId: this._agentId },
      logger: this.logger,
      isLegalTransition: isLegalRuntimeTransition,
    });
  }

  /** Adds a listener for this agent's local events; the returned function removes it. */
  public observe(listener: AgentEventListener): () => void {
    return this.events.observe(listener);
  }

  private observeLink(): void {
    const stopConnection = this.link.onConnectionChange(this.events.emit);
    const stopControl = this.link.onControl((control) => this.applyControl(control));
    const stopObservedStops = this.link.onExecutionStopped((roomId) => this.observeBandStop(roomId));
    this.stopObservingLink = () => {
      stopConnection();
      stopControl();
      stopObservedStops();
    };
    // A borrowed link may already be up, and its connect() then reports nothing.
    if (this.link.isConnected()) {
      this.events.emit({ type: "link.connected", reconnected: false });
    }
  }

  private unobserveLink(): void {
    this.stopObservingLink?.();
    this.stopObservingLink = null;
  }

  /**
   * Band refused a request in `roomId` as stopped, so its stop push was missed
   * or is still on its way: pause the room now, synchronously, so the turn that
   * made the request is cut short before it settles its message, then cancel it.
   */
  private observeBandStop(roomId: string): void {
    const runtime = this.runtime;
    const adapter = this.activeAdapter;
    if (!runtime || !adapter || !this.pauseForBand(runtime, roomId)) {
      return;
    }
    this.logger.info("Band has stopped the agent in a room; pausing it", { roomId });
    this.cancelAdapterTurn(adapter, roomId);
  }

  /** Pauses `roomId` for Band, reporting it; false when Band's pause already held it. */
  private pauseForBand(runtime: AgentRuntime, roomId: string): boolean {
    if (!runtime.pauseRoom(roomId, "band")) {
      return false;
    }
    this.events.emit({ type: "room.paused", roomId, source: "band" });
    return true;
  }

  private reportBandResumed(roomId: string): void {
    this.events.emit({ type: "room.resumed", roomId, source: "band" });
  }

  /** Band played `roomId`, by its push or as a check found: lifts its pause and catches it up. */
  private playBand(roomId: string): void {
    if (this.runtime?.playRoom(roomId)) {
      this.reportBandResumed(roomId);
    }
  }

  /**
   * Applies one `agent.control` signal to the rooms it reaches, all at once,
   * so signals apply in arrival order and only to rooms still handled. A
   * signal that reaches no handled room is not remembered, so a repeat can
   * still apply once the room is handled.
   */
  private applyControl(control: AgentControl): void {
    const runtime = this.runtime;
    const adapter = this.activeAdapter;
    const roomIds = runtime ? controlTargets(control, runtime.handledRoomIds()) : [];
    if (!runtime || !adapter || roomIds.length === 0) {
      this.logger.info("Control signal reached no handled room", { mode: control.mode, roomId: control.roomId, scope: control.scope });
      return;
    }
    if (!this.controlIds.firstSighting(control)) {
      this.logger.debug("Ignoring a repeated control signal", { correlationId: control.correlationId });
      return;
    }
    this.logger.info("Applying control signal", {
      mode: control.mode,
      scope: control.scope,
      rooms: roomIds.length,
      correlationId: control.correlationId,
      executionId: control.executionId,
    });
    for (const roomId of roomIds) {
      this.applyControlToRoom(runtime, adapter, roomId, control.mode);
    }
  }

  private applyControlToRoom(runtime: AgentRuntime, adapter: FrameworkAdapter, roomId: string, mode: AgentControlMode): void {
    switch (mode) {
      case "stop":
        this.pauseForBand(runtime, roomId);
        // Also reaches work the adapter kept running after its handler returned.
        this.cancelAdapterTurn(adapter, roomId);
        return;
      case "play":
        this.playBand(roomId);
        return;
      case "interrupt":
        if (!runtime.interruptTurn(roomId)) {
          this.logger.debug("Interrupt found no running turn in the room", { roomId });
        }
        this.cancelAdapterTurn(adapter, roomId);
        return;
    }
  }

  /**
   * Asks the adapter to cancel the room's turn without waiting on it: a cancel
   * is third-party work that may never settle, and no later signal waits on it.
   */
  private cancelAdapterTurn(adapter: FrameworkAdapter, roomId: string): void {
    void Promise.resolve()
      .then(() => adapter.cancelTurn?.(roomId))
      .catch((error: unknown) => {
        this.logger.warn("Adapter failed to cancel a stopped turn", { roomId, error });
      });
  }

  /** Current lifecycle state of this runtime. */
  public get state(): RuntimeLifecycleState {
    return this.lifecycle.state;
  }

  public get link(): BandLink {
    if (!this.linkInstance) {
      throw new RuntimeStateError("Runtime is not initialized");
    }

    return this.linkInstance;
  }

  public get name(): string {
    return this._agentName;
  }

  public get agentId(): string {
    return this._agentId;
  }

  public get description(): string {
    return this._agentDescription;
  }

  public get contactConfiguration(): ContactEventConfig | undefined {
    return this.contactConfig;
  }

  /**
   * Whether the contacts channel subscription is currently held.
   *
   * @deprecated Read {@link PlatformRuntime.state} for lifecycle questions: this
   * flag is only ever `true` while the runtime is running and is cleared on
   * teardown, so it conflates "contacts are subscribed" with "the runtime is
   * alive".
   */
  public get isContactsSubscribed(): boolean {
    return this.contactsSubscribed;
  }

  public async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  private async doInitialize(): Promise<void> {
    if (!this.linkInstance) {
      this.linkInstance = new BandLink({
        ...this.linkOptions,
        agentId: this._agentId,
        apiKey: this._apiKey,
        wsUrl: this._wsUrl,
        restUrl: this._restUrl,
      });
    }

    const me = !this.configuredIdentity || this.link.capabilities.tasks
      ? await this.link.rest.getAgentMe()
      : undefined;
    this.link.dropUnsupported(me?.featureFlags);
    this._agentName = this.configuredIdentity?.name ?? me!.name;
    this._agentDescription = (this.configuredIdentity ? this.configuredIdentity.description : me!.description) ?? "";
  }

  /**
   * Connect the adapter to the platform.
   *
   * Repeated or concurrent calls join the in-flight start. Calling `start()`
   * while a `stop()` is still in flight rejects with a {@link RuntimeStateError}.
   * A successful start also re-arms teardown, so a runtime whose previous
   * `stop()` failed can be shut down properly on the next attempt.
   */
  public async start(adapter: FrameworkAdapter): Promise<void> {
    await startWithGate({
      lifecycle: this.lifecycle,
      startGate: this.startGate,
      stopGate: this.stopGate,
      ownerName: "PlatformRuntime",
      runStart: () => this.runStart(adapter),
    });
  }

  private async runStart(adapter: FrameworkAdapter): Promise<void> {
    // `startWithGate` has just installed a fresh `"starting"` state. Keeping that
    // exact instance is how every checkpoint below asks "did a stop() take over
    // while I was awaiting?" — a status comparison cannot, because a stop
    // followed by a replacement start is back in `"starting"`, just not this one.
    const startState = this.lifecycle.state;

    try {
      await this.doStart(adapter, startState);
    } catch (error) {
      // A superseded start owns nothing, and a cleanup that already reached a
      // terminal state keeps its own outcome.
      if (this.lifecycle.isCurrent(startState)) {
        this.lifecycle.fail(error, START_CLEANUP_TRIGGER);
      }
      throw error;
    }

    if (this.lifecycle.isCurrent(startState)) {
      this.lifecycle.transition({ status: "running" }, "started");
    }
  }

  private async doStart(adapter: FrameworkAdapter, startState: RuntimeLifecycleState): Promise<void> {
    const assertNotSuperseded = (): void => {
      if (!this.lifecycle.isCurrent(startState)) {
        throw new RuntimeStateError("PlatformRuntime start was superseded by stop()");
      }
    };

    await this.initialize();
    assertNotSuperseded();
    // Relays link changes until `stop()` unsubscribes, since a borrowed link can outlive this runtime.
    this.observeLink();
    // Claimed before `onStarted` so a stop() landing mid-startup still owes this
    // adapter its `onRuntimeStop` — several adapters only abort a hung startup
    // when that hook runs.
    this.activeAdapter = adapter;

    try {
      adapter.attachObserver?.(this.events.emit);
      await adapter.onStarted(this._agentName, this._agentDescription);
      assertNotSuperseded();

      this.contactHubRoomId = undefined;
      this.contactHandler = new ContactEventHandler({
        config: this.contactConfig ?? { strategy: "disabled" },
        rest: this.link.rest,
        onBroadcast: (message) => {
          const runtime = this.runtime;
          if (!runtime) return;
          for (const context of runtime.getContexts()) {
            context.injectSystemMessage(message);
          }
        },
        onHubEvent: async (roomId, event) => {
          const runtime = this.runtime;
          if (!runtime) return;
          try {
            await runtime.enqueueEvent(roomId, event);
          } catch (error) {
            // The room's execution stopped between the event arriving and being
            // queued; dropping it here keeps it from becoming an unhandled rejection.
            if (!(error instanceof RuntimeStateError)) {
              throw error;
            }
            // Logged at `error`, like every other dropped-event path: this is an
            // unrecoverable loss of a real inbound event, not a routine warning.
            this.logger.error("Dropped contact hub event for a stopped room execution", {
              roomId,
              eventType: event.type,
              error: error.message,
            });
          }
        },
        onHubInit: async (roomId, systemPrompt) => {
          this.contactHubRoomId = roomId;
          const runtime = this.runtime;
          if (!runtime) return;
          runtime.getOrCreateContext(roomId).injectSystemMessage(systemPrompt);
        },
      });

      this.runtime = new AgentRuntime({
        link: this.link,
        agentId: this._agentId,
        sessionConfig: this.sessionConfig,
        agentConfig: this.agentConfig,
        logger: this.logger,
        onRoomAdmitted: (roomId) => this.events.emit({ type: "room.joined", roomId }),
        onRoomRemoved: (roomId) => this.events.emit({ type: "room.left", roomId }),
        onRoomStopped: (roomId) => this.events.emit({ type: "room.stopped", roomId }),
        onMissedPlay: (roomId) => this.playBand(roomId),
        onBandStopCleared: (roomId) => this.reportBandResumed(roomId),
        onExecute: (context, event, admitted, holdRoomUntil, stopped) => this.executeAdapter(context, event, adapter, admitted, holdRoomUntil, stopped),
        isControlEvent: (event) => this.isControlEvent(adapter, event),
        onSessionCleanup: (roomId) => adapter.onCleanup(roomId),
        onContactEvent: (event) => this.handleContactEvent(event),
        onParticipantAdded: this._onParticipantAdded,
        onParticipantRemoved: this._onParticipantRemoved,
        roomFilter: this._roomFilter,
        contextFactory: this._contextFactory,
      });

      await this.runtime.start();
      assertNotSuperseded();
      this.contactsSubscribed = Boolean(this.link.capabilities.contacts);
    } catch (error) {
      if (!this.lifecycle.isCurrent(startState)) {
        // A stop() already superseded this start and owns the teardown of
        // whatever it had installed. Cleaning up here would tear down the
        // replacement runtime a later start() has since built.
        throw error;
      }

      try {
        await this.beginStop(undefined, START_CLEANUP_TRIGGER);
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          "PlatformRuntime failed to start and cleanup also failed",
        );
      }
      throw error;
    }
  }

  /**
   * Tear the runtime down and release the platform connection.
   *
   * A concurrent second call joins the in-flight teardown and mirrors its
   * outcome — including rejecting with the *same* `Error` instance — rather than
   * reporting a graceful shutdown it did not perform. A failed teardown does not
   * disable future ones: a subsequent `start()` re-arms `stop()`.
   */
  public async stop(timeoutMs?: number): Promise<boolean> {
    return await this.beginStop(timeoutMs, "stop");
  }

  private async beginStop(timeoutMs: number | undefined, trigger: string): Promise<boolean> {
    return await this.stopGate.run(() => this.runStop(timeoutMs, trigger));
  }

  private async runStop(timeoutMs: number | undefined, trigger: string): Promise<boolean> {
    // A start still in flight is superseded from here, rather than waited on:
    // its next checkpoint sees a lifecycle that moved off the state it began
    // under and aborts instead of installing a live runtime behind this
    // teardown's back. Waiting instead would hand shutdown to the adapter —
    // several only abort a hung `onStarted()` once `onRuntimeStop()` runs
    // below, which a stop parked on that same start would never reach.
    // Clearing the gate keeps a later start() from joining the doomed run.
    // Nothing is awaited before the transitions below, so they stay observable
    // in the caller's own tick.
    this.startGate.reset();

    const runtime = this.runtime;
    const adapter = this.activeAdapter;
    if (!runtime && !adapter) {
      // Nothing was ever constructed, so there is no teardown to run — but a
      // recorded failure (a start that blew up before it built anything) still
      // has to reach this caller. Reporting a graceful shutdown while `state`
      // says "failed" is the same lie this lifecycle exists to remove.
      if (this.lifecycle.is("failed")) {
        this.logger.debug("PlatformRuntime stop is resurfacing the recorded start failure", { error: this.lifecycle.state.error });

        throw this.lifecycle.state.error;
      }
      // "running" never reaches here: state only becomes "running" in runStart()
      // after `runtime`/`activeAdapter` are already assigned, which the guard
      // above (`!runtime && !adapter`) rules out.
      if (this.lifecycle.is("starting")) {
        this.lifecycle.transition({ status: "stopped" }, trigger);
      }
      return true;
    }

    this.lifecycle.transition({ status: "stopping" }, trigger);
    this.runtime = undefined;
    this.contactHandler = undefined;
    this.contactsSubscribed = false;
    this.activeAdapter = undefined;

    let graceful = true;
    const errors: unknown[] = [];

    if (runtime) {
      await isolateTeardown(errors, async () => {
        graceful = await runtime.stop(timeoutMs);
      });
    }

    await isolateTeardown(errors, () => Promise.resolve(adapter?.onRuntimeStop?.()));
    // After the runtime stop above, so its `link.disconnected` is still relayed.
    this.unobserveLink();

    if (errors.length > 0) {
      throw this.recordStopFailure(
        combineTeardownErrors(errors, "PlatformRuntime stop failed and adapter cleanup also failed"),
      );
    }

    this.lifecycle.transition({ status: "stopped" }, "stopped");
    return graceful;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  private recordStopFailure(error: unknown): Error {
    const failure = toLifecycleError(error);
    this.lifecycle.fail(failure, "stop-failed");
    return failure;
  }

  public async runForever(): Promise<void> {
    if (!this.runtime) {
      throw new RuntimeStateError("Runtime not started");
    }

    await this.runtime.waitUntilStopped();
  }

  public async bootstrapRoomMessage(roomId: string, message: PlatformMessage): Promise<void> {
    if (!this.runtime) {
      throw new RuntimeStateError("Runtime not started");
    }

    await this.runtime.bootstrapRoomMessage(roomId, message);
  }

  public async resetRoomSession(roomId: string, timeoutMs?: number): Promise<boolean> {
    if (!this.runtime) {
      throw new RuntimeStateError("Runtime not started");
    }

    return await this.runtime.resetRoomSession(roomId, timeoutMs);
  }

  /** A room message, from someone else, that the adapter says answers what its held turn waits on. */
  private isControlEvent(adapter: FrameworkAdapter, event: PlatformEvent): boolean {
    if (event.type !== "message_created" || !event.roomId || !adapter.isControlMessage) {
      return false;
    }
    const message = toPlatformMessage(event.roomId, event.payload);
    return !isSelfEcho(message.senderId, message.senderType, this._agentId)
      && !isSyntheticTurn(message)
      && adapter.isControlMessage(message, event.roomId);
  }

  private async executeAdapter(
    context: ExecutionContext,
    event: PlatformEvent,
    adapter: FrameworkAdapter,
    admitted: () => boolean,
    holdRoomUntil: (ended: Promise<void>) => void,
    stopped: AbortSignal,
  ): Promise<boolean> {
    if (!admitted() || stopped.aborted) return false;
    const input = await this.preprocessor.process(context, event, this._agentId);
    if (!admitted()) return false;
    if (!input) {
      this.logger.debug("preprocessor returned no input", {
        roomId: context.roomId,
        eventType: event.type,
        messageId: messageIdOf(event),
      });
      return false;
    }

    const messageId = String(input.message.id ?? "");
    const roomId = input.roomId;
    const isSynthetic = isSyntheticTurn(input.message);
    const message: TurnMessage = { id: messageId, synthetic: isSynthetic, settles: Boolean(messageId) && !isSynthetic };
    // Preparing the turn awaits (a session's first turn hydrates its history), so a stop can land meanwhile.
    const stoppedWhilePreparing = stopModeOf(stopped);
    if (stoppedWhilePreparing) {
      return await this.settleUnstartedTurn(context, input, message, stoppedWhilePreparing, false);
    }

    if (message.settles) {
      await this.link.markProcessing(roomId, messageId, TURN_MARK);
    }

    if (!admitted()) return false;
    const stoppedBeforeStart = stopModeOf(stopped);
    if (stoppedBeforeStart) {
      return await this.settleUnstartedTurn(context, input, message, stoppedBeforeStart, true);
    }
    const lease = roomId === this.contactHubRoomId ? undefined : context.openWorkingCycle(
      (working, options) => this.link.reportActivity(roomId, working, options),
    );

    // History ids, not content: enough to tell what a cold-boot turn could recall.
    this.logger.debug("turn starting", {
      roomId,
      messageId,
      isSessionBootstrap: input.isSessionBootstrap,
      historyMessageIds: input.history.raw.map((entry) => entry.id),
    });
    const startedAt = Date.now();
    let succeeded = true;
    let caughtError: unknown;
    let started = false;
    let stopMode: TurnStopMode | null = null;
    try {
      await lease?.ready;
      if (!admitted()) return false;
      if (!stopped.aborted) {
        this.events.emit({ type: "turn.started", roomId, messageId });
        started = true;
        const tools = revokedOnStop(lease ? bindWorkingCycle(input.tools, lease) : input.tools, stopped);
        const turn = adapter.onEvent({ ...input, tools, holdRoomUntil });
        const cut = await untilStopped(
          turn,
          stopped,
          (error) => this.logger.debug("A stopped turn failed after the runtime stopped waiting on it", { roomId, messageId, error }),
        );
        stopMode = cut ? stopModeOf(stopped) : null;
        if (stopMode) {
          // An adapter that cannot cancel keeps working: no other turn starts in the room until it ends.
          holdRoomUntil(turn.then(() => undefined, () => undefined));
        }
      }
    } catch (error) {
      succeeded = false;
      caughtError = error;
    } finally {
      await lease?.end();
    }
    if (!started) {
      const stoppedAtStart = stopModeOf(stopped);
      return stoppedAtStart !== null && admitted() && await this.settleUnstartedTurn(context, input, message, stoppedAtStart, true);
    }
    // A turn that finished before the stop landed settles as usual.
    if (stopMode) {
      this.events.emit({ type: "turn.stopped", roomId, messageId, mode: stopMode });
      return admitted() && await this.settleCutShortMessage(context, message, stopMode);
    }
    this.events.emit(succeeded
      ? { type: "turn.completed", roomId, messageId }
      : { type: "turn.failed", roomId, messageId, error: turnFailureLabel(caughtError) });
    if (!admitted()) return false;
    this.logger.debug("turn finished", { roomId, messageId, succeeded, durationMs: Date.now() - startedAt });

    if (message.settles) {
      const decision = evaluateAdapterResult(roomId, messageId, succeeded);
      if (decision.decision === "processed") {
        await this.link.markProcessed(roomId, messageId, TURN_MARK);
      } else {
        await this.link.markFailed(roomId, messageId, turnFailureLabel(caughtError), TURN_MARK);
      }
    }

    if (!succeeded) {
      throw caughtError;
    }
    return false;
  }

  /**
   * A cut-short turn's message. A stopped one is forgotten, so it runs again
   * once the room resumes: Band serves its own message again, left
   * `processing`, and a synthetic one only this room holds is run again by
   * the room, which the `true` result asks for. An interrupted one is consumed.
   */
  private async settleCutShortMessage(context: ExecutionContext, message: TurnMessage, mode: TurnStopMode): Promise<boolean> {
    this.logger.info("turn cut short", { roomId: context.roomId, messageId: message.id, mode });
    if (mode === "stop") {
      if (message.id) context.forgetMessage(message.id);
      return message.synthetic;
    }
    if (message.settles) {
      await this.link.markProcessed(context.roomId, message.id, TURN_MARK);
    }
    return false;
  }

  /**
   * A turn cut short before the adapter saw it gives back what preparing it
   * took, so the next turn is prepared as this one was. Its message is
   * settled as a cut-short one; an interrupt claims it first when it was not.
   */
  private async settleUnstartedTurn(
    context: ExecutionContext,
    input: FrameworkAdapterInput,
    message: TurnMessage,
    mode: TurnStopMode,
    claimed: boolean,
  ): Promise<boolean> {
    context.returnTurnPreparation(input);
    if (mode === "interrupt" && message.settles && !claimed) {
      await this.link.markProcessing(context.roomId, message.id, TURN_MARK);
    }
    return await this.settleCutShortMessage(context, message, mode);
  }

  private async handleContactEvent(event: ContactEvent): Promise<void> {
    if (this.contactHandler) {
      await this.contactHandler.handle(event);
    }
  }
}
