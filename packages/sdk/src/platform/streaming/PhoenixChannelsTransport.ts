import { Channel, Socket } from "phoenix";
import { TransportError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import {
  PHOENIX_MANUAL_TIMER_MS,
  REALTIME_MAX_FRAME_BYTES,
  REALTIME_MAX_PENDING_CONTROLS,
  REALTIME_MAX_REFS,
} from "./resourceLimits";
import {
  WebSocketDisconnectError,
  genericCloseReason,
  oversizeFrameReason,
  parseSupersedeDisconnectReason,
  parseUpgradeDisconnectReason,
  type WebSocketConflictPolicy,
  type WebSocketDisconnectReason,
} from "./disconnectReason";
import { createNodeWebSocketFactory } from "./nodeWebSocketFactory";
import type { StreamingTransport, TopicHandlers } from "./transport";

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
  onSocketClose?: (reason: WebSocketDisconnectReason | null) => void;
  onSocketOpen?: () => void;
  abortSignal?: AbortSignal;
  reconnectMode?: "phoenix" | "manual";
  joinAgentControl?: boolean;
}

interface PendingRunForever {
  reject(error: Error): void;
}

interface OwnedJoin {
  topic: string;
  promise: Promise<unknown>;
  abort: (reason?: Error) => void;
  cleanup: () => void;
}

const CONFLICT_POLICIES = new Set<WebSocketConflictPolicy>([
  "supersede",
  "reject",
]);

export class PhoenixChannelsTransport implements StreamingTransport {
  private readonly socket: Socket;
  private readonly agentId?: string;
  private readonly channels = new Map<string, Channel>();
  private readonly channelRefs = new Map<string, Array<[string, number]>>();
  private readonly pendingJoins = new Map<string, OwnedJoin>();
  private readonly maxPendingControls: number;
  private readonly maxProtocolRefs: number;
  private readonly maxFrameBytes: number;
  private protocolRefCount = 0;
  private readonly logger: Logger;
  private readonly onTerminalDisconnect?: (
    reason: WebSocketDisconnectReason,
  ) => void;
  private readonly onSocketClose?: (
    reason: WebSocketDisconnectReason | null,
  ) => void;
  private readonly onSocketOpen?: () => void;
  private readonly abortSignal?: AbortSignal;
  private readonly reconnectMode: "phoenix" | "manual";
  private readonly joinAgentControl: boolean;
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
  private closeOwnerNotified = false;

