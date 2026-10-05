declare module "ws" {
  export const WebSocket: typeof globalThis.WebSocket;

  export class WebSocketServer {
    public constructor(options: {
      port: number;
      verifyClient?: (
        info: { req: import("node:http").IncomingMessage },
        done: (accept: boolean, code?: number, body?: string, headers?: Record<string, string>) => void,
      ) => void;
    });
    public address(): import("node:net").AddressInfo;
    public close(callback: (error?: Error) => void): void;
    public on(
      event: "connection",
      listener: (socket: InstanceType<typeof WebSocket>, request: import("node:http").IncomingMessage) => void,
    ): void;
    public once(event: "listening", listener: () => void): void;
  }
}
