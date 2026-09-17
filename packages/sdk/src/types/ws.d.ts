declare module "ws" {
  export const WebSocket: typeof globalThis.WebSocket;

  export class WebSocketServer {
    public constructor(options: { port: number });
    public address(): import("node:net").AddressInfo;
    public close(callback: (error?: Error) => void): void;
    public on(
      event: "connection",
      listener: (socket: InstanceType<typeof WebSocket>) => void,
    ): void;
    public once(event: "listening", listener: () => void): void;
  }
}