  public constructor(options: PhoenixChannelsTransportOptions) {
    this.logger = options.logger ?? new NoopLogger();
    this.agentId = options.agentId;
    this.onTerminalDisconnect = options.onTerminalDisconnect;
    this.onSocketClose = options.onSocketClose;
    this.onSocketOpen = options.onSocketOpen;
    this.abortSignal = options.abortSignal;
    this.reconnectMode = options.reconnectMode ?? "phoenix";
    this.joinAgentControl = options.joinAgentControl ?? true;
    this.maxPendingControls = REALTIME_MAX_PENDING_CONTROLS;
    this.maxProtocolRefs = REALTIME_MAX_REFS;
    this.maxFrameBytes = REALTIME_MAX_FRAME_BYTES;

    let wsUrl = options.wsUrl;
    if (wsUrl.endsWith("/websocket")) {
      wsUrl = wsUrl.slice(0, -"/websocket".length);
    }

    if (
      options.conflictPolicy !== undefined &&
      !CONFLICT_POLICIES.has(options.conflictPolicy)
    ) {
      throw new TransportError("Invalid websocket conflict policy");
    }

    const reconnectAfterMs =
      this.reconnectMode === "manual"
        ? () => PHOENIX_MANUAL_TIMER_MS
        : (options.reconnectAfterMs ??
          ((tries: number) =>
            [1_000, 2_000, 5_000, 10_000, 30_000][tries - 1] ?? 30_000));

    const params: Record<string, unknown> = {};
    if (options.agentId !== undefined) {
      params.agent_id = options.agentId;
    }
    if (options.conflictPolicy !== undefined) {
      params.on_conflict = options.conflictPolicy;
    }

    this.socket = new Socket(wsUrl, {
      params,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
      reconnectAfterMs: (tries: number) => {
        if (this.terminalDisconnectError || this.reconnectMode === "manual") {
          return PHOENIX_MANUAL_TIMER_MS;
        }
        return reconnectAfterMs(tries);
      },
      rejoinAfterMs: () =>
        this.reconnectMode === "manual" ? PHOENIX_MANUAL_TIMER_MS : 1_000,
      transport: wrapInboundFrameLimit(
        options.websocketFactory ?? resolveWebSocketFactory(options.apiKey),
        this.maxFrameBytes,
        (byteLength) => {
          this.recordTerminalDisconnect(oversizeFrameReason(byteLength));
        },
      ),
    });

    this.installMakeRefGuard();
    this.installManualReconnectGuard();

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
          code: upgradeReason.code,
          status: upgradeReason.status,
        });
        return;
      }

      this.connectReject?.(
        new TransportError("Phoenix socket connection failed"),
      );
      this.stopReconnectIfNoChannels({ suppressCloseReason: true });
      this.logger.warn("Phoenix socket error", { code: "socket.error" });
    });
  }

  public async connect(signal?: AbortSignal): Promise<void> {
    if (this.terminalDisconnectError) {
      throw this.terminalDisconnectError;
    }

    if (this.connected) {
      return;
    }

    if (!this.connectPromise) {
      this.socket.connect();
      const pending = this.waitForConnection(signal);
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
    for (const pending of [...this.pendingJoins.values()]) {
      pending.abort(new TransportError("Transport disconnected"));
      pending.cleanup();
    }
    this.pendingJoins.clear();
    this.connectReject?.(new TransportError("Transport disconnected"));
    const topics = [...this.channels.keys()];
    const results = await Promise.allSettled(
      topics.map((topic) => this.leave(topic)),
    );
    this.detachAllSocketChannels();
    this.socket.disconnect();
    this.connected = false;

    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to leave one or more Phoenix topics during disconnect",
      );
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getDisconnectReason(): WebSocketDisconnectReason | null {
    return this.lastDisconnectReason;
  }

  public getProtocolRefCount(): number {
    return this.protocolRefCount;
  }

  public getSocketChannelTopics(): string[] {
    return Array.isArray(this.socket.channels)
      ? this.socket.channels.map((channel) => channel.topic)
      : [];
  }

  public getReconnectTimerMs(tries = 1): number {
    return this.socket.reconnectTimer
      ? (this.socket as unknown as { reconnectAfterMs: (n: number) => number })
          .reconnectAfterMs?.(tries) ?? PHOENIX_MANUAL_TIMER_MS
      : PHOENIX_MANUAL_TIMER_MS;
  }

  public async join(topic: string, handlers: TopicHandlers): Promise<void> {
    await this.joinWithResponse(topic, handlers);
  }

  public async joinWithResponse(
    topic: string,
    handlers: TopicHandlers,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.channels.has(topic)) {
      return undefined;
    }

    const pendingJoin = this.pendingJoins.get(topic);
    if (pendingJoin) {
      return pendingJoin.promise;
    }

    if (this.pendingJoins.size >= this.maxPendingControls) {
      throw new TransportError(
        `Rejected join for ${topic}: pending control ceiling reached`,
      );
    }

    const owned: OwnedJoin = {
      topic,
      promise: Promise.resolve(undefined),
      abort: () => undefined,
      cleanup: () => undefined,
    };
    owned.promise = new Promise<unknown>((resolve, reject) => {
      owned.abort = (reason) => {
        owned.cleanup();
        reject(reason ?? new TransportError(`Join for ${topic} was cancelled`));
      };
      void this.doJoin(topic, handlers, signal, owned).then(resolve, reject);
    }).finally(() => {
      this.pendingJoins.delete(topic);
    });
    this.pendingJoins.set(topic, owned);
    return owned.promise;
  }

  private async doJoin(
    topic: string,
    handlers: TopicHandlers,
    signal: AbortSignal | undefined,
    owned: OwnedJoin,
  ): Promise<unknown> {
    if (signal?.aborted || this.abortSignal?.aborted) {
      throw new TransportError(`Join for ${topic} was cancelled`);
    }

    const channel = this.socket.channel(topic, {});
    const refs: Array<[string, number]> = [];
    let installed = false;

    const cleanup = (): void => {
      if (installed) {
        return;
      }
      for (const [event, ref] of refs) {
        channel.off(event, ref);
      }
      try {
        channel.leave();
      } catch {
        // best-effort; channel may already be closed
      }
      this.socket.remove(channel);
      this.channels.delete(topic);
      this.channelRefs.delete(topic);
    };
    owned.cleanup = cleanup;

    for (const [event, handler] of Object.entries(handlers)) {
      const ref = channel.on(event, (payload: Record<string, unknown>) => {
        Promise.resolve(handler(payload)).catch(() => {
          this.logger.error("Unhandled topic handler error", {
            topic,
            event,
          });
          this.onHandlerError?.(undefined);
        });
      });
      refs.push([event, ref]);
    }

    const onAbort = (): void => {
      owned.abort(new TransportError(`Join for ${topic} was cancelled`));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    this.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      const joinPayload = await new Promise<unknown>((resolve, reject) => {
        channel
          .join()
          .receive("ok", (payload?: unknown) => resolve(payload))
          .receive("error", () =>
            reject(new TransportError(`Failed to join topic ${topic}`)),
          )
          .receive("timeout", () =>
            reject(new TransportError(`Timeout joining topic ${topic}`)),
          );
      });
      if (signal?.aborted || this.abortSignal?.aborted || this.terminalDisconnectError) {
        cleanup();
        throw new TransportError(`Join for ${topic} was cancelled`);
      }
      installed = true;
      this.channels.set(topic, channel);
      this.channelRefs.set(topic, refs);
      this.logger.debug("Joined topic", { topic });
      return joinPayload;
    } catch (error) {
      cleanup();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  public async leave(topic: string): Promise<void> {
    const pending = this.pendingJoins.get(topic);
    pending?.abort(new TransportError(`Join for ${topic} was cancelled`));
    pending?.cleanup();

    const channel = this.channels.get(topic);
    this.channels.delete(topic);
    const refs = this.channelRefs.get(topic) ?? [];
    this.channelRefs.delete(topic);
    if (!channel) {
      this.detachTopicFromSocket(topic);
      return;
    }

    for (const [event, ref] of refs) {
      channel.off(event, ref);
    }
    this.socket.remove(channel);

    await new Promise<void>((resolve) => {
      try {
        channel
          .leave()
          .receive("ok", () => resolve())
          .receive("error", () => resolve())
          .receive("timeout", () => resolve());
      } catch {
        resolve();
      }
    });
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

  private installMakeRefGuard(): void {
    const original = this.socket.makeRef.bind(this.socket);
    this.socket.makeRef = (): string => {
      if (this.protocolRefCount >= this.maxProtocolRefs) {
        this.recordTerminalDisconnect({
          source: "websocket_close",
          code: "websocket.closed",
          message: "Realtime protocol ref ceiling reached",
          retryable: false,
          closeCode: null,
          closeReason: "ref_ceiling",
        });
        throw new TransportError("Realtime join ref ceiling reached");
      }
      this.protocolRefCount += 1;
      return original();
    };
  }

  private installManualReconnectGuard(): void {
    if (this.reconnectMode !== "manual" || !this.socket.reconnectTimer) {
      return;
    }
    this.socket.reconnectTimer.reset();
    this.socket.reconnectTimer.scheduleTimeout = (): void => undefined;
  }

  private async handleOpen(): Promise<void> {
    try {
      if (this.joinAgentControl) {
        await this.subscribeAgentControl();
      }
    } catch (error) {
      this.connected = false;
      this.socket.disconnect();
      this.connectReject?.(
        error instanceof Error ? error : new TransportError(String(error)),
      );
      this.logger.warn("Failed to join mandatory agent_control channel", {
        code: "agent_control.join_failed",
      });
      return;
    }

    this.connected = true;
    this.lastDisconnectReason = null;
    this.closeOwnerNotified = false;
    this.connectResolve?.();
    this.connectResolve = null;
    this.connectReject = null;
    this.logger.info("Phoenix socket opened", {
      channels: this.getSocketChannelTopics().length,
    });
    this.onSocketOpen?.();
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

    await this.join(`agent_control:${this.agentId}`, {
      supersede: (payload) => {
        const reason = parseSupersedeDisconnectReason(payload);
        if (!reason) {
          this.logger.warn("Invalid agent_control supersede payload", {
            code: "supersede.invalid",
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
    this.connectReject?.(new TransportError("Phoenix socket closed"));
    if (
      !suppressCloseReason &&
      !this.terminalDisconnectError &&
      !this.lastDisconnectReason
    ) {
      this.lastDisconnectReason = genericCloseReason(event);
    }
    this.forgetLocalChannels();
    this.detachAllSocketChannels();
    this.socket.reconnectTimer?.reset();
    if (this.reconnectMode === "manual") {
      if (!this.stoppingReconnect) {
        this.stoppingReconnect = true;
        this.socket.disconnect();
        this.stoppingReconnect = false;
      }
    } else {
      this.stopReconnectIfNoChannels();
    }

    this.logger.info("Phoenix socket closed", {
      code: event?.code ?? null,
      classified: this.lastDisconnectReason?.code ?? null,
    });
    if (!this.closeOwnerNotified) {
      this.closeOwnerNotified = true;
      this.onSocketClose?.(this.lastDisconnectReason);
    }
  }

  private forgetLocalChannels(): void {
    for (const pending of [...this.pendingJoins.values()]) {
      pending.abort(new TransportError("Transport disconnected"));
      pending.cleanup();
    }
    this.pendingJoins.clear();
    this.channels.clear();
    this.channelRefs.clear();
  }

  private detachAllSocketChannels(): void {
    const channels = Array.isArray(this.socket.channels)
      ? [...this.socket.channels]
      : [];
    for (const channel of channels) {
      try {
        channel.leave();
      } catch {
        // ignore
      }
      this.socket.remove(channel);
    }
  }

  private detachTopicFromSocket(topic: string): void {
    const channels = Array.isArray(this.socket.channels)
      ? this.socket.channels.filter((channel) => channel.topic === topic)
      : [];
    for (const channel of channels) {
      this.socket.remove(channel);
    }
  }

  private recordTerminalDisconnect(reason: WebSocketDisconnectReason): void {
    if (this.terminalDisconnectError) {
      return;
    }

    const error = new WebSocketDisconnectError(reason);
    this.lastDisconnectReason = reason;
    this.terminalDisconnectError = error;
    this.socket.reconnectTimer?.reset();
    if (this.socket.reconnectTimer) {
      this.socket.reconnectTimer.scheduleTimeout = (): void => undefined;
    }
    this.onTerminalDisconnect?.(reason);
    this.closeOwnerNotified = true;
    this.connectReject?.(error);
    for (const waiter of this.runForeverWaiters) {
      waiter.reject(error);
    }
    this.runForeverWaiters.clear();
    this.socket.disconnect();
  }

  private async waitForConnection(
    signal?: AbortSignal,
    timeoutMs = 10_000,
  ): Promise<void> {
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

      const onAbort = (): void => {
        clearTimeout(timeout);
        this.connectResolve = null;
        this.connectReject = null;
        this.socket.disconnect();
        reject(new TransportError("Realtime connection aborted before start"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.abortSignal?.addEventListener("abort", onAbort, { once: true });

      this.connectResolve = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.abortSignal?.removeEventListener("abort", onAbort);
        this.connectReject = null;
        resolve();
      };
      this.connectReject = (error) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.abortSignal?.removeEventListener("abort", onAbort);
        this.connectResolve = null;
        this.connectReject = null;
        reject(
          error instanceof Error ? error : new TransportError(String(error)),
        );
      };
    });
  }
}

function wrapInboundFrameLimit(
  factory: typeof WebSocket,
  maxFrameBytes: number,
  onOversize: (byteLength: number) => void,
): typeof WebSocket {
  const WebSocketImpl = factory;
  class BoundedWebSocket {
    public constructor(address: string | URL, protocols?: string | string[]) {
      const socket = new WebSocketImpl(address, protocols);
      socket.addEventListener(
        "message",
        (event: MessageEvent<unknown>) => {
          const data: unknown = event.data;
          const size =
            typeof data === "string"
              ? Buffer.byteLength(data)
              : data instanceof ArrayBuffer
                ? data.byteLength
                : ArrayBuffer.isView(data)
                  ? data.byteLength
                  : maxFrameBytes + 1;
          if (size > maxFrameBytes) {
            event.stopImmediatePropagation();
            onOversize(size);
            socket.close();
          }
        },
        { capture: true },
      );
      return socket;
    }
  }
  return BoundedWebSocket as unknown as typeof WebSocket;
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
  if (!Array.isArray(socket.channels)) {
    return "unknown";
  }
  return socket.channels.length;
}
