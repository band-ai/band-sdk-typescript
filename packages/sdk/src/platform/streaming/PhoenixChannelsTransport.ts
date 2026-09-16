import { Channel, Socket } from "phoenix";
import { TransportError } from "../../core/errors";
import { resolveLogger, type Logger } from "../../core/logger";
import { combineTeardownErrors } from "../../core/teardown";
import {
  WebSocketDisconnectError,
  genericCloseReason,
  parseSupersedeDisconnectReason,
  parseUpgradeDisconnectReason,
  type WebSocketConflictPolicy,
  type WebSocketDisconnectReason,
} from "./disconnectReason";
import { createNodeWebSocketFactory } from "./nodeWebSocketFactory";
import type {
  ReconnectObserver,
  ReconnectSnapshot,
  StreamingTransport,
  TopicHandlers,
} from "./transport";
import { agentControlTopic } from "@band-ai/band-sdk-core";
import type { Push } from "phoenix";

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
  private readonly pendingJoins = new Map<string, Promise<void>>();
  private readonly joinPushes = new Map<string, Push>();
  private readonly reconnectObservers = new Set<ReconnectObserver>();
  private readonly pendingGenerations = new Map<number, Set<string>>();
  private readonly settledGenerationTopics = new Map<number, Set<string>>();
  private hasOpenedOnce = false;
  private generation = 0;
  private observerChain: Promise<void> = Promise.resolve();
  private readonly logger: Logger;
  private readonly onTerminalDisconnect?: (
    reason: WebSocketDisconnectReason,
  ) => void;
  private onHandlerError?: (error: unknown) => void;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
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

    if (!this.connectPromise) {
      this.socket.connect();
      const pending = this.waitForConnection();
      this.connectPromise = pending;
      void pending.then(
        () => {
          if (this.connectPromise === pending) {
            this.connectPromise = null;
          }
        },
        () => {
          if (this.connectPromise === pending) {
            this.connectPromise = null;
          }
        },
      );
    }

    await this.connectPromise;
  }

  public async disconnect(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.channels.keys()].map((topic) => this.leave(topic)),
    );

    this.socket.disconnect();
    this.connected = false;

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

    const pendingJoin = this.pendingJoins.get(topic);
    if (pendingJoin) {
      return pendingJoin;
    }

    const joinPromise = this.doJoin(topic, handlers).finally(() => {
      this.pendingJoins.delete(topic);
    });
    this.pendingJoins.set(topic, joinPromise);
    return joinPromise;
  }

  private async doJoin(topic: string, handlers: TopicHandlers): Promise<void> {
    const channel = this.socket.channel(topic, {});

    const refs: Array<[string, number]> = [];

    for (const [event, handler] of Object.entries(handlers)) {
      const ref = channel.on(event, (payload: Record<string, unknown>) => {
        Promise.resolve(handler(payload)).catch((error: unknown) => {
          this.logger.error("Unhandled topic handler error", {
            topic,
            event,
            error,
          });
          this.onHandlerError?.(error);
        });
      });
      refs.push([event, ref]);
    }

    // Phoenix creates exactly one join `Push` per channel and reuses it for
    // every automatic rejoin (`resend()`), so hooks registered on it now stay
    // attached and fire again on every later settlement — this is the only
    // hook into a channel's reconnect outcome the public API exposes.
    const joinPush = channel.join();
    joinPush
      .receive("ok", () => this.recordTopicSettled(topic, true))
      .receive("error", () => this.recordTopicSettled(topic, false))
      .receive("timeout", () => this.recordTopicSettled(topic, false));
    this.joinPushes.set(topic, joinPush);

    try {
      await new Promise<void>((resolve, reject) => {
        joinPush
          .receive("ok", () => resolve())
          .receive("error", (error: unknown) =>
            reject(new TransportError(`Failed to join topic ${topic}`, error)),
          )
          .receive("timeout", () =>
            reject(new TransportError(`Timeout joining topic ${topic}`)),
          );
      });
    } catch (error) {
      for (const [event, ref] of refs) {
        channel.off(event, ref);
      }
      this.joinPushes.delete(topic);
      // Leave and remove the channel so it doesn't get rejoined on reconnect.
      channel.leave();
      removeSocketChannel(this.socket, channel);
      throw error;
    }

    this.channels.set(topic, channel);
    this.channelRefs.set(topic, refs);
    this.logger.debug("Joined topic", { topic });
  }

  public async leave(topic: string): Promise<void> {
    const channel = this.channels.get(topic);
    if (!channel) {
      return;
    }

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
    this.joinPushes.delete(topic);
    this.removeTopicFromPendingGenerations(topic);
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
      this.beginReconnectGeneration();
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

  private beginReconnectGeneration(): void {
    const generation = ++this.generation;

    // A generation superseded by this newer one will never receive another
    // settlement for its stragglers (Phoenix rebinds each rejoined push's
    // reply listener on `resend()`, so a stale reply can no longer arrive) —
    // drop it now rather than leaking it forever.
    for (const staleGeneration of this.pendingGenerations.keys()) {
      if (staleGeneration < generation) {
        this.pendingGenerations.delete(staleGeneration);
        this.settledGenerationTopics.delete(staleGeneration);
      }
    }

    this.pendingGenerations.set(generation, new Set(this.channels.keys()));
    this.settledGenerationTopics.set(generation, new Set());
    this.maybeFinalizeGeneration(generation);
  }

  private recordTopicSettled(topic: string, joined: boolean): void {
    const pending = this.pendingGenerations.get(this.generation);
    if (!pending?.delete(topic)) {
      return;
    }

    if (joined) {
      this.settledGenerationTopics.get(this.generation)?.add(topic);
    }
    this.maybeFinalizeGeneration(this.generation);
  }

  private removeTopicFromPendingGenerations(topic: string): void {
    for (const [generation, pending] of this.pendingGenerations) {
      if (pending.delete(topic)) {
        this.maybeFinalizeGeneration(generation);
      }
    }
  }

  private maybeFinalizeGeneration(generation: number): void {
    const pending = this.pendingGenerations.get(generation);
    if (!pending || pending.size > 0) {
      return;
    }

    const joinedTopics = this.settledGenerationTopics.get(generation) ?? new Set<string>();
    this.pendingGenerations.delete(generation);
    this.settledGenerationTopics.delete(generation);
    this.notifyReconnectObservers({ generation, joinedTopics });
  }

  private notifyReconnectObservers(snapshot: ReconnectSnapshot): void {
    this.observerChain = this.observerChain.then(async () => {
      for (const observer of this.reconnectObservers) {
        try {
          await observer(snapshot);
        } catch (error) {
          this.logger.error("Reconnect observer failed", {
            generation: snapshot.generation,
            error,
          });
        }
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

    await this.join(agentControlTopic(this.agentId), {
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
