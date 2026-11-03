import { Socket, type Channel, type SocketOptions } from "phoenix";
import { RuntimeStateError, TransportError } from "../../core/errors";
import { resolveLogger, type Logger } from "../../core/logger";
import { combineTeardownErrors, isolateTeardown } from "../../core/teardown";
import { Serializer, SingleFlight } from "../../core/singleFlight";
import { createDeferred, type Deferred } from "../../core/deferred";
import { Epoch } from "../../core/epoch";
import { ChannelRegistry, supersededJoinError } from "./ChannelRegistry";
import {
  WebSocketDisconnectError,
  type CloseEventLike,
  genericCloseReason,
  parseSupersedeDisconnectReason,
  parseUpgradeDisconnectReason,
  rapidDisconnectReason,
  staleConnectionReason,
  type WebSocketConflictPolicy,
  type WebSocketDisconnectReason,
} from "./disconnectReason";
import { createNodeWebSocketFactory } from "./nodeWebSocketFactory";
import { ReconnectGenerationTracker } from "./ReconnectGenerationTracker";
import { MAX_TIMER_DELAY_MS, SessionDriver, type SessionVerdict } from "./sessionDriver";
import {
  isOptionalTopic,
  type JoinOptions,
  type ReconnectObserver,
  type ReconnectSnapshot,
  type StreamingTransport,
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
  onTerminalDisconnect?: (reason: WebSocketDisconnectReason) => void;
}

interface PendingRunForever {
  reject(error: Error): void;
}

export class PhoenixChannelsTransport implements StreamingTransport {
  private readonly socket: GatedSocket;
  private readonly agentId?: string;
  private readonly registry: ChannelRegistry;
  private readonly reconnectObservers = new Set<ReconnectObserver>();
  private readonly topicRejoinObservers = new Set<TopicRejoinObserver>();
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
  private readonly onTerminalDisconnect?: (
    reason: WebSocketDisconnectReason,
  ) => void;
  private onHandlerError?: (error: unknown) => void;
  private connected = false;
  private readonly connectFlight = new SingleFlight<void>();
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private lastDisconnectReason: WebSocketDisconnectReason | null = null;
  private terminalDisconnectError: WebSocketDisconnectError | null = null;
  private runForeverWaiters = new Set<PendingRunForever>();
  private readonly driver: SessionDriver;

  public constructor(options: PhoenixChannelsTransportOptions) {
    this.logger = resolveLogger(options.logger);
    this.agentId = options.agentId;
    this.onTerminalDisconnect = options.onTerminalDisconnect;

    // The phoenix JS library appends /websocket to the endpoint URL.
    // Strip it if the user-provided URL already includes it.
    let wsUrl = options.wsUrl;
    if (wsUrl.endsWith("/websocket")) {
      wsUrl = wsUrl.slice(0, -"/websocket".length);
    }

    const policy = options.sessionPolicy ?? SessionPolicy.default();
    this.driver = new SessionDriver({ policy });
    this.socket = new GatedSocket(wsUrl, {
      params: {
        ...(options.agentId ? { agent_id: options.agentId } : {}),
        ...(options.conflictPolicy
          ? { on_conflict: options.conflictPolicy }
          : {}),
      },
      heartbeatIntervalMs: policy.heartbeatIntervalS * 1000,
      reconnectAfterMs: () => this.nextAttemptDelayMs(),
      transport:
        options.websocketFactory ?? resolveWebSocketFactory(options.apiKey),
    }, {
      beforeAttempt: () => this.beforeAttempt(),
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
      this.logger.warn("Phoenix socket upgrade failed", { reason: upgradeReason });
      this.applyVerdict(
        this.driver.onUpgradeRejected(upgradeReason.status, upgradeReason.retryAfter),
        upgradeReason,
      );
    });
  }

  /**
   * Opens the socket and waits until it is connected. Retryable failures are
   * retried as core `Session` decides until `BOOT_CONNECT_DEADLINE_MS`; a
   * terminal verdict rejects with `WebSocketDisconnectError`, and an `abort`
   * of `signal` stops the attempt.
   */
  public async connect(signal?: AbortSignal): Promise<void> {
    if (this.terminalDisconnectError) {
      throw this.terminalDisconnectError;
    }

    if (this.connected) {
      return;
    }

    await this.connectFlight.run(() => this.openAndWait(signal));
  }

