import { Channel, Socket } from "phoenix";
import { WebSocket as NodeWebSocket } from "ws";
import { TransportError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import {
  WebSocketDisconnectError,
  genericCloseReason,
  parseSupersedeDisconnectReason,
  parseUpgradeDisconnectReason,
  type WebSocketDisconnectReason,
} from "./disconnectReason";
import type { StreamingTransport, TopicHandlers } from "./transport";

interface PhoenixChannelsTransportOptions {
  wsUrl: string;
  apiKey: string;
  agentId?: string;
  logger?: Logger;
  heartbeatIntervalMs?: number;
  reconnectAfterMs?: (tries: number) => number;
  websocketFactory?: typeof WebSocket;
  onTerminalDisconnect?: (reason: WebSocketDisconnectReason) => void;
}

export class PhoenixChannelsTransport implements StreamingTransport {
  private readonly socket: Socket;
  private readonly agentId?: string;
  private readonly channels = new Map<string, Channel>();
  private readonly channelRefs = new Map<string, Array<[string, number]>>();
  private readonly pendingJoins = new Map<string, Promise<void>>();
  private readonly logger: Logger;
  private readonly onTerminalDisconnect?: (reason: WebSocketDisconnectReason) => void;
  private onHandlerError?: (error: unknown) => void;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private lastDisconnectReason: WebSocketDisconnectReason | null = null;
  private terminalDisconnectError: WebSocketDisconnectError | null = null;
  private runForeverRejects = new Set<(error: unknown) => void>();

  public constructor(options: PhoenixChannelsTransportOptions) {
    this.logger = options.logger ?? new NoopLogger();
    this.agentId = options.agentId;
    this.onTerminalDisconnect = options.onTerminalDisconnect;

    // The phoenix JS library appends /websocket to the endpoint URL.
    // Strip it if the user-provided URL already includes it.
    let wsUrl = options.wsUrl;
    if (wsUrl.endsWith("/websocket")) {
      wsUrl = wsUrl.slice(0, -"/websocket".length);
    }

    const reconnectAfterMs = options.reconnectAfterMs ??
      ((tries: number) => [1_000, 2_000, 5_000, 10_000, 30_000][tries - 1] ?? 30_000);

    this.socket = new Socket(wsUrl, {
      params: {
        api_key: options.apiKey,
        agent_id: options.agentId,
      },
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      reconnectAfterMs: (tries: number) => {
        if (this.terminalDisconnectError) {
          return Number.POSITIVE_INFINITY;
        }
        return reconnectAfterMs(tries);
      },
      transport: options.websocketFactory ?? resolveWebSocketFactory(),
    });

    this.socket.onOpen(() => {
      this.connected = true;
      void this.handleOpen();
    });

    this.socket.onClose((event?: { code?: number; reason?: string }) => {
      this.connected = false;
      if (!this.terminalDisconnectError) {
        this.lastDisconnectReason = genericCloseReason(event);
      }

      // If there are no active channels, stop reconnecting — the socket has
      // nothing to rejoin and would just churn connections. Terminal platform
      // disconnects call socket.disconnect() as soon as they are recorded, so
      // avoid re-entering disconnect from the close callback.
      if (!this.terminalDisconnectError && getSocketChannelCount(this.socket) === 0) {
        this.socket.disconnect();
      }

      this.logger.info("Phoenix socket closed", {
        code: event?.code ?? null,
        reason: event?.reason ?? null,
        platformReason: this.lastDisconnectReason,
      });
    });

    this.socket.onError((event) => {
      const upgradeReason = parseUpgradeDisconnectReason(event);
      if (upgradeReason) {
        this.lastDisconnectReason = upgradeReason;
        const error = new WebSocketDisconnectError(upgradeReason);
        this.connectReject?.(error);
        this.logger.warn("Phoenix socket upgrade failed", { reason: upgradeReason });
        return;
      }

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
    for (const topic of this.channels.keys()) {
      await this.leave(topic);
    }

    this.socket.disconnect();
    this.connected = false;
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

    try {
      await new Promise<void>((resolve, reject) => {
        channel
          .join()
          .receive("ok", () => resolve())
          .receive("error", (error: unknown) =>
            reject(new TransportError(`Failed to join topic ${topic}`, error)),
          )
          .receive("timeout", () => reject(new TransportError(`Timeout joining topic ${topic}`)));
      });
    } catch (error) {
      for (const [event, ref] of refs) {
        channel.off(event, ref);
      }
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
        .receive("timeout", () => reject(new TransportError(`Timeout leaving topic ${topic}`)));
    });

    this.channels.delete(topic);
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
      const onAbort = () => {
        this.runForeverRejects.delete(reject);
        resolve();
      };
      this.runForeverRejects.add(reject);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async handleOpen(): Promise<void> {
    try {
      await this.subscribeAgentControl();
    } catch (error) {
      this.connected = false;
      this.socket.disconnect();
      this.connectReject?.(error instanceof Error ? error : new TransportError(String(error)));
      this.logger.warn("Failed to join mandatory agent_control channel", { error });
      return;
    }

    this.connectResolve?.();
    this.connectResolve = null;
    this.connectReject = null;
    this.logger.info("Phoenix socket opened", {
      channels: getSocketChannelCount(this.socket),
    });
  }

  private async subscribeAgentControl(): Promise<void> {
    if (!this.agentId) {
      return;
    }

    await this.join(`agent_control:${this.agentId}`, {
      supersede: (payload) => {
        const reason = parseSupersedeDisconnectReason(payload);
        if (!reason) {
          this.logger.warn("Invalid agent_control supersede payload", { payload });
          return;
        }
        this.recordTerminalDisconnect(reason);
      },
    });
  }

  private recordTerminalDisconnect(reason: WebSocketDisconnectReason): void {
    if (this.terminalDisconnectError) {
      if (this.terminalDisconnectError.reason.source === "agent_control"
        && reason.source === "agent_control"
        && this.terminalDisconnectError.reason.correlationId
        && this.terminalDisconnectError.reason.correlationId === reason.correlationId) {
        return;
      }
    }

    this.lastDisconnectReason = reason;
    this.terminalDisconnectError = new WebSocketDisconnectError(reason);
    this.onTerminalDisconnect?.(reason);
    this.connectReject?.(this.terminalDisconnectError);
    for (const reject of this.runForeverRejects) {
      reject(this.terminalDisconnectError);
    }
    this.runForeverRejects.clear();
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
        reject(new TransportError("Timed out waiting for Phoenix socket connection"));
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
        reject(error instanceof Error ? error : new TransportError(String(error)));
      };
    });
  }
}

function resolveWebSocketFactory(): typeof WebSocket {
  if (typeof process !== "undefined" && process.versions?.node) {
    return NodeWebSocket as unknown as typeof WebSocket;
  }

  return WebSocket;
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
