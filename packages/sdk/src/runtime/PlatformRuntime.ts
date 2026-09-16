import type { FrameworkAdapter, Preprocessor } from "../contracts/protocols";
import type { ContactEvent, PlatformEvent } from "../platform/events";
import { BandLink, type BandLinkOptions } from "../platform/BandLink";
import { AgentRuntime } from "./rooms/AgentRuntime";
import type { AgentConfig, ContactEventConfig, SessionConfig } from "./types";
import type { PlatformMessage } from "./types";
import { SYNTHETIC_SENDER_TYPE, SYNTHETIC_CONTACT_EVENTS_SENDER_ID } from "./types";
import type { ParticipantRecord, MetadataMap } from "../contracts/dtos";
import { RuntimeStateError, ValidationError } from "../core/errors";
import { DefaultPreprocessor } from "./preprocessing/DefaultPreprocessor";
import { ContactEventHandler } from "./ContactEventHandler";
import type { ExecutionContext, ExecutionContextOptions } from "./ExecutionContext";
import type { RuntimeLifecycleState } from "./lifecycle";
import { LifecycleTracker, SingleFlight, isLegalRuntimeTransition, startWithGate, toLifecycleError } from "./lifecycle";
import { combineTeardownErrors, isolateTeardown } from "../core/teardown";
import { resolveLogger, type Logger } from "../core/logger";

/** Upper bound core's `RetryTracker` accepts for `maxRetries` (u32::MAX). */
export const MAX_MESSAGE_RETRIES = 4_294_967_295;

const isValidRetryCount = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= MAX_MESSAGE_RETRIES;

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

export class PlatformRuntime implements AsyncDisposable {
  private readonly _agentId: string;
  private readonly _apiKey: string;
  private readonly _wsUrl?: string;
  private readonly _restUrl?: string;
  private readonly preprocessor: Preprocessor<PlatformEvent>;
  private readonly sessionConfig?: SessionConfig;
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

    // RetryTracker rejects these too, but only once a room's ExecutionContext
    // is built mid-run — too late to be actionable.
    const maxMessageRetries = options.sessionConfig?.maxMessageRetries;
    if (maxMessageRetries !== undefined && !isValidRetryCount(maxMessageRetries)) {
      throw new ValidationError(
        `sessionConfig.maxMessageRetries must be an integer between 0 and ${MAX_MESSAGE_RETRIES}, got ${maxMessageRetries}.`,
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
    this.sessionConfig = options.sessionConfig;
    this.contactConfig = options.contactConfig;
    this.agentConfig = options.agentConfig;
    this.logger = resolveLogger(options.logger);
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

    if (this.configuredIdentity) {
      this._agentName = this.configuredIdentity.name;
      this._agentDescription = this.configuredIdentity.description ?? "";
      return;
    }

    const me = await this.link.rest.getAgentMe();
    this._agentName = me.name;
    this._agentDescription = me.description ?? "";
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
    // Claimed before `onStarted` so a stop() landing mid-startup still owes this
    // adapter its `onRuntimeStop` — several adapters only abort a hung startup
    // when that hook runs.
    this.activeAdapter = adapter;

    try {
      await adapter.onStarted(this._agentName, this._agentDescription);
      assertNotSuperseded();

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
        onExecute: (context, event) => this.executeAdapter(context, event, adapter),
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

  private async executeAdapter(
    context: ExecutionContext,
    event: PlatformEvent,
    adapter: FrameworkAdapter,
  ): Promise<void> {
    const input = await this.preprocessor.process(context, event, this._agentId);
    if (!input) {
      return;
    }

    const messageId = String(input.message.id ?? "");
    const roomId = input.roomId;
    const isSynthetic = input.message.senderType === SYNTHETIC_SENDER_TYPE
      && input.message.senderId === SYNTHETIC_CONTACT_EVENTS_SENDER_ID;
    const messageMarkOptions = { bestEffort: true } as const;

    if (messageId && !isSynthetic) {
      await this.link.markProcessing(roomId, messageId, messageMarkOptions);
    }

    try {
      await adapter.onEvent(input);
      if (messageId && !isSynthetic) {
        await this.link.markProcessed(roomId, messageId, messageMarkOptions);
      }
    } catch (error) {
      const label = error instanceof Error ? error.message : String(error);
      if (messageId && !isSynthetic) {
        await this.link.markFailed(roomId, messageId, label, messageMarkOptions);
      }
      throw error;
    }
  }

  private async handleContactEvent(event: ContactEvent): Promise<void> {
    if (this.contactHandler) {
      await this.contactHandler.handle(event);
    }
  }
}
