import { Socket, type Channel, type SocketOptions } from "phoenix";
import { RuntimeStateError, TransportError } from "../../core/errors";
import { notifyEach } from "../../core/listeners";
import { resolveLogger, type Logger } from "../../core/logger";
import { combineTeardownErrors, isolateTeardown } from "../../core/teardown";
import { Serializer, SingleFlight } from "../../core/singleFlight";
import { createDeferred, type Deferred } from "../../core/deferred";
import { Epoch } from "../../core/epoch";
import { eitherSignal } from "../../core/signals";
import { ChannelRegistry, supersededJoinError } from "./ChannelRegistry";
import {
  WebSocketDisconnectError,
  type CloseEventLike,
  controlJoinFailedReason,
  parseSupersedeDisconnectReason,
  parseUpgradeDisconnectReason,
  type WebSocketConflictPolicy,
  type WebSocketDisconnectReason,
} from "./disconnectReason";
import { createNodeWebSocketFactory } from "./nodeWebSocketFactory";
import { ReconnectGenerationTracker } from "./ReconnectGenerationTracker";
import { Deadline, MAX_SETTIMEOUT_DELAY_MS, MS_PER_SECOND } from "../../core/deadline";
import { ENDED_VERDICT, SessionRun } from "./sessionRun";
import {
  isOptionalTopic,
  type JoinOptions,
  type DropObserver,
  type ReconnectObserver,
  type ReconnectSnapshot,
  type StreamingTransport,
  type TerminalObserver,
  type TopicHandlers,
  type TopicRejoinObserver,
} from "./transport";
import { SessionPolicy, agentControlTopic } from "@band-ai/band-sdk-core";

/** How long a boot `connect()` waits for an attempt to succeed while Session keeps retrying. */
export const BOOT_CONNECT_DEADLINE_MS = 300_000;

interface BufferedTopicEvent {
  topic: string;
  deliver: () => void;
}

interface PhoenixChannelsTransportOptions {
  wsUrl: string;
  apiKey: string;
  agentId?: string;
  logger?: Logger;
  /** Reconnect and heartbeat policy; core's default unless a test scales it. */
  sessionPolicy?: SessionPolicy;
  websocketFactory?: typeof WebSocket;
  conflictPolicy?: WebSocketConflictPolicy;
}

export class PhoenixChannelsTransport implements StreamingTransport {
  private readonly socket: GatedSocket;
  /** The mandatory per-agent channel, when the transport is for an agent. */
  private readonly controlTopic: string | null;
  private readonly registry: ChannelRegistry;
  private readonly reconnectObservers = new Set<ReconnectObserver>();
  private readonly topicRejoinObservers = new Set<TopicRejoinObserver>();
  private readonly dropObservers = new Set<DropObserver>();
  private readonly generationTracker = new ReconnectGenerationTracker(
    (snapshot) => this.notifyReconnectObservers(snapshot),
    (generation, pendingTopics) =>
      this.logger.debug("Superseded reconnect generation before it fully settled", {
        generation,
        pendingTopics,
      }),
  );
  private readonly bufferedTopicEvents: BufferedTopicEvent[] = [];
  private hasOpenedOnce = false;
  private readonly epoch = new Epoch();
  private bufferingGeneration: number | null = null;
  private reconnectBarrier: Deferred<void> | null = null;
  private readonly observerChain = new Serializer();
  private readonly logger: Logger;
  private readonly terminalObservers = new Set<TerminalObserver>();
  private onHandlerError?: (error: unknown) => void;
  private readonly connectFlight = new SingleFlight<void>();
  private readonly disconnectFlight = new SingleFlight<void>();
  private readonly policy: SessionPolicy;
  /** The latest run; everything scoped to a run or its connection lives on it. */
  private run: SessionRun | null = null;
  /** Aborted for good with the first terminal `WebSocketDisconnectError`. */
  private readonly terminal = new AbortController();

