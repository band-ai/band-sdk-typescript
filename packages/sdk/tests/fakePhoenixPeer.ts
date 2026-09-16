import type { AddressInfo } from "node:net";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

type JoinOutcome = "ok" | "error" | "pending";
type PhoenixMessage = [string | null, string | null, string, string, unknown];

interface PendingJoin {
  socket: ServerSocket;
  joinRef: string | null;
  ref: string | null;
}

/**
 * The shared `ws` shim only types the WHATWG-compatible client shape; a
 * server-side connection also needs the Node-specific event-emitter surface
 * (`.on`, `.terminate`), same local-augmentation approach as
 * `nodeWebSocketFactory.ts`.
 */
type ServerSocket = InstanceType<typeof NodeWebSocket> & {
  on(event: "close", listener: () => void): ServerSocket;
  on(event: "message", listener: (data: Buffer) => void): ServerSocket;
  send(data: string): void;
  terminate(): void;
};

/**
 * A minimal server-side implementation of the Phoenix Channels V2 JSON wire
 * protocol (`[join_ref, ref, topic, event, payload]`), just enough to drive
 * the real `phoenix` client through join/leave/heartbeat and an actual
 * severed-connection reconnect — not a reimplementation of Phoenix itself.
 */
export class FakePhoenixPeer {
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<ServerSocket>();
  private readonly joinOutcomeQueues = new Map<string, JoinOutcome[]>();
  private readonly pendingJoins = new Map<string, PendingJoin>();
  public readonly receivedEvents: Array<{ topic: string; event: string }> = [];

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    this.wss.on("connection", (socket) => this.handleConnection(socket as ServerSocket));
  }

  public static async start(): Promise<FakePhoenixPeer> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    return new FakePhoenixPeer(wss);
  }

  public get url(): string {
    const { port } = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/socket`;
  }

  /**
   * Queues this topic's next `phx_join` outcomes in order (one per rejoin
   * attempt); once the queue is empty, later joins default to "ok".
   */
  public queueJoinOutcomes(topic: string, outcomes: JoinOutcome[]): void {
    this.joinOutcomeQueues.set(topic, [...outcomes]);
  }

  /** Forcibly drops every open connection, simulating a network failure. */
  public severAllConnections(): void {
    for (const socket of this.sockets) {
      socket.terminate();
    }
    this.sockets.clear();
    this.pendingJoins.clear();
  }

  public settleJoin(topic: string, outcome: Exclude<JoinOutcome, "pending">): void {
    const pending = this.pendingJoins.get(topic);
    if (!pending) {
      throw new Error(`No pending join for ${topic}`);
    }
    this.pendingJoins.delete(topic);
    this.reply(pending.socket, pending.joinRef, pending.ref, topic, outcome, responseFor(outcome));
  }

  public push(topic: string, event: string, payload: unknown): void {
    const message: PhoenixMessage = [null, null, topic, event, payload];
    for (const socket of this.sockets) {
      socket.send(JSON.stringify(message));
    }
  }

  public async stop(): Promise<void> {
    this.severAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private handleConnection(socket: ServerSocket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("message", (data) => {
      this.handleMessage(socket, data.toString());
    });
  }

  private handleMessage(socket: ServerSocket, raw: string): void {
    const [joinRef, ref, topic, event] = JSON.parse(raw) as PhoenixMessage;
    if (event !== "heartbeat") {
      this.receivedEvents.push({ topic, event });
    }

    if (event === "phx_join") {
      const outcome = this.joinOutcomeQueues.get(topic)?.shift() ?? "ok";
      if (outcome === "pending") {
        this.pendingJoins.set(topic, { socket, joinRef, ref });
        return;
      }
      this.reply(socket, joinRef, ref, topic, outcome, responseFor(outcome));
      return;
    }

    // phx_leave, heartbeat, and any other client push all just need an "ok"
    // reply so the caller's Push settles instead of timing out.
    this.reply(socket, joinRef, ref, topic, "ok", {});
  }

  private reply(
    socket: ServerSocket,
    joinRef: string | null,
    ref: string | null,
    topic: string,
    status: Exclude<JoinOutcome, "pending">,
    response: unknown,
  ): void {
    const message: PhoenixMessage = [joinRef, ref, topic, "phx_reply", { status, response }];
    socket.send(JSON.stringify(message));
  }
}

function responseFor(outcome: Exclude<JoinOutcome, "pending">): unknown {
  return outcome === "ok" ? {} : { reason: "rejected" };
}
