import { Channel, Socket } from "phoenix";
import { WebSocket as NodeWebSocket } from "ws";
import { TransportError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import type { StreamingTransport, TopicHandlers } from "./transport";

interface PhoenixChannelsTransportOptions {
  wsUrl: string;
  apiKey: string;
  agentId?: string;
  logger?: Logger;
  heartbeatIntervalMs?: number;
  reconnectAfterMs?: (tries: number) => number;
  /**
   * Optional WebSocket implementation. Phoenix authentication is sent in the
   * x-api-key handshake header, so browser WebSocket constructors are not
   * sufficient; pass a Node-compatible constructor that accepts headers.
   */
  websocketFactory?: typeof WebSocket;
}

type HeaderWebSocketConstructor = new (
  url: string | URL,
  protocols?: string | string[],
  options?: { headers: Record<string, string> },
) => WebSocket;

const PHOENIX_WEBSOCKET_SUFFIX = "/websocket";
const API_KEY_PARAM = "api_key";
const API_KEY_HEADER = "x-api-key";

export class PhoenixChannelsTransport implements StreamingTransport {
  private readonly socket: Socket;
  private readonly channels = new Map<string, Channel>();
  private readonly channelRefs = new Map<string, Array<[string, number]>>();
  private readonly pendingJoins = new Map<string, Promise<void>>();
  private readonly logger: Logger;
  private onHandlerError?: (error: unknown) => void;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;

  public constructor(options: PhoenixChannelsTransportOptions) {
    this.logger = options.logger ?? new NoopLogger();

    this.socket = new Socket(normalizePhoenixEndpoint(options.wsUrl), {
      params: buildPhoenixParams(options.agentId),
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      reconnectAfterMs: options.reconnectAfterMs ??
        ((tries: number) => [1_000, 2_000, 5_000, 10_000, 30_000][tries - 1] ?? 30_000),
      transport: createApiKeyHeaderWebSocketFactory(options.apiKey, options.websocketFactory),
    });

    this.socket.onOpen(() => {
      this.connected = true;
      this.connectResolve?.();
      this.connectResolve = null;
      this.logger.info("Phoenix socket opened", {
        channels: getSocketChannelCount(this.socket),
      });
    });

    this.socket.onClose((event?: { code?: number; reason?: string }) => {
      this.connected = false;

      // If there are no active channels, stop reconnecting — the socket has
      // nothing to rejoin and would just churn connections.
      if (getSocketChannelCount(this.socket) === 0) {
        this.socket.disconnect();
      }

      this.logger.info("Phoenix socket closed", {
        code: event?.code ?? null,
        reason: event?.reason ?? null,
      });
    });

    this.socket.onError((event) => {
      this.logger.warn("Phoenix socket error", { event });
    });
  }

  public async connect(): Promise<void> {
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
    if (signal.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  private async waitForConnection(timeoutMs = 10_000): Promise<void> {
    if (this.connected) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.connectResolve = null;
        reject(new TransportError("Timed out waiting for Phoenix socket connection"));
      }, timeoutMs);

      this.connectResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }
}

function buildPhoenixParams(agentId: string | undefined): Record<string, string> {
  return agentId ? { agent_id: agentId } : {};
}

function normalizePhoenixEndpoint(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl);
    parsed.searchParams.delete(API_KEY_PARAM);
    if (parsed.pathname.endsWith(PHOENIX_WEBSOCKET_SUFFIX)) {
      parsed.pathname = parsed.pathname.slice(0, -PHOENIX_WEBSOCKET_SUFFIX.length);
    }
    return parsed.toString();
  } catch {
    const [withoutFragment, fragment = ""] = wsUrl.split("#", 2);
    const [path, query = ""] = withoutFragment.split("?", 2);
    const normalizedPath = path.endsWith(PHOENIX_WEBSOCKET_SUFFIX)
      ? path.slice(0, -PHOENIX_WEBSOCKET_SUFFIX.length)
      : path;
    const filteredQuery = new URLSearchParams(query);
    filteredQuery.delete(API_KEY_PARAM);
    const queryString = filteredQuery.toString();
    return `${normalizedPath}${queryString ? `?${queryString}` : ""}${fragment ? `#${fragment}` : ""}`;
  }
}

function createApiKeyHeaderWebSocketFactory(
  apiKey: string,
  websocketFactory?: typeof WebSocket,
): typeof WebSocket {
  const WebSocketConstructor = websocketFactory
    ? (websocketFactory as unknown as HeaderWebSocketConstructor)
    : getNodeWebSocketConstructor();

  class ApiKeyHeaderWebSocket {
    public constructor(url: string | URL, protocols?: string | string[]) {
      return new WebSocketConstructor(url, protocols, {
        headers: {
          [API_KEY_HEADER]: apiKey,
        },
      });
    }
  }

  return ApiKeyHeaderWebSocket as unknown as typeof WebSocket;
}

function getNodeWebSocketConstructor(): HeaderWebSocketConstructor {
  if (!(typeof process !== "undefined" && process.versions?.node)) {
    throw new TransportError(
      "Phoenix WebSocket API-key auth requires a WebSocket transport that can set handshake headers.",
    );
  }

  return NodeWebSocket as unknown as HeaderWebSocketConstructor;
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