  public constructor(options: PhoenixChannelsTransportOptions) {
    this.logger = resolveLogger(options.logger);
    this.controlTopic = options.agentId ? agentControlTopic(options.agentId) : null;

    // The phoenix JS library appends /websocket to the endpoint URL.
    // Strip it if the user-provided URL already includes it.
    let wsUrl = options.wsUrl;
    if (wsUrl.endsWith("/websocket")) {
      wsUrl = wsUrl.slice(0, -"/websocket".length);
    }

    const policy = options.sessionPolicy ?? SessionPolicy.default();
    this.policy = policy;
    this.socket = new GatedSocket(wsUrl, {
      params: {
        ...(options.agentId ? { agent_id: options.agentId } : {}),
        ...(options.conflictPolicy
          ? { on_conflict: options.conflictPolicy }
          : {}),
      },
      heartbeatIntervalMs: policy.heartbeatIntervalS * MS_PER_SECOND,
      reconnectAfterMs: () => this.nextAttemptDelayMs(),
      transport:
        options.websocketFactory ?? resolveWebSocketFactory(options.apiKey),
    }, {
      beforeAttempt: () => this.run?.beginAttempt() ?? false,
      onSocketClose: (event) => this.handleSocketClose(event),
    }, this.logger);

    this.registry = new ChannelRegistry(this.socket, this.epoch, this.logger, {
      wrapHandler: (topic, event, handler, options) => (payload) => {
        const reportError = (error: unknown): void => {
          this.logger.error("Unhandled topic handler error", { topic, event, error });
          this.onHandlerError?.(error);
        };
        const deliver = (): void => {
          try {
            void Promise.resolve(handler(payload)).catch(reportError);
          } catch (error) {
            reportError(error);
          }
        };

        if (this.bufferingGeneration !== null && !options.exemptFromBuffering) {
          this.bufferedTopicEvents.push({ topic, deliver });
        } else {
          deliver();
        }
      },
      onJoinSettled: (topic, joined) => this.handleJoinSettled(topic, joined),
      onLeft: (topic) => {
        this.generationTracker.removeTopic(topic);
        // A topic explicitly left mid-reconnect must not still deliver an
        // event it buffered before the teardown, once the generation later
        // flushes.
        for (let index = this.bufferedTopicEvents.length - 1; index >= 0; index -= 1) {
          if (this.bufferedTopicEvents[index]?.topic === topic) {
            this.bufferedTopicEvents.splice(index, 1);
          }
        }
      },
    });

    this.socket.onOpen(() => {
      void this.handleOpen();
    });

    this.socket.onError((event) => {
      const upgradeReason = parseUpgradeDisconnectReason(unwrapErrorEvent(event));
      if (!upgradeReason) {
        // A network failure before any HTTP response; its close reaches Session.
        this.logger.warn("Phoenix socket error", { event });
        return;
      }
      const verdict = this.run?.onUpgradeRejected(upgradeReason);
      this.logger.warn("Phoenix socket upgrade failed", { reason: upgradeReason, verdict });
    });
  }

  /**
   * Opens the socket and waits until it is connected. Retryable failures are
   * retried as core `Session` decides until `BOOT_CONNECT_DEADLINE_MS`; a
   * terminal verdict rejects with `WebSocketDisconnectError`, and an `abort`
   * of `signal` stops the attempt.
   */
  public async connect(signal?: AbortSignal): Promise<void> {
    this.throwIfTerminal();

    // A connect during a teardown would join the run that teardown ends.
    const stopping = this.disconnectFlight.current;
    if (stopping) {
      await stopping.catch(() => undefined);
    }
    if (this.isConnected()) {
      return;
    }

    await this.connectFlight.run(() => this.openAndWait(signal));
  }

  private async openAndWait(signal?: AbortSignal): Promise<void> {
    // A connect while a run is still reconnecting joins it instead of resetting its backoff.
    const joined = this.run?.isLive ? this.run : null;
    const run = joined ?? this.startRun();
    try {
      await this.waitForConnection(run, signal);
    } catch (error) {
      // The caller's abort stops the run; a deadline stops only a run this connect started.
      if (run.isLive && (signal?.aborted || !joined)) {
        run.stop(error as Error);
        await this.closeSocketLogged();
      }
      throw error;
    }
  }

  private startRun(): SessionRun {
    const run = new SessionRun({ policy: this.policy });
    this.run = run;
    run.signal.addEventListener("abort", () => this.handleRunEnded(run), { once: true });
    this.socket.open();
    return run;
  }

  /** The single end path for every run, however it ended. */
  private handleRunEnded(run: SessionRun): void {
    // A reconnect belongs to its run; nothing will answer the joins waiting on it.
    this.abandonReconnect();
    const error = run.signal.reason as unknown;
    if (!(error instanceof WebSocketDisconnectError)) {
      // A local stop: its owner closes the socket.
      return;
    }
    this.logger.warn("Phoenix session ended", { reason: error.reason });
    this.terminal.abort(error);
    notifyEach(this.terminalObservers, error, (observerError) => {
      this.logger.error("Terminal disconnect observer failed", { error: observerError });
    });
    this.registry.failPendingJoins(error);
    void this.closeSocketLogged();
  }

  public disconnect(): Promise<void> {
    return this.disconnectFlight.run(() => this.teardown());
  }

