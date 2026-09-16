import { Channel, Socket } from "phoenix";
import { TransportError } from "../../core/errors";
import { resolveLogger, type Logger } from "../../core/logger";
import { combineTeardownErrors } from "../../core/teardown";
import { KeyedSingleFlight, Serializer, SingleFlight } from "../../core/singleFlight";
import { createDeferred, type Deferred } from "../../core/deferred";
import {
  WebSocketDisconnectError,
  genericCloseReason,
  parseSupersedeDisconnectReason,
  parseUpgradeDisconnectReason,
  type WebSocketConflictPolicy,
  type WebSocketDisconnectReason,
} from "./disconnectReason";
import { createNodeWebSocketFactory } from "./nodeWebSocketFactory";
import { ReconnectGenerationTracker } from "./ReconnectGenerationTracker";
import type {
  ReconnectObserver,
  ReconnectSnapshot,
  StreamingTransport,
  TopicHandlers,
} from "./transport";
import { agentControlTopic } from "@band-ai/band-sdk-core";

interface BufferedTopicEvent {
  topic: string;
  deliver: () => void;
}

interface PhoenixChannelsTransportOptions {
  wsUrl: string;
  apiKey: string;
  agentId?: string;
  logger?: Logger;
  heartbeatIntervalMs?: number;
  reconnectAfterMs?: (tries: number) => number;
  websocketFactory?: typeof WebSocket;
  conflictPolicy?: WebSocketConflictPolicy;
  onTerminalDisconnect?: (reason: WebSocketDisconnectReason) => void;
}

interface PendingRunForever {
  reject(error: Error): void;
}

export class PhoenixChannelsTransport implements StreamingTransport {
  private readonly socket: Socket;
  private readonly agentId?: string;
  private readonly channels = new Map<string, Channel>();
  private readonly channelRefs = new Map<string, Array<[string, number]>>();
  // A join's Channel and handler bindings, tracked from the moment doJoin
  // creates them — before the join Push settles — so disconnect() can find
  // and tear down an in-flight join too, not only ones already promoted
  // into `channels`. Left untracked here, the underlying Phoenix Channel
  // would survive disconnect() unnoticed, keep its handlers bound, and
  // could later be resurrected by Phoenix's own reconnect machinery,
  // redelivering live events with no dedup anywhere upstream.
  private readonly pendingChannels = new Map<
    string,
    { channel: Channel; refs: Array<[string, number]> }
  >();
  private readonly joinFlights = new KeyedSingleFlight<void>();
  private readonly leaveFlights = new KeyedSingleFlight<void>();
  private readonly reconnectObservers = new Set<ReconnectObserver>();
  // Topics whose event delivery must never wait behind a reconnect buffering
  // window, populated once per topic by whichever internal call site joins
  // it (currently only the mandatory agent_control channel) rather than
  // re-derived by name comparison on every delivered event.
  private readonly bufferingExemptTopics = new Set<string>();
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
  private sessionEpoch = 0;
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
  private stoppingReconnect = false;
  private suppressNextCloseReason = false;

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

    const reconnectAfterMs =
      options.reconnectAfterMs ??
      ((tries: number) =>
        [1_000, 2_000, 5_000, 10_000, 30_000][tries - 1] ?? 30_000);

    this.socket = new Socket(wsUrl, {
      params: {
        agent_id: options.agentId,
        ...(options.conflictPolicy
          ? { on_conflict: options.conflictPolicy }
          : {}),
      },
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      reconnectAfterMs: (tries: number) => {
        if (this.terminalDisconnectError) {
          return Number.POSITIVE_INFINITY;
        }
        return reconnectAfterMs(tries);
      },
      transport:
        options.websocketFactory ?? resolveWebSocketFactory(options.apiKey),
    });

    this.socket.onOpen(() => {
      void this.handleOpen();
    });

    this.socket.onClose((event?: { code?: number; reason?: string }) => {
      this.recordSocketClose(event);
    });