  private async openAndWait(signal?: AbortSignal): Promise<void> {
    // A connect while a run is still reconnecting joins it instead of resetting its backoff.
    const startsRun = this.driver.begin();
    if (startsRun) {
      // A boot's deadline reports only what this run saw.
      this.lastDisconnectReason = null;
      this.socket.open();
    }
    try {
      await this.waitForConnection(signal);
    } catch (error) {
      const ownsTeardown = error instanceof RuntimeStateError || (error instanceof TransportError && startsRun);
      if (ownsTeardown && !this.driver.isSettled) {
        await this.stopSocketLogged();
      }
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    this.connectReject?.(new RuntimeStateError("Transport connect was superseded by disconnect()"));
    this.registry.notifyUnavailable();
    this.epoch.bump();
    const failures = await this.registry.leaveAll();

    await isolateTeardown(failures, () => this.stopSocket());
    this.registry.forceTeardown();

    this.hasOpenedOnce = false;
    this.bufferingGeneration = null;
    this.reconnectBarrier?.resolve();
    this.reconnectBarrier = null;
    this.bufferedTopicEvents.splice(0);
    this.generationTracker.reset();

    if (failures.length > 0) {
      // A lone failure is rethrown as-is rather than masked inside a
      // one-element AggregateError, matching the runtime teardown helpers.
      throw combineTeardownErrors(failures, "Failed to disconnect Phoenix transport");
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getDisconnectReason(): WebSocketDisconnectReason | null {
    return this.lastDisconnectReason;
  }

  public async join(topic: string, handlers: TopicHandlers, options?: JoinOptions): Promise<void> {
    const existing = this.registry.existingJoin(topic);
    if (existing) {
      return existing;
    }

    const epoch = this.epoch.current;
    if (!isOptionalTopic(options)) await this.reconnectBarrier?.promise;
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

  public async runForever(signal: AbortSignal): Promise<void> {
    if (this.terminalDisconnectError) {
      throw this.terminalDisconnectError;
    }

    if (signal.aborted) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const abortController = new AbortController();
      const waiter: PendingRunForever = {
        reject: (error) => {
          if (settled) {
            return;
          }
          settled = true;
          this.runForeverWaiters.delete(waiter);
          abortController.abort();
          reject(error);
        },
      };

      this.runForeverWaiters.add(waiter);
      signal.addEventListener(
        "abort",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          this.runForeverWaiters.delete(waiter);
          resolve();
        },
        { once: true, signal: abortController.signal },
      );
    });
  }

  public onReconnected(observer: ReconnectObserver): () => void {
    this.reconnectObservers.add(observer);
    return () => {
      this.reconnectObservers.delete(observer);
    };
  }

  public onTopicRejoined(observer: TopicRejoinObserver): () => void {
    this.topicRejoinObservers.add(observer);
    return () => {
      this.topicRejoinObservers.delete(observer);
    };
  }

  private handleJoinSettled(topic: string, joined: boolean): void {
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
    for (const observer of [...this.topicRejoinObservers]) {
      try {
        observer(topic);
      } catch (error) {
        this.logger.error("Topic rejoin observer failed", { topic, error });
      }
    }
  }

  private async handleOpen(): Promise<void> {
    const verdict = this.driver.onConnected();
    if (verdict.kind === "ended") {
      return;
    }
    if (verdict.kind !== "up") {
      this.endSession(staleConnectionReason());
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
      this.logger.warn("Failed to join mandatory agent_control channel", {
        error,
      });
      // A dropped socket as far as Session is concerned: it decides whether to retry.
      if (this.driver.isLive) {
        this.socket.closeLiveConnection();
      }
      return;
    }
    // The run may have ended while the join was in flight.
    if (!this.driver.isLive) {
      return;
    }

    this.hasOpenedOnce = true;
    this.connected = true;
    this.connectResolve?.();
    this.connectResolve = null;
    this.connectReject = null;
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
    if (!this.agentId) {
      return;
    }

    const topic = agentControlTopic(this.agentId);
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
          const verdict = this.driver.onSupersede(reason.retryable, reason.retryAfter);
          this.applyVerdict(verdict, reason);
          if (verdict.kind === "retry") {
            this.socket.closeLiveConnection();
          }
        },
      },
      { exemptFromBuffering: true },
    );
  }

  /** Asks Session whether phoenix may start its next connect attempt. */
  private beforeAttempt(): boolean {
    const decision = this.driver.beginAttempt();
    if (decision === "dead" && !this.driver.isSettled) {
      // Session refuses an attempt it has not reported dead only when its
      // breaker trips as the attempt retires a socket still marked up.
      this.endSession(rapidDisconnectReason());
    }
    return decision === "proceed";
  }

  /** Runs before phoenix asks for the reconnect delay, so Session's verdict sets it. */
  private handleSocketClose(event?: CloseEventLike): void {
    this.connected = false;
    const verdict = this.driver.onSocketClose(event?.code);
    this.logger.info("Phoenix socket closed", {
      code: event?.code ?? null,
      reason: event?.reason ?? null,
      verdict,
    });
    const reason = verdict.kind === "terminal" && verdict.rapidDisconnect
      ? rapidDisconnectReason(event)
      : genericCloseReason(event);
    this.applyVerdict(verdict, reason);
  }

  private nextAttemptDelayMs(): number {
    const verdict = this.driver.nextDelay();
    if (verdict.kind === "retry") {
      return verdict.delayMs;
    }
    if (verdict.kind === "terminal") {
      this.applyVerdict(verdict, verdict.rapidDisconnect ? rapidDisconnectReason() : genericCloseReason());
    }
    // Unused, since the attempt gate refuses the next attempt; finite because Node fires an infinite delay at once.
    return MAX_TIMER_DELAY_MS;
  }

  private applyVerdict(verdict: SessionVerdict, reason: WebSocketDisconnectReason): void {
    if (verdict.kind === "terminal") {
      this.endSession({ ...reason, retryable: false });
    } else if (verdict.kind === "retry" && !this.driver.isSettled) {
      this.lastDisconnectReason = reason;
    }
  }

  /** The single terminal path: reports the end once per run and stops the socket. */
  private endSession(reason: WebSocketDisconnectReason): void {
    if (!this.driver.settle()) {
      return;
    }

    const error = new WebSocketDisconnectError(reason);
    this.lastDisconnectReason = reason;
    this.terminalDisconnectError = error;
    this.onTerminalDisconnect?.(reason);
    this.connectReject?.(error);
    for (const waiter of this.runForeverWaiters) {
      waiter.reject(error);
    }
    this.runForeverWaiters.clear();
    void this.stopSocketLogged();
  }

  /**
   * The single stop path: a local end of the run. Clears `connected` itself
   * because phoenix's close callback may never fire after a stalled close.
   */
  private async stopSocket(): Promise<void> {
    this.connected = false;
    this.driver.end();
    await this.socket.close();
  }

  /** Stops the socket where nobody awaits the close's failure. */
  private async stopSocketLogged(): Promise<void> {
    await this.stopSocket().catch((error: unknown) => this.logger.warn("Phoenix socket close failed", { error }));
  }

  private async waitForConnection(signal?: AbortSignal): Promise<void> {
    if (this.connected) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => this.connectReject?.(new RuntimeStateError("Transport connect was aborted"));
      const settle = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.connectResolve = null;
        this.connectReject = null;
      };
      const timeout = setTimeout(() => {
        settle();
        reject(
          new TransportError("Timed out waiting for Phoenix socket connection", this.lastDisconnectReason ?? undefined),
        );
      }, BOOT_CONNECT_DEADLINE_MS);

      this.connectResolve = () => {
        settle();
        resolve();
      };
      this.connectReject = (error) => {
        settle();
        reject(
          error instanceof Error ? error : new TransportError(String(error)),
        );
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
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
