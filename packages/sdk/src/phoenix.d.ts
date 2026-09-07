declare module "phoenix" {
  export interface Push {
    receive(
      status: "ok" | "error" | "timeout",
      callback: (response?: unknown) => void,
    ): Push;
  }

  export class Channel {
    topic: string;
    on(event: string, callback: (payload: Record<string, unknown>) => void): number;
    off(event: string, ref?: number): void;
    join(): Push;
    leave(): Push;
  }

  export interface SocketOptions {
    params?: Record<string, unknown>;
    heartbeatIntervalMs?: number;
    reconnectAfterMs?: (tries: number) => number;
    rejoinAfterMs?: (tries: number) => number;
    transport?: typeof WebSocket;
  }

  export class Socket {
    channels: Channel[];
    reconnectTimer?: { reset(): void; scheduleTimeout(): void };
    constructor(url: string, options?: SocketOptions);
    channel(topic: string, params?: Record<string, unknown>): Channel;
    connect(): void;
    disconnect(): void;
    onOpen(callback: () => void): number;
    onClose(callback: (event?: { code?: number; reason?: string }) => void): number;
    onError(callback: (event: unknown) => void): number;
    makeRef(): string;
    remove(channel: Channel): void;
  }
}
