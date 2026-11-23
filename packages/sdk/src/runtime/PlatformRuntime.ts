import { stat } from "node:fs/promises";
import { bindWorkingCycle } from "./workingState";
import { isSyntheticTurn, type FrameworkAdapter, type FrameworkAdapterInput, type Preprocessor } from "../contracts/protocols";
import { messageIdOf, type ContactEvent, type PlatformEvent } from "../platform/events";
import { BandLink, type BandLinkOptions } from "../platform/BandLink";
import { AgentRuntime } from "./rooms/AgentRuntime";
import { roomIdOf } from "./rooms/subscriptions";
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
import { RecoverableTurnError, RuntimeStateError, UnsupportedFeatureError, ValidationError } from "../core/errors";
import { DefaultPreprocessor } from "./preprocessing/DefaultPreprocessor";
import { toPlatformMessage } from "./formatters";
import { ContactEventHandler } from "./ContactEventHandler";
import { ExecutionContext, type ExecutionContextOptions } from "./ExecutionContext";
import type { RuntimeLifecycleState } from "./lifecycle";
import { LifecycleTracker, SingleFlight, isLegalRuntimeTransition, startWithGate, toLifecycleError } from "./lifecycle";
import { combineTeardownErrors, isolateTeardown } from "../core/teardown";
import { resolveLogger, type Logger } from "../core/logger";
import { scopeTurnTools } from "../core/turnScope";
import { turnFailureLabel } from "../core/coercion";
import { evaluateAdapterResult, isSelfEcho } from "@band-ai/band-sdk-core";
import type { AgentEventListener, TurnStopMode } from "../contracts/events";
import type { AgentControl, AgentControlMode } from "../platform/control";
import { ControlDeduplicator, controlTargets } from "./control";
import { untilStopped } from "../core/signals";
import { revokedOnStop } from "./turnRevocation";
import { AgentEventHub } from "./agentEvents";
import { journalingTools } from "./journal/journalTools";
import { deliveringMessages } from "./messageDelivery";
import type { MessageDelivery } from "../client/rest/messageDelivery";
import { bestEffort, GenerationClosedError, TurnJournal, type JournalGeneration } from "./journal/TurnJournal";
import { hasErrorCode, type RoomJournal, type UnresolvedPublication } from "./journal/RoomJournal";
import { PublicationEngine } from "./journal/publication";
import { canonicalPlatformIdentity } from "./journal/identity";

/** Trigger of the cleanup `stop()` that `start()` runs on its own failure path. */
const START_CLEANUP_TRIGGER = "start-failed";

export interface AllowRoomOptions {
  /** Start the room's agent process now, reporting `room.ready` or `room.failed`, rather than on its first message. */
  warm?: boolean;
}

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