  private async teardown(): Promise<void> {
    // Stopped first, so no reconnect starts while the channels are left.
    this.run?.stop(new RuntimeStateError("Transport connect was superseded by disconnect()"));
    this.registry.notifyUnavailable();
    this.epoch.bump();
    const failures = await this.registry.leaveAll();

    await isolateTeardown(failures, () => this.socket.close());
    this.registry.forceTeardown();

    this.hasOpenedOnce = false;

    if (failures.length > 0) {
      // A lone failure is rethrown as-is rather than masked inside a
      // one-element AggregateError, matching the runtime teardown helpers.
      throw combineTeardownErrors(failures, "Failed to disconnect Phoenix transport");
    }
  }

  public isConnected(): boolean {
    return this.run?.isConnected ?? false;
  }

  /** The latest run's failure: the one being retried, or why it ended. */
  public getDisconnectReason(): WebSocketDisconnectReason | null {
    return this.run?.lastReason ?? null;
  }

  public getTerminalError(): WebSocketDisconnectError | null {
    return this.terminal.signal.aborted ? (this.terminal.signal.reason as WebSocketDisconnectError) : null;
  }

  public onTerminal(observer: TerminalObserver): () => void {
    this.terminalObservers.add(observer);
    return () => {
      this.terminalObservers.delete(observer);
    };
  }

  public async join(topic: string, handlers: TopicHandlers, options?: JoinOptions): Promise<void> {
    const existing = this.registry.existingJoin(topic);
    if (existing) {
      return existing;
    }

    const epoch = this.epoch.current;
    if (!isOptionalTopic(options)) await this.reconnectBarrier?.promise;
    this.throwIfTerminal();
    if (this.epoch.isStale(epoch)) {
      this.logger.debug("Join superseded by transport disconnect/reconnect", { topic });
      throw supersededJoinError(topic);
    }

    const resumed = this.registry.existingJoin(topic);
    if (resumed) {
      return resumed;
    }

    return this.registry.join(topic, handlers, options);
  }

  public async leave(topic: string): Promise<void> {
    return this.registry.leave(topic);
  }

  /** Resolves when `signal` aborts; rejects with the terminal error if the session ends first. */
  public async runForever(signal: AbortSignal): Promise<void> {
    this.throwIfTerminal();
    if (signal.aborted) {
      return;
    }

    const terminal = this.terminal.signal;
    const settled = new AbortController();
    try {
      await new Promise<void>((resolve, reject) => {
        const once = { once: true, signal: settled.signal };
        terminal.addEventListener("abort", () => reject(terminal.reason as Error), once);
        signal.addEventListener("abort", () => resolve(), once);
      });
    } finally {
      settled.abort();
    }
  }

  private throwIfTerminal(): void {
    const error = this.getTerminalError();
    if (error) {
      throw error;
    }
  }

  public onReconnected(observer: ReconnectObserver): () => void {
    this.reconnectObservers.add(observer);
    return () => {
      this.reconnectObservers.delete(observer);
    };
  }

  public onDropped(observer: DropObserver): () => void {
    this.dropObservers.add(observer);
    return () => {
      this.dropObservers.delete(observer);
    };
  }

  public onTopicRejoined(observer: TopicRejoinObserver): () => void {
    this.topicRejoinObservers.add(observer);
    return () => {
      this.topicRejoinObservers.delete(observer);
    };
  }

  private handleJoinSettled(topic: string, joined: boolean): void {
    // Replies still arriving on a connection being dropped settle nothing; the next socket rejoins.
    if (this.run?.isClosing) {
      return;
    }
    if (!joined && topic === this.controlTopic && this.run?.isLive) {
      // At boot or on any rejoin: a dropped socket as far as Session is concerned.
      this.dropLiveConnection(controlJoinFailedReason());
      return;
    }
    const inGeneration = this.generationTracker.recordSettled(topic, joined);
    // A settlement no reconnect generation waited on is a channel rejoining by
    // itself. An initial join is not registered yet, and a rejoin that failed
    // is retried by Phoenix, so only a successful rejoin gets here.
    if (joined && !inGeneration && this.registry.isJoined(topic)) {
      this.notifyTopicRejoined(topic);
    }
  }

  // Synchronous, unlike `notifyReconnectObservers`: an observer's queued catch-up
  // must land before any event the rejoined channel delivers next.
  private notifyTopicRejoined(topic: string): void {
    notifyEach(this.topicRejoinObservers, topic, (error) => {
      this.logger.error("Topic rejoin observer failed", { topic, error });
    });
  }