    this.socket.onError((event) => {
      const errorEvent = unwrapErrorEvent(event);
      const upgradeReason = parseUpgradeDisconnectReason(errorEvent);
      if (upgradeReason) {
        if (upgradeReason.retryable) {
          this.lastDisconnectReason = upgradeReason;
          this.connectReject?.(new WebSocketDisconnectError(upgradeReason));
          this.stopReconnectIfNoChannels({ suppressCloseReason: true });
        } else {
          this.recordTerminalDisconnect(upgradeReason);
        }
        this.logger.warn("Phoenix socket upgrade failed", {
          reason: upgradeReason,
        });
        return;
      }

      this.connectReject?.(
        new TransportError("Phoenix socket connection failed", errorEvent),
      );
      this.stopReconnectIfNoChannels({ suppressCloseReason: true });
      this.logger.warn("Phoenix socket error", { event });
    });
  }

  public async connect(): Promise<void> {
    if (this.terminalDisconnectError) {
      throw this.terminalDisconnectError;
    }

    if (this.connected) {
      return;
    }

    await this.connectFlight.run(() => {
      this.socket.connect();
      return this.waitForConnection();
    });
  }

  public async disconnect(): Promise<void> {
    this.sessionEpoch += 1;
    const results = await Promise.allSettled(
      [...this.channels.keys()].map((topic) => this.leave(topic)),
    );

    this.socket.disconnect();
    this.connected = false;
    for (const [topic, channel] of this.channels) {
      for (const [event, ref] of this.channelRefs.get(topic) ?? []) {
        channel.off(event, ref);
      }
      removeSocketChannel(this.socket, channel);
    }
    this.channels.clear();
    this.channelRefs.clear();

    // A join still in flight never reached `channels` above; its Channel is
    // real in Phoenix's own socket registry and must be abandoned here too.
    for (const { channel, refs } of this.pendingChannels.values()) {
      this.abandonChannel(channel, refs);
    }
    this.pendingChannels.clear();

    this.joinFlights.clear();
    this.leaveFlights.clear();
    this.hasOpenedOnce = false;
    this.bufferingGeneration = null;
    this.reconnectBarrier?.resolve();
    this.reconnectBarrier = null;
    this.bufferedTopicEvents.splice(0);
    this.generationTracker.reset();

    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }

    if (failures.length > 0) {
      // A lone failure is rethrown as-is rather than masked inside a
      // one-element AggregateError, matching the runtime teardown helpers.
      throw combineTeardownErrors(failures, "Failed to leave one or more Phoenix topics during disconnect");
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getDisconnectReason(): WebSocketDisconnectReason | null {
    return this.lastDisconnectReason;
  }

  public async join(topic: string, handlers: TopicHandlers): Promise<void> {
    if (this.channels.has(topic)) {
      return;
    }

    const pendingJoin = this.joinFlights.current(topic);
    if (pendingJoin) {
      return pendingJoin;
    }

    const epoch = this.sessionEpoch;
    await this.reconnectBarrier?.promise;
    if (this.isStale(epoch)) {
      throw new TransportError(`Join superseded by transport disconnect for topic ${topic}`);
    }

    if (this.channels.has(topic)) {
      return;
    }
    const resumedPendingJoin = this.joinFlights.current(topic);
    if (resumedPendingJoin) {
      return resumedPendingJoin;
    }

    return this.joinFlights.run(topic, () => this.doJoin(topic, handlers));
  }

  private async doJoin(topic: string, handlers: TopicHandlers): Promise<void> {
    const epoch = this.sessionEpoch;
    const channel = this.socket.channel(topic, {});

    const refs: Array<[string, number]> = [];

    for (const [event, handler] of Object.entries(handlers)) {
      const ref = channel.on(event, (payload: Record<string, unknown>) => {
        const deliver = (): void => {
          const reportError = (error: unknown): void => {
            this.logger.error("Unhandled topic handler error", {
              topic,
              event,
              error,
            });
            this.onHandlerError?.(error);
          };
          try {
            void Promise.resolve(handler(payload)).catch(reportError);
          } catch (error) {
            reportError(error);
          }
        };

        if (this.bufferingGeneration !== null && !this.bufferingExemptTopics.has(topic)) {
          this.bufferedTopicEvents.push({ topic, deliver });
        } else {
          deliver();
        }
      });
      refs.push([event, ref]);
    }

    this.pendingChannels.set(topic, { channel, refs });

    // Phoenix creates exactly one join `Push` per channel and reuses it for
    // every automatic rejoin (`resend()`), so hooks registered on it now stay
    // attached and fire again on every later settlement — this is the only
    // hook into a channel's reconnect outcome the public API exposes.
    const joinPush = channel.join();
    try {
      await new Promise<void>((resolve, reject) => {
        joinPush
          .receive("ok", () => {
            this.generationTracker.recordSettled(topic, true);
            resolve();
          })
          .receive("error", (error: unknown) => {
            this.generationTracker.recordSettled(topic, false);
            reject(new TransportError(`Failed to join topic ${topic}`, error));
          })
          .receive("timeout", () => {
            this.generationTracker.recordSettled(topic, false);
            reject(new TransportError(`Timeout joining topic ${topic}`));
          });
      });
    } catch (error) {
      // Leave and remove the channel so it doesn't get rejoined on reconnect
      // — but only if this join still owns the pendingChannels entry for
      // this topic. disconnect() may have already abandoned it (clearing
      // the entry first), or, since disconnect() also clears `joinFlights`,
      // a later join for the same topic may have already taken the slot;
      // either way this settlement must not touch state that isn't its own.
      if (this.forgetPendingChannel(topic, channel)) {
        this.abandonChannel(channel, refs);
      }
      throw error;
    }

    const stillPending = this.forgetPendingChannel(topic, channel);
    if (!stillPending || this.isStale(epoch)) {
      if (stillPending) {
        this.abandonChannel(channel, refs);
      }
      throw new TransportError(`Join superseded by transport disconnect for topic ${topic}`);
    }

    this.channels.set(topic, channel);
    this.channelRefs.set(topic, refs);
    this.logger.debug("Joined topic", { topic });
  }

  /** Whether `epoch` no longer matches the current session (disconnect() ran since). */
  private isStale(epoch: number): boolean {
    return epoch !== this.sessionEpoch;
  }

  /**
   * Removes `topic`'s pendingChannels entry only if it still points at
   * `channel`, returning whether it did. A topic-keyed delete without this
   * identity check can drop a *different*, still-genuinely-pending join for
   * the same topic — reachable because `disconnect()` clears `joinFlights`,
   * so a later join for a topic whose earlier join is still unsettled is
   * possible, and that earlier join's eventual (stale) settlement must not
   * touch a slot it no longer owns.
   */
  private forgetPendingChannel(topic: string, channel: Channel): boolean {
    if (this.pendingChannels.get(topic)?.channel !== channel) {
      return false;
    }
    this.pendingChannels.delete(topic);
    return true;
  }

  private abandonChannel(channel: Channel, refs: Array<[string, number]>): void {
    for (const [event, ref] of refs) {
      channel.off(event, ref);
    }
    channel.leave();
    removeSocketChannel(this.socket, channel);
  }

  public async leave(topic: string): Promise<void> {
    const pendingLeave = this.leaveFlights.current(topic);
    if (pendingLeave) {
      return pendingLeave;
    }

    const channel = this.channels.get(topic);
    if (!channel) {
      return;
    }

    return this.leaveFlights.run(topic, () => this.doLeave(topic, channel));
  }

  private async doLeave(topic: string, channel: Channel): Promise<void> {
    const refs = this.channelRefs.get(topic) ?? [];
    for (const [event, ref] of refs) {
      channel.off(event, ref);
    }
    this.channelRefs.delete(topic);

    await new Promise<void>((resolve, reject) => {
      channel
        .leave()
        .receive("ok", () => resolve())
        .receive("error", (error: unknown) =>
          reject(new TransportError(`Failed to leave topic ${topic}`, error)),
        )
        .receive("timeout", () =>
          reject(new TransportError(`Timeout leaving topic ${topic}`)),
        );
    });

    this.channels.delete(topic);
    this.generationTracker.removeTopic(topic);
    // A topic explicitly left mid-reconnect must not still deliver an event
    // it buffered before the teardown, once the generation later flushes.
    for (let index = this.bufferedTopicEvents.length - 1; index >= 0; index -= 1) {
      if (this.bufferedTopicEvents[index]?.topic === topic) {
        this.bufferedTopicEvents.splice(index, 1);
      }
    }
    this.logger.debug("Left topic", { topic });
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

  private async handleOpen(): Promise<void> {
    // Runs synchronously, before this function's first `await` yields back to
    // the socket's onOpen dispatch loop, so the snapshot is taken before
    // Phoenix's own per-channel onOpen callbacks resend their join pushes.
    if (this.hasOpenedOnce) {
      this.bufferingGeneration = this.generationTracker.beginGeneration(this.channels.keys());
      if (!this.reconnectBarrier) {
        this.reconnectBarrier = createDeferred<void>();
      }
    } else {
      this.hasOpenedOnce = true;
    }

    try {
      await this.subscribeAgentControl();
    } catch (error) {
      this.connected = false;
      this.socket.disconnect();
      this.connectReject?.(
        error instanceof Error ? error : new TransportError(String(error)),
      );
      this.logger.warn("Failed to join mandatory agent_control channel", {
        error,
      });
      return;
    }

    this.connected = true;
    this.connectResolve?.();
    this.connectResolve = null;
    this.connectReject = null;
    this.logger.info("Phoenix socket opened", {
      channels: getSocketChannelCount(this.socket),
    });
  }

  private notifyReconnectObservers(snapshot: ReconnectSnapshot): void {
    const epoch = this.sessionEpoch;
    const observers = [...this.reconnectObservers];
    void this.observerChain.run(async () => {
      if (this.isStale(epoch)) {
        return;
      }

      for (const observer of observers) {
        if (this.isStale(epoch)) {
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

      if (!this.isStale(epoch) && snapshot.generation === this.bufferingGeneration) {
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

  private stopReconnectIfNoChannels(
    options: { suppressCloseReason?: boolean } = {},
  ): void {
    if (this.stoppingReconnect || getSocketChannelCount(this.socket) !== 0) {
      return;
    }

    this.suppressNextCloseReason = options.suppressCloseReason ?? false;
    this.stoppingReconnect = true;
    this.socket.disconnect();
    this.stoppingReconnect = false;
  }

  private async subscribeAgentControl(): Promise<void> {
    if (!this.agentId) {
      return;
    }

    const topic = agentControlTopic(this.agentId);
    this.bufferingExemptTopics.add(topic);
    await this.join(topic, {
      supersede: (payload) => {
        const reason = parseSupersedeDisconnectReason(payload);
        if (!reason) {
          this.logger.warn("Invalid agent_control supersede payload", {
            payload,
          });
          return;
        }
        this.recordTerminalDisconnect(reason);
      },
    });
  }

  private recordSocketClose(event?: { code?: number; reason?: string }): void {
    this.connected = false;
    const suppressCloseReason = this.suppressNextCloseReason;
    this.suppressNextCloseReason = false;
    this.stopReconnectIfNoChannels();
    if (
      !suppressCloseReason &&
      !this.terminalDisconnectError &&
      !this.lastDisconnectReason
    ) {
      this.lastDisconnectReason = genericCloseReason(event);
    }

    this.logger.info("Phoenix socket closed", {
      code: event?.code ?? null,
      reason: event?.reason ?? null,
      platformReason: this.lastDisconnectReason,
    });
  }

  private recordTerminalDisconnect(reason: WebSocketDisconnectReason): void {
    if (this.terminalDisconnectError) {
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
    this.socket.disconnect();
  }

  private async waitForConnection(timeoutMs = 10_000): Promise<void> {
    if (this.connected) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.connectResolve = null;
        this.connectReject = null;
        reject(
          new TransportError("Timed out waiting for Phoenix socket connection"),
        );
      }, timeoutMs);

      this.connectResolve = () => {
        clearTimeout(timeout);
        this.connectReject = null;
        resolve();
      };
      this.connectReject = (error) => {
        clearTimeout(timeout);
        this.connectResolve = null;
        this.connectReject = null;
        reject(
          error instanceof Error ? error : new TransportError(String(error)),
        );
      };
    });
  }
}

function resolveWebSocketFactory(apiKey: string): typeof WebSocket {
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

function removeSocketChannel(socket: Socket, channel: Channel): void {
  const candidate = socket as unknown as { remove?: (value: Channel) => void };
  candidate.remove?.(channel);
}

function getSocketChannelCount(socket: Socket): number | "unknown" {
  const candidate = socket as unknown as { channels?: Channel[] };
  if (!Array.isArray(candidate.channels)) {
    return "unknown";
  }

  return candidate.channels.length;
}
