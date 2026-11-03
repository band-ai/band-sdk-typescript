declare module "phoenix" {
  export interface Push {
    receive(
      status: "ok" | "error" | "timeout",
      callback: (response?: unknown) => void,
    ): Push;
  }

  export class Channel {
    on(event: string, callback: (payload: Record<string, unknown>) => void): number;
    off(event: string, ref?: number): void;
    join(): Push;
    leave(): Push;
  }

  export interface SocketOptions {
    params?: Record<string, unknown>;
    heartbeatIntervalMs?: number;
    reconnectAfterMs?: (tries: number) => number;
    transport?: typeof WebSocket;
  }

  export class Socket {
    readonly conn: WebSocket | null;
    constructor(url: string, options?: SocketOptions);
    // Private in phoenix; verified against phoenix 1.8.16, which the SDK pins.
    // Every connect attempt passes through transportConnect().
    protected transportConnect(): void;
    // Runs before phoenix asks reconnectAfterMs for the next delay.
    protected onConnClose(event?: { code?: number; reason?: string }): void;
    channel(topic: string, params?: Record<string, unknown>): Channel;
    connect(): void;
    disconnect(callback?: () => void, code?: number, reason?: string): void;
    onOpen(callback: () => void): number;
    onClose(callback: () => void): number;
    onError(callback: (event: unknown) => void): number;
  }
}