  private async handleOpen(): Promise<void> {
    const run = this.run;
    // Phoenix opens only the attempt just begun, so anything but "up" means the run already ended.
    if (run?.onConnected().kind !== "up") {
      return;
    }

    // Runs synchronously, before this function's first `await` yields back to
    // the socket's onOpen dispatch loop, so the snapshot is taken before
    // Phoenix's own per-channel onOpen callbacks resend their join pushes.
    // Only a socket that once got past agent_control has a session to resume.
    if (this.hasOpenedOnce) {
      this.bufferingGeneration = this.generationTracker.beginGeneration(this.registry.topics());
      if (!this.reconnectBarrier) {
        this.reconnectBarrier = createDeferred<void>();
      }
    }

    try {
      await this.subscribeAgentControl();
    } catch (error) {
      // A failed join already dropped the socket (handleJoinSettled); Session decides the retry.
      this.logger.warn("Failed to join mandatory agent_control channel", {
        error,
      });
      return;
    }
    // The run may have ended, or a supersede dropped this connection, while the join was in flight.
    if (!run.isLive || run.isClosing) {
      return;
    }

    this.hasOpenedOnce = true;
    run.markConnected();
    this.logger.info("Phoenix socket opened", {
      channels: getSocketChannelCount(this.socket),
    });
  }

  private notifyReconnectObservers(snapshot: ReconnectSnapshot): void {
    const epoch = this.epoch.current;
    const observers = [...this.reconnectObservers];
    void this.observerChain.run(async () => {
      if (this.epoch.isStale(epoch)) {
        return;
      }

      for (const observer of observers) {
        if (this.epoch.isStale(epoch)) {
          return;
        }
        if (!this.reconnectObservers.has(observer)) {
          continue;
        }
        try {
          await observer(snapshot);
        } catch (error) {
          this.logger.error("Reconnect observer failed", {
            generation: snapshot.generation,
            error,
          });
        }
      }

      if (!this.epoch.isStale(epoch) && snapshot.generation === this.bufferingGeneration) {
        this.bufferingGeneration = null;
        const events = this.bufferedTopicEvents.splice(0);
        for (const { deliver } of events) {
          deliver();
        }
        this.reconnectBarrier?.resolve();
        this.reconnectBarrier = null;
      }
    });
  }

  private async subscribeAgentControl(): Promise<void> {
    const topic = this.controlTopic;
    if (!topic) {
      return;
    }

    await this.join(
      topic,
      {
        supersede: (payload) => {
          const reason = parseSupersedeDisconnectReason(payload);
          if (!reason) {
            this.logger.warn("Invalid agent_control supersede payload", {
              payload,
            });
            return;
          }
          if (this.run?.isClosing) {
            // Session already judged this connection; a second count would only inflate its backoff.
            this.logger.debug("Ignoring supersede on a connection already being dropped", { reason });
            return;
          }
          const verdict = this.run?.onSupersede(reason);
          // Its close reaches Session as stale, so this is the one record of why the socket bounced.
          this.logger.warn("Phoenix session superseded", { reason, verdict });
          if (verdict?.kind === "retry") {
            this.dropLiveConnection(reason);
            this.notifyDropped(reason);
          }
        },
      },
      { exemptFromBuffering: true },
    );
  }

  /** Runs before phoenix asks for the reconnect delay, so Session's verdict sets it. */
  private handleSocketClose(event?: CloseEventLike): void {
    const verdict = this.run?.onSocketClose(event) ?? ENDED_VERDICT;
    this.logger.info("Phoenix socket closed", { code: event?.code ?? null, verdict });
    if (verdict.kind === "retry") {
      this.notifyDropped(verdict.reason);
    }
  }

  /** Session chose to retry: once per decision, so a supersede's later stale close adds nothing. */
  private notifyDropped(reason: WebSocketDisconnectReason): void {
    notifyEach(this.dropObservers, reason, (error) => {
      this.logger.error("Drop observer failed", { error });
    });
  }

  private nextAttemptDelayMs(): number {
    if (this.run?.pendingDelayMs === null) {
      // Phoenix asks before a close it then drops (a heartbeat timeout whose
      // close stalled past its polling), so report that close now.
      this.handleSocketClose();
    }
    // Null once the run has ended, when the attempt gate refuses anyway.
    return this.run?.pendingDelayMs ?? MAX_SETTIMEOUT_DELAY_MS;
  }

  /** Closes the live socket for `reason`, so phoenix reconnects after Session's delay. */
  private dropLiveConnection(reason: WebSocketDisconnectReason): void {
    // Its generation must not finalize as a reconnect; the next socket's generation reports it.
    this.generationTracker.discardCurrent();
    this.run?.closeOwnConnection(reason);
    this.socket.closeLiveConnection();
  }

