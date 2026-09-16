import { Socket, type Channel } from "phoenix";
import { TransportError } from "../../core/errors";
import { resolveLogger, type Logger } from "../../core/logger";
import { combineTeardownErrors } from "../../core/teardown";
import { Serializer, SingleFlight } from "../../core/singleFlight";
import { createDeferred, type Deferred } from "../../core/deferred";
import { Epoch } from "../../core/epoch";
import { ChannelRegistry, supersededJoinError } from "./ChannelRegistry";
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
  JoinOptions,
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
  private readonly registry: ChannelRegistry;
  private readonly reconnectObservers = new Set<ReconnectObserver>();
  // Topics joined with `{ exemptFromBuffering: true }`, recorded here so
  // `wrapHandler` can check by name on every delivered event rather than
  // threading the flag through the channel/handler plumbing.
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

    this.registry = new ChannelRegistry(this.socket, this.epoch, this.logger, {
      wrapHandler: (topic, event, handler) => (payload) => {
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

        if (this.bufferingGeneration !== null && !this.bufferingExemptTopics.has(topic)) {
          this.bufferedTopicEvents.push({ topic, deliver });
        } else {
          deliver();
        }
      },
      onJoinSettled: (topic, joined) => this.generationTracker.recordSettled(topic, joined),
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
    this.epoch.bump();
    const failures = await this.registry.leaveAll();

    this.socket.disconnect();
    this.connected = false;
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
      throw combineTeardownErrors(failures, "Failed to leave one or more Phoenix topics during disconnect");
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getDisconnectReason(): WebSocketDisconnectReason | null {
    return this.lastDisconnectReason;
  }

  public async join(topic: string, handlers: TopicHandlers, options?: JoinOptions): Promise<void> {
    if (options?.exemptFromBuffering) {
      this.bufferingExemptTopics.add(topic);
    }

    const existing = this.registry.existingJoin(topic);
    if (existing) {
      return existing;
    }

    const epoch = this.epoch.current;
    await this.reconnectBarrier?.promise;
    if (this.epoch.isStale(epoch)) {
      throw supersededJoinError(topic);
    }

    const resumed = this.registry.existingJoin(topic);
    if (resumed) {
      return resumed;
    }

    return this.registry.join(topic, handlers);
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

  private async handleOpen(): Promise<void> {
    // Runs synchronously, before this function's first `await` yields back to
    // the socket's onOpen dispatch loop, so the snapshot is taken before
    // Phoenix's own per-channel onOpen callbacks resend their join pushes.
    if (this.hasOpenedOnce) {
      this.bufferingGeneration = this.generationTracker.beginGeneration(this.registry.topics());
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
          this.recordTerminalDisconnect(reason);
        },
      },
      { exemptFromBuffering: true },
    );
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

function getSocketChannelCount(socket: Socket): number | "unknown" {
  const candidate = socket as unknown as { channels?: Channel[] };
  if (!Array.isArray(candidate.channels)) {
    return "unknown";
  }

  return candidate.channels.length;
}