/** How many room journals a start's recovery opens at once; the rest queue. */
const RECOVERY_SLOTS = 8;

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
  /** Set with `sessionConfig.journalDir`: the agent's identity-bound v2 journal, activated per start. */
  private readonly journals?: TurnJournal;
  /** The start in flight's journal generation: its rooms, the ownership it holds, and the publications it admitted. */
  private generation?: JournalGeneration;
  /**
   * The room admissions recovering a start open their journals at a bounded
   * pace: a platform admitting hundreds of rooms at once would otherwise open
   * hundreds of journal files in the same instant, and a start's recovery is
   * measured in descriptors, not just in outcomes.
   */
  private recoverySlots = RECOVERY_SLOTS;
  private readonly recoveryQueue: Array<() => void> = [];
  /** Each room's in-flight inbound message, if any: the publication the room's replies settle under. */
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
  /** Rooms the host allowed: handled even where `roomFilter` declines them. Kept across restarts. */
  private readonly allowedRooms = new Set<string>();
  /** Rooms the host asked to warm on allow; warmed when start or a running allow admits them. Kept across restarts. */
  private readonly warmRooms = new Set<string>();
  /** Rooms the host denied: paused with source `host` until allowed. Kept across restarts. */
  private readonly hostPausedRooms = new Set<string>();
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
    this.journals = this.sessionConfig.journalDir === undefined
      ? undefined
      : new TurnJournal(this.sessionConfig.journalDir, options.agentId, {
        logger: this.logger,
      });
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

  /** Whether the agent handles `room`: one the host allowed, else one `roomFilter` admits, else every room. */
  private admitsRoom(room: MetadataMap): boolean {
    const roomId = roomIdOf(room);
    if (roomId !== undefined && this.allowedRooms.has(roomId)) {
      return true;
    }
    return this._roomFilter?.(room) ?? true;
  }

  /**
   * Whether start's existing-room hydration should subscribe to `room` now.
   * Declined by `roomFilter`, or pending a warm allow, are admitted later by
   * `admitAllowedMemberRooms` (and warmed there when requested). Reconnect
   * still uses {@link admitsRoom}.
   */
  private listsRoomOnStart(room: MetadataMap): boolean {
    const roomId = roomIdOf(room);
    if (roomId !== undefined && this.warmRooms.has(roomId)) {
      return false;
    }
    return this._roomFilter?.(room) ?? true;
  }

  /**
   * Lets the agent handle `roomId` again, for the host: lifts the pause
   * `denyRoom` put on it, and admits it even where `roomFilter` declines it,
   * at once if Band lists the agent in it, otherwise when Band adds the agent.
   * The allow sticks as a filter override for this runtime; a later deny
   * pauses turns but leaves that override. With `warm`, a member room has its
   * agent process started when start (or a running `allow`) admits it, and
   * `room.ready` or `room.failed` is reported before the room joins. A warm
   * allow before or during start is kept until that admission; a room Band
   * has not listed the agent in yet is not warmed, and a later `room_added`
   * admit starts its process on the first message. A pause Band put on the
   * room stays until Band plays it. A room whose session a reset replaced
   * replays what Band kept on its next message, as a play does. Kept across
   * restarts of this runtime. Resolves true when the room is admitted on return.
   */
  public async allowRoom(roomId: string, options: AllowRoomOptions = {}): Promise<boolean> {
    this.allowedRooms.add(roomId);
    if (options.warm) {
      this.warmRooms.add(roomId);
    }
    if (this.hostPausedRooms.delete(roomId)) {
      this.runtime?.resumeRoom(roomId, "host");
      this.events.emit({ type: "room.resumed", roomId, source: "host" });
    }
    const runtime = this.runtime;
    // A runtime still starting admits it once its start-up has listed its rooms.
    if (runtime?.state.status === "running") {
      await this.admitAllowedMemberRooms(runtime, new Set([roomId]));
      const adapter = this.activeAdapter;
      if (runtime.presence.isAdmitted(roomId) && this.warmRooms.delete(roomId) && adapter) {
        await this.warmRoom(adapter, roomId);
      }
    }
    // Whatever runtime there is now: a stop meanwhile left none, a restart its own admission.
    return this.runtime?.presence.isAdmitted(roomId) ?? false;
  }

  /** Starts the room's agent; reports `room.ready` with what it said about itself, or `room.failed` once whether or not the adapter did. */
  private async warmRoom(adapter: FrameworkAdapter, roomId: string): Promise<void> {
    if (!adapter.warmRoom) {
      this.events.emit({ type: "room.ready", roomId, agent: null });
      return;
    }
    let reported = false;
    const unobserve = this.events.observe((event) => {
      if (event.type === "room.failed" && event.roomId === roomId) reported = true;
    });
    try {
      const agent = await adapter.warmRoom(roomId);
      this.events.emit({ type: "room.ready", roomId, agent });
    } catch (error) {
      if (!reported) {
        this.events.emit({ type: "room.failed", roomId, error: turnFailureLabel(error) });
      }
    } finally {
      unobserve();
    }
  }

  /**
   * Stops the agent taking turns in `roomId`, for the host: pauses it with
   * source `host`, cutting its running turn short and leaving its messages
   * on Band, until `allowRoom`. The room stays subscribed and keeps its
   * session; a room not yet admitted starts paused when it is. Does not drop
   * an earlier allow's filter override. Band is not told, and the pause lasts
   * only as long as this runtime object. Resolves true when it paused a room
   * the agent handles.
   */
  public async denyRoom(roomId: string): Promise<boolean> {
    if (this.hostPausedRooms.has(roomId)) {
      return false;
    }
    this.hostPausedRooms.add(roomId);
    this.events.emit({ type: "room.paused", roomId, source: "host" });
    const runtime = this.runtime;
    const adapter = this.activeAdapter;
    if (!runtime) {
      return false;
    }
    runtime.pauseRoom(roomId, "host");
    if (adapter) {
      this.cancelAdapterTurn(adapter, roomId);
    }
    return runtime.presence.isAdmitted(roomId);
  }

  /**
   * Admits each of `roomIds` the agent is a member of, unless it is already
   * handled. Best-effort, as start-up's own listing is: a room it cannot list
   * now is admitted when Band adds the agent to it.
   */
  private async admitAllowedMemberRooms(runtime: AgentRuntime, roomIds: ReadonlySet<string>): Promise<void> {
    const pending = new Set<string>();
    for (const roomId of roomIds) {
      if (!runtime.presence.isAdmitted(roomId)) {
        pending.add(roomId);
      }
    }
    if (pending.size === 0) {
      return;
    }
    let members: Map<string, MetadataMap>;
    try {
      members = await runtime.presence.memberRooms(pending);
    } catch (error: unknown) {
      if (!(error instanceof UnsupportedFeatureError)) {
        this.logger.warn("Failed to list the rooms the host allowed; admitting them on the next reconnect, restart or allow, or when Band adds the agent", { rooms: pending.size, error });
      }
      // Abandon warm: a later reconnect or room_added admit starts the process
      // on the first message, as a non-warm room would.
      for (const roomId of pending) {
        this.warmRooms.delete(roomId);
      }
      return;
    }
    const adapter = this.activeAdapter;
    for (const [roomId, payload] of members) {
      // A stop since the listing owns the room now.
      if (this.runtime !== runtime) {
        return;
      }
      if (this.warmRooms.delete(roomId) && adapter) {
        await this.warmRoom(adapter, roomId);
      }
      await runtime.presence.admitRoom(roomId, payload);
    }
    for (const roomId of roomIds) {
      if (!runtime.presence.isAdmitted(roomId)) {
        this.warmRooms.delete(roomId);
      }
    }
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
   * The platform identity this start's journal generation binds its rooms to.
   * A standard link's identity is the canonical form of its REST endpoint; a
   * custom REST adapter's URL cannot stand for the platform, so the deployment
   * must name one in `sessionConfig.journalPlatformIdentity`. An explicit value
   * that names a different platform than the link speaks to refuses the start:
   * binding the journal to the wrong platform would let a restart under another
   * deployment replay this one's replies as unsettled.
   */
  private journalIdentity(): string {
    const link = this.link;
    const explicit = this.sessionConfig.journalPlatformIdentity;
    if (link.customRestAdapter) {
      if (explicit === undefined) {
        throw new ValidationError(
          "sessionConfig.journalPlatformIdentity is required when sessionConfig.journalDir is set and the runtime speaks to the platform through a custom REST adapter; the journal's records are bound to a platform identity, and the adapter's URL cannot name one",
        );
      }
      return explicit;
    }
    const identity = canonicalPlatformIdentity(link.restUrl);
    if (explicit !== undefined && explicit !== identity) {
      throw new ValidationError(
        `sessionConfig.journalPlatformIdentity (${explicit}) names a different platform than the link speaks to (${identity}); the journal binds its records to one platform, so start with one or the other`,
      );
    }
    return identity;
  }

  /**
   * The room's execution context: the user's factory, or the default, run over
   * the start generation's publication engine. Each turn runs on the tools the
   * preprocessor gave it, inside the turn's inbound scope: a reply settles
   * durably under the message it answers.
   */
  private contextWithJournal(roomId: string, defaults: ExecutionContextOptions): ExecutionContext {
    const generation = this.generation;
    const extended: ExecutionContextOptions = {
      ...defaults,
      publication: generation
        ? PublicationEngine.create({
            // The room's authority, as it stands: a journal that will not open
            // fails the reply rather than deliver it unjournaled, a closed
            // generation refuses it, and a handle that opened but no longer
            // admits records refuses it as poisoned. Only a runtime that never
            // configured the journal posts without one.
            room: () => generation.room(roomId),
            generation,
            logger: this.logger,
          })
        : undefined,
    };
    return this._contextFactory ? this._contextFactory(roomId, extended) : new ExecutionContext(extended);
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
    // The generation this start activates, if any: its cleanup must release that
    // generation alone, never whatever a successor has since installed in the slot.
    const own: { generation?: JournalGeneration } = {};

    try {
      await this.doStart(adapter, startState, own);
    } catch (error) {
      // A superseded start owns nothing, and a cleanup that already reached a
      // terminal state keeps its own outcome.
      if (this.lifecycle.isCurrent(startState)) {
        this.lifecycle.fail(error, START_CLEANUP_TRIGGER);
      } else if (own.generation !== undefined && this.generation === own.generation) {
        // The superseding stop's generation close may have run before this
        // start activated its generation; if the slot still holds this start's
        // own generation, it gives back its rooms and ownership here rather
        // than leaking them past a successor.
        await this.closeGeneration();
      }
      throw error;
    }

    if (this.lifecycle.isCurrent(startState)) {
      this.lifecycle.transition({ status: "running" }, "started");
    }
  }

  private async doStart(adapter: FrameworkAdapter, startState: RuntimeLifecycleState, own: { generation?: JournalGeneration }): Promise<void> {
    const assertNotSuperseded = (): void => {
      if (!this.lifecycle.isCurrent(startState)) {
        throw new RuntimeStateError("PlatformRuntime start was superseded by stop()");
      }
    };

    await this.initialize();
    assertNotSuperseded();
    // The journal's ownership is taken before the adapter starts: every room this start
    // serves writes under it, and a start that takes it and then fails gives it back on
    // its cleanup, so a successor start never finds a stale owner.
    if (this.journals) {
      this.generation = await this.journals.activate(this.journalIdentity());
      own.generation = this.generation;
    }
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
        onRoomAdmitted: (roomId) => {
          this.events.emit({ type: "room.joined", roomId });
          // A room that reopens reports what its journal stands unresolved
          // whether or not Band serves it another message: the report does not
          // ride on an inbound that may never come.
          void this.announceUnresolvedForRoom(roomId).catch((error: unknown) => {
            this.logger.warn("Failed to announce a reopened room's unresolved publications", { roomId, error });
          });
        },
        onRoomRemoved: (roomId) => this.events.emit({ type: "room.left", roomId }),
        onRoomStopped: (roomId) => {
          this.releaseJournal(roomId);
          this.events.emit({ type: "room.stopped", roomId });
        },
        onMissedPlay: (roomId) => this.playBand(roomId),
        onBandStopCleared: (roomId) => this.reportBandResumed(roomId),
        onExecute: (context, event, admitted, holdRoomUntil, stopped) => this.executeAdapter(context, event, adapter, admitted, holdRoomUntil, stopped),
        isControlEvent: (event) => this.isControlEvent(adapter, event),
        onSessionCleanup: (roomId) => adapter.onCleanup(roomId),
        onContactEvent: (event) => this.handleContactEvent(event),
        onParticipantAdded: this._onParticipantAdded,
        onParticipantRemoved: this._onParticipantRemoved,
        roomFilter: (room) => this.admitsRoom(room),
        listingRoomFilter: (room) => this.listsRoomOnStart(room),
        contextFactory: (roomId, defaults) => this.contextWithJournal(roomId, defaults),
      });
      for (const roomId of this.hostPausedRooms) {
        this.runtime.pauseRoom(roomId, "host");
      }

      await this.runtime.start();
      assertNotSuperseded();
      // Start-up listed its rooms before any allow made while it ran.
      await this.admitAllowedMemberRooms(this.runtime, this.allowedRooms);
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
        // A start may have activated the journal generation before it failed.
        await this.closeGeneration();
        throw this.lifecycle.state.error;
      }
      // "running" never reaches here: state only becomes "running" in runStart()
      // after `runtime`/`activeAdapter` are already assigned, which the guard
      // above (`!runtime && !adapter`) rules out.
      if (this.lifecycle.is("starting")) {
        this.lifecycle.transition({ status: "stopped" }, trigger);
      }
      // A start superseded mid-initialization may have activated the generation already.
      await this.closeGeneration();
      return true;
    }

    this.lifecycle.transition({ status: "stopping" }, trigger);
    this.runtime = undefined;
    this.contactHandler = undefined;
    this.contactsSubscribed = false;
    this.activeAdapter = undefined;

    const stopOutcome: { graceful?: boolean } = {};
    const errors: unknown[] = [];

    if (runtime) {
      // Quiesce, not tear down: the rooms stop taking turns (and the stop may
      // time out on them), but the platform connection stays up. A stop that
      // timed out can still owe its generation's in-flight posts their
      // transport; disconnecting first would turn their outcomes from
      // "accepted" into "unknown". The connection goes down only after the
      // drain below, with `finishStop`.
      await isolateTeardown(errors, async () => {
        const outcome = await runtime.quiesce(timeoutMs);
        stopOutcome.graceful = outcome.graceful;
        if (outcome.error !== null) {
          errors.push(outcome.error);
        }
      });
    }

    await isolateTeardown(errors, () => Promise.resolve(adapter?.onRuntimeStop?.()));

    // The start generation's publications run to their durable outcomes before
    // its ownership releases: the state stays "stopping" (a new start is
    // refused, and ownership is held) while its last posts complete, so a stop
    // that timed out on the rooms' work still lands every admitted reply's
    // outcome on disk before the journal is closed and the connection drops.
    const generation = this.generation;
    if (generation) {
      if (stopOutcome.graceful === false) {
        this.logger.info("The stop timed out; draining the start generation's in-flight publications before releasing its journal", {
          agentId: this._agentId,
        });
      }
      await isolateTeardown(errors, () => generation.drain());
      await isolateTeardown(errors, () => generation.close());
      this.generation = undefined;
    }

    if (runtime) {
      // Only now does the platform connection go down: every publication the
      // generation admitted has run to its durable outcome, so the disconnect
      // cannot orphan a post or a receipt still owed.
      await isolateTeardown(errors, () => runtime.finishStop());
    }
    // The relay stops only after the disconnect above: observers must still
    // receive the final `link.disconnected`.
    this.unobserveLink();

    if (errors.length > 0) {
      throw this.recordStopFailure(
        combineTeardownErrors(errors, "PlatformRuntime stop failed and adapter cleanup also failed"),
      );
    }

    this.lifecycle.transition({ status: "stopped" }, "stopped");
    return stopOutcome.graceful !== false;
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

    const isSynthetic = isSyntheticTurn(input.message);
    const message: TurnMessage = { id: String(input.message.id ?? ""), synthetic: isSynthetic, settles: Boolean(input.message.id) && !isSynthetic };
    // A turn that settles a message holds the room's journal open for its whole run,
    // including the end it records: a release that lands meanwhile — a room reopening
    // beside it, the runtime stopping — defers the room's close until the turn's hold
    // ends, so the turn never writes to a handle that is going away.
    const journalGeneration = message.settles ? this.generation : undefined;
    if (journalGeneration) journalGeneration.holdRoom(context.roomId);
    try {
      return await this.runTurn(context, input, adapter, message, admitted, holdRoomUntil, stopped);
    } finally {
      if (journalGeneration) {
        await journalGeneration.endHoldRoom(context.roomId);
      }
    }
  }

  private async runTurn(
    context: ExecutionContext,
    input: FrameworkAdapterInput,
    adapter: FrameworkAdapter,
    message: TurnMessage,
    admitted: () => boolean,
    holdRoomUntil: (ended: Promise<void>) => void,
    stopped: AbortSignal,
  ): Promise<boolean> {
    const roomId = input.roomId;
    const messageId = message.id;
    // Not for a turn already cut short: it would open the journal of a room whose handling may have stopped.
    let journal: RoomJournal | undefined;
    if (message.settles && !stopped.aborted) {
      try {
        journal = await this.openJournal(roomId);
      } catch (error) {
        // The generation closed while the journal opened: the turn is cut short,
        // as if the stop had landed before it started.
        if (error instanceof GenerationClosedError) {
          return await this.settleUnstartedTurn(context, input, message, stopModeOf(stopped) ?? "stop", false, undefined);
        }
        // A configured journal that will not open fails the turn before its
        // adapter runs: nothing is delivered unjournaled. The turn never
        // started, so its end is not recorded and what preparing it consumed
        // is given back — the next turn is prepared as this one was, and a
        // session's first turn still bootstraps. The message settles failed,
        // and the runtime keeps serving the rooms whose journals stand.
        const reason = error instanceof Error ? error.message : String(error);
        const label = `The room's turn journal will not open, so the turn failed rather than answer unjournaled: ${reason}`;
        this.events.emit({ type: "turn.failed", roomId, messageId, error: label });
        context.returnTurnPreparation(input);
        if (message.settles) {
          await this.link.markFailed(roomId, messageId, label, TURN_MARK);
        }
        throw new RecoverableTurnError(label, error);
      }
    }
    if (journal) {
      await this.announceUnresolvedPublications(journal, roomId);
    }
    // Preparing the turn awaits (a session's first turn hydrates its history), so a stop can land meanwhile.
    const stoppedWhilePreparing = stopModeOf(stopped);
    if (stoppedWhilePreparing) {
      return await this.settleUnstartedTurn(context, input, message, stoppedWhilePreparing, false, journal);
    }
    if (journal && (await this.settleEndedInbound(journal, roomId, messageId))) {
      // Nothing ran, so the next turn is prepared as this one was.
      context.returnTurnPreparation(input);
      return false;
    }

    if (message.settles) {
      await this.link.markProcessing(roomId, messageId, TURN_MARK);
    }

    if (!admitted()) return false;
    const stoppedBeforeStart = stopModeOf(stopped);
    if (stoppedBeforeStart) {
      return await this.settleUnstartedTurn(context, input, message, stoppedBeforeStart, true, journal);
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
    // The adapter handed the turn's reply to work that outlives it (a decision wait).
    let detached = false;
    try {
      await lease?.ready;
      if (!admitted()) return false;
      if (!stopped.aborted) {
        this.events.emit({ type: "turn.started", roomId, messageId });
        started = true;
        // The turn's tools, as the host composed them: the preprocessor's
        // composition is not replaced. A reply settles under this turn's
        // inbound through the turn's scope — one the turn's work keeps when it
        // is handed off and outlives the turn — never under whatever the room
        // is turning to next.
        const cycled = lease ? bindWorkingCycle(input.tools, lease) : input.tools;
        // The turn's own side of the runtime's publications: a reply the turn
        // lost is refused at its call, and a delivery-unknown fences this
        // turn's closing text, never a successor's.
        const journaled = journalingTools(cycled, stopped, this.logger);
        const delivering = message.settles
          ? deliveringMessages(journaled, this.messageDelivery(context, input, stopped))
          : journaled;
        // The turn's origin stands on the tools themselves: a call that
        // reaches them through a long-lived transport — an MCP bridge a turn
        // opened, a server that outlives its turns — or from outside the
        // turn's async context at all — a channel callback, direct work, a
        // handoff that outlives the turn — runs in the scope of the turn
        // that composed the tools it reached, and settles under that turn's
        // inbound. Never under the context the call was created in, and
        // never under whatever the room is turning to next.
        const tools = scopeTurnTools(
          revokedOnStop(delivering, stopped),
          message.settles ? messageId : undefined,
        );
        // The turn's replies refuse to post if the turn is cut short while one is in flight.
        context.setPublicationStop(stopped);
        const turn = adapter.onEvent({
          ...input,
          tools,
          holdRoomUntil: (ended) => {
            detached = true;
            holdRoomUntil(ended);
          },
        });
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
      context.setPublicationStop(undefined);
      await lease?.end();
    }
    if (!started) {
      const stoppedAtStart = stopModeOf(stopped);
      return stoppedAtStart !== null && admitted() && await this.settleUnstartedTurn(context, input, message, stoppedAtStart, true, journal);
    }
    // A turn that finished before the stop landed settles as usual.
    if (stopMode) {
      this.events.emit({ type: "turn.stopped", roomId, messageId, mode: stopMode });
      return admitted() && await this.settleCutShortMessage(context, message, stopMode, journal);
    }
    this.events.emit(succeeded
      ? { type: "turn.completed", roomId, messageId }
      : { type: "turn.failed", roomId, messageId, error: turnFailureLabel(caughtError) });
    if (!admitted()) return false;
    this.logger.debug("turn finished", { roomId, messageId, succeeded, durationMs: Date.now() - startedAt });

    if (message.settles) {
      const decision = evaluateAdapterResult(roomId, messageId, succeeded);
      if (decision.decision === "processed") {
        // Recorded first, so a restart before the mark below does not answer it again. Not for a
        // detached turn, whose reply may not have posted yet: it runs again, as without the journal.
        if (!detached) await this.recordTurnDone(journal, roomId, messageId);
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
   * What the turn's message posts settle under: read back after its trigger,
   * past the room's credited posts. A session's first turn credits the own
   * posts its history holds, so one an earlier process made is never taken
   * for this turn's reply.
   */
  private messageDelivery(context: ExecutionContext, input: FrameworkAdapterInput, stopped: AbortSignal): MessageDelivery {
    if (input.isSessionBootstrap) {
      for (const entry of input.history.raw) {
        if (entry.sender_id === this._agentId && typeof entry.id === "string") context.attributedPosts.add(entry.id);
      }
    }
    return {
      selfId: this._agentId,
      anchor: { id: String(input.message.id), createdAt: input.message.createdAt },
      attributed: context.attributedPosts,
      stopped,
    };
  }

  /**
   * A cut-short turn's message. A stopped one is forgotten, so it runs again
   * once the room resumes: Band serves its own message again, left
   * `processing`, and a synthetic one only this room holds is run again by
   * the room, which the `true` result asks for. An interrupted one is consumed.
   */
  private async settleCutShortMessage(
    context: ExecutionContext,
    message: TurnMessage,
    mode: TurnStopMode,
    journal: RoomJournal | undefined,
  ): Promise<boolean> {
    this.logger.info("turn cut short", { roomId: context.roomId, messageId: message.id, mode });
    if (mode === "stop") {
      if (message.id) context.forgetMessage(message.id);
      return message.synthetic;
    }
    if (message.settles) {
      await this.recordTurnDone(journal, context.roomId, message.id);
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
    journal: RoomJournal | undefined,
  ): Promise<boolean> {
    context.returnTurnPreparation(input);
    if (mode === "interrupt" && message.settles && !claimed) {
      await this.link.markProcessing(context.roomId, message.id, TURN_MARK);
    }
    return await this.settleCutShortMessage(context, message, mode, journal);
  }

  /**
   * The room's turn journal. A configured journal that will not open — corrupt,
   * unreadable, or refused — rejects so the turn fails rather than run
   * unjournaled; only a runtime with no generation posts without one.
   */
  private async openJournal(roomId: string): Promise<RoomJournal | undefined> {
    if (!this.generation) return undefined;
    return await this.generation.room(roomId);
  }

  /**
   * Records that a turn ended, before its message is marked processed. A
   * failed write is logged and the mark goes ahead: it is the mark that
   * settles the message, and a lost record only lets a restart answer it again.
   */
  private async recordTurnDone(journal: RoomJournal | undefined, roomId: string, messageId: string): Promise<void> {
    if (!journal) return;
    if (!journal.accepting) {
      // The room's journal is closed (its handling stopped) or no longer admits records
      // (it owed an outcome it could not write); the mark below settles the message
      // as it would without the journal.
      this.logger.debug("Not recording a turn's end: its room's journal is closed or no longer admits records", { roomId, messageId });
      return;
    }
    await bestEffort(() => journal.turnDone(messageId), this.logger, "Failed to record a turn's end in the turn journal", { roomId, messageId });
  }

  /**
   * Closes a room's journal once its handling stopped, so a left room holds no
   * file open. Forced while the runtime is running: a turn still settling in
   * the room must not write to the released journal. During stop, the generation
   * drains then closes — force-closing here would race publications still
   * admitting under beginReply before trackInflight.
   */
  private releaseJournal(roomId: string): void {
    void bestEffort(async () => {
      const status = this.state.status;
      if (status === "stopping" || status === "stopped") return;
      await this.generation?.release(roomId, true);
    }, this.logger, "Failed to close a room's turn journal", { roomId });
  }

  /**
   * Before a turn starts. A message whose turn the journal shows ended was
   * answered before a restart that beat its processed mark: it is claimed and
   * marked processed, and not answered again. Resolves true when it was.
   */
  private async settleEndedInbound(journal: RoomJournal, roomId: string, messageId: string): Promise<boolean> {
    if (!journal.answered(messageId)) return false;
    this.logger.info("Message answered before a restart; marking it processed without a turn", { roomId, messageId });
    await this.link.markProcessing(roomId, messageId, TURN_MARK);
    await this.link.markProcessed(roomId, messageId, TURN_MARK);
    return true;
  }

  /**
   * The room's publications whose delivery stands unresolved (admitted with no
   * recorded outcome, or recorded as unknown) and that no earlier open of this
   * generation announced: announced now, each emitted as `delivery.unrecorded`
   * — Band may already hold those replies — and recorded so no later open
   * announces them again.
   */
  private async announceUnresolvedPublications(journal: RoomJournal, roomId: string): Promise<void> {
    let unresolved: UnresolvedPublication[];
    try {
      unresolved = await journal.recoverUnresolved();
    } catch (error) {
      this.logger.warn("Failed to recover the room's unresolved publications; they will be announced again on its next open", { roomId, error });
      return;
    }
    for (const publication of unresolved) {
      this.events.emit({ type: "delivery.unrecorded", roomId, messageId: publication.messageId });
    }
  }

  /**
   * Announces what a room's journal stands unresolved when the room comes
   * back: the report rides on the room's admission, not on an inbound that
   * may never come, and is independent of whether its earlier inbounds
   * settled. A room without a journal, or one that cannot be opened, announces
   * nothing.
   */
  private async announceUnresolvedForRoom(roomId: string): Promise<void> {
    const generation = this.generation;
    if (!generation) return;
    // A room whose journal does not stand has nothing to recover: admission must
    // not create the file, and one that stands opens through the generation, so a
    // turn running in the room shares the same handle rather than a second one.
    const file = generation.roomPath(roomId);
    const stands = stat(file).then(
      () => true,
      (error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) return false;
        throw error;
      },
    );
    if (!(await stands)) return;
    await this.withRecoverySlot(async () => {
      const journal = await generation.room(roomId);
      try {
        await this.announceUnresolvedPublications(journal, roomId);
      } finally {
        // An idle room holds no file open: the handle is released once its
        // publications stand reported, and a turn running in the room reopens it.
        await generation.release(roomId).catch(() => undefined);
      }
    });
  }

  /** Runs `work` with at most {@link RECOVERY_SLOTS} room recoveries open at once. */
  private async withRecoverySlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.recoverySlots <= 0) {
      await new Promise<void>((resolve) => this.recoveryQueue.push(resolve));
    }
    this.recoverySlots -= 1;
    try {
      return await work();
    } finally {
      this.recoverySlots += 1;
      this.recoveryQueue.shift()?.();
    }
  }

  /**
   * Closes the start generation: its in-flight publications, its rooms, then
   * the ownership those held. A failed close falls back like every other
   * journal failure: it is logged, never the stop's failure.
   */
  private async closeGeneration(): Promise<void> {
    const generation = this.generation;
    if (!generation) return;
    this.generation = undefined;
    await bestEffort(async () => {
      await generation.drain();
      await generation.close();
    }, this.logger, "Failed to close the start generation's journal", { agentId: this._agentId });
  }

  private async handleContactEvent(event: ContactEvent): Promise<void> {
    if (this.contactHandler) {
      await this.contactHandler.handle(event);
    }
  }
}