  /** Drops a reconnect in progress: releases the joins waiting on it and its buffered events. */
  private abandonReconnect(): void {
    this.bufferingGeneration = null;
    this.reconnectBarrier?.resolve();
    this.reconnectBarrier = null;
    this.bufferedTopicEvents.splice(0);
    this.generationTracker.reset();
  }

  /** Closes the socket where nobody awaits the close's failure. */
  private async closeSocketLogged(): Promise<void> {
    await this.socket.close().catch((error: unknown) => this.logger.warn("Phoenix socket close failed", { error }));
  }

  /** Waits until `run` is connected, it ends, `signal` aborts, or the boot deadline passes. */
  private async waitForConnection(run: SessionRun, signal?: AbortSignal): Promise<void> {
    if (run.isConnected) {
      return;
    }

    using deadline = new Deadline(BOOT_CONNECT_DEADLINE_MS);
    const settled = new AbortController();
    try {
      await new Promise<void>((resolve, reject) => {
        void run.whenConnected().then(resolve);
        void deadline.expired.then(() =>
          reject(new TransportError("Timed out waiting for Phoenix socket connection", run.lastReason ?? undefined)),
        );
        const stops = eitherSignal(run.signal, signal);
        const stopped = (): void =>
          reject(run.signal.aborted ? (run.signal.reason as Error) : new RuntimeStateError("Transport connect was aborted"));
        if (stops.aborted) {
          stopped();
        } else {
          stops.addEventListener("abort", stopped, { once: true, signal: settled.signal });
        }
      });
    } finally {
      settled.abort();
    }
  }
}

export function resolveWebSocketFactory(apiKey: string): typeof WebSocket {
  if (typeof process !== "undefined" && process.versions?.node) {
    return createNodeWebSocketFactory({ "x-api-key": apiKey });
  }

  throw new TransportError(
    "Phoenix WebSocket API-key auth requires a WebSocket transport that can set handshake headers.",
  );
}

function unwrapErrorEvent(event: unknown): unknown {
  if (!isErrorEvent(event)) {
    return event;
  }

  return event.error;
}

function isErrorEvent(event: unknown): event is { error: unknown } {
  return typeof event === "object" && event !== null && "error" in event;
}

interface SocketHooks {
  /** Whether the next connect attempt may start. */
  beforeAttempt(): boolean;
  /** Called with every close, before phoenix asks `reconnectAfterMs` for the next delay. */
  onSocketClose(event?: CloseEventLike): void;
}

/**
 * A phoenix Socket that stays closed from `close()` until the next `open()`,
 * and asks its owner before every connect attempt. Every attempt, including
 * phoenix's own reconnects, passes through `transportConnect()`.
 */
class GatedSocket extends Socket {
  private opened = false;
  private readonly closeFlight = new SingleFlight<void>();

  // Not `logger`: phoenix calls its own `this.logger` as a function.
  public constructor(
    url: string,
    options: SocketOptions,
    private readonly hooks: SocketHooks,
    private readonly transportLogger: Logger,
  ) {
    super(url, options);
  }

  public open(): void {
    this.opened = true;
    super.connect();
  }

  public async close(): Promise<void> {
    this.opened = false;
    await this.closeFlight.run(async () => {
      const connection = this.conn;
      await new Promise<void>((resolve, reject) => {
        super.disconnect(() => {
          // Phoenix's bounded close polling can finish while the wire is still open.
          if (!connection || connection.readyState === WebSocket.CLOSED) {
            resolve();
          } else {
            reject(new TransportError("Phoenix socket close handshake did not finish"));
          }
        });
      });
    });
  }

  /**
   * Closes the live WebSocket without phoenix's `disconnect()`, so phoenix
   * treats it as an unexpected close and reconnects after the owner's delay.
   */
  public closeLiveConnection(): void {
    this.conn?.close();
  }

  protected override transportConnect(): void {
    if (this.opened && this.hooks.beforeAttempt()) {
      super.transportConnect();
    } else {
      this.transportLogger.debug("Suppressed phoenix connect attempt");
    }
  }

  protected override onConnClose(event?: CloseEventLike): void {
    this.hooks.onSocketClose(event);
    super.onConnClose(event);
  }
}

function getSocketChannelCount(socket: Socket): number | "unknown" {
  const candidate = socket as unknown as { channels?: Channel[] };
  if (!Array.isArray(candidate.channels)) {
    return "unknown";
  }

  return candidate.channels.length;
}
