import type { AddressInfo } from "node:net";
import { agentControlTopic } from "@band-ai/band-sdk-core";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

import { RecordLog } from "./testUtils";

type JoinOutcome = "ok" | "error" | "pending";
type PhoenixMessage = [string | null, string | null, string, string, unknown];

export interface FakePhoenixPeerOptions {
  /** As the platform does, refuse with 409 a connection asking `on_conflict=reject` while its agent already has one. */
  readonly rejectConflicts?: boolean;
}

const CONFLICT_STATUS = 409;
const CONFLICT_BODY = JSON.stringify({ error: { code: "connection_conflict", message: "Connection already exists for this agent." } });
/** How long after an eviction the platform refuses another take-over of the same agent. */
export const TAKEOVER_COOLDOWN_MS = 30_000;
const COOLDOWN_STATUS = 429;
const JSON_HEADERS = { "Content-Type": "application/json" };

interface PendingJoin {
  socket: ServerSocket;
  joinRef: string | null;
  ref: string | null;
}

/**
 * The shared `ws` shim only types the WHATWG-compatible client shape; a
 * server-side connection also needs the Node-specific event-emitter surface
 * (`.on`, `.terminate`, `.pause`), same local-augmentation approach as
 * `nodeWebSocketFactory.ts`.
 */
type ServerSocket = InstanceType<typeof NodeWebSocket> & {
  on(event: "close", listener: () => void): ServerSocket;
  on(event: "message", listener: (data: Buffer) => void): ServerSocket;
  send(data: string): void;
  terminate(): void;
  pause(): void;
  resume(): void;
};

/**
 * A minimal server-side implementation of the Phoenix Channels V2 JSON wire
 * protocol (`[join_ref, ref, topic, event, payload]`), just enough to drive
 * the real `phoenix` client through join/leave/heartbeat and an actual
 * severed-connection reconnect — not a reimplementation of Phoenix itself.
 */
export class FakePhoenixPeer implements AsyncDisposable {
  private readonly wss: WebSocketServer;
  /** Each open connection, with the agent it is for. */
  private readonly sockets = new Map<ServerSocket, string | null>();
  private readonly joinOutcomeQueues = new Map<string, JoinOutcome[]>();
  private readonly pendingJoins = new Map<string, PendingJoin>();
  public readonly receivedEvents: Array<{ topic: string; event: string }> = [];
  /** Every topic a client joined, in order; await it to act once a join is in. */
  public readonly joined = new RecordLog<string>();
  public readonly left = new RecordLog<string>();
  public readonly closed = new RecordLog<string | null>();
  /** The request URL of every connection, in order, with its query parameters. */
  public readonly connectionUrls: string[] = [];
  /** When each evicted agent may be taken over again, in ms since the epoch. */
  private readonly cooldownEnds = new Map<string, number>();

  private constructor({ rejectConflicts = false }: FakePhoenixPeerOptions) {
    this.wss = new WebSocketServer({
      port: 0,
      verifyClient: ({ req }, done) => {
        const params = connectionParams(req.url ?? "");
        const agentId = params.get("agent_id");
        const held = agentId !== null && [...this.sockets.values()].includes(agentId);
        if (rejectConflicts && held && params.get("on_conflict") === "reject") {
          done(false, CONFLICT_STATUS, CONFLICT_BODY, JSON_HEADERS);
        } else if (held && params.get("on_conflict") === "supersede") {
          this.takeOver(agentId, done);
        } else {
          done(true);
        }
      },
    });
    this.wss.on("connection", (socket, request) => this.handleConnection(socket as ServerSocket, request.url ?? ""));
  }

  public static async start(options: FakePhoenixPeerOptions = {}): Promise<FakePhoenixPeer> {
    const peer = new FakePhoenixPeer(options);
    await new Promise<void>((resolve) => peer.wss.once("listening", resolve));
    return peer;
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
    for (const socket of this.sockets.keys()) {
      socket.terminate();
    }
    this.sockets.clear();
    this.pendingJoins.clear();
  }

  /**
   * Stops reading from every open connection, so a client's close frame is
   * never answered and its close handshake stalls — a slow or lossy link.
   * `WebSocket#pause()` rather than the raw socket's: `ws` never resumes it.
   */
  public stallReads(): void {
    for (const socket of this.sockets.keys()) {
      socket.pause();
    }
  }

  public resumeReads(): void {
    for (const socket of this.sockets.keys()) {
      socket.resume();
    }
  }

  public get activeConnectionCount(): number {
    return this.sockets.size;
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
    for (const socket of this.sockets.keys()) {
      socket.send(JSON.stringify(message));
    }
  }

  public get connectionCount(): number {
    return this.connectionUrls.length;
  }

  /** Once the agent has joined its control channel, hands the agent to another connection, as the platform does for a second socket by default. */
  public async supersede(agentId: string): Promise<void> {
    await this.joined.next((joinedTopic) => joinedTopic === agentControlTopic(agentId));
    this.evict(agentId);
  }

  public async stop(): Promise<void> {
    this.severAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => (error ? reject(error) : resolve()));
    });
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  /** As the platform answers an `on_conflict=supersede` connection for a held agent: evicts the holder, or refuses within the cooldown. */
  private takeOver(agentId: string, done: (accept: boolean, status?: number, message?: string, headers?: Record<string, string>) => void): void {
    const remainingMs = (this.cooldownEnds.get(agentId) ?? 0) - Date.now();
    if (remainingMs > 0) {
      const retryAfter = Math.ceil(remainingMs / 1000);
      const body = JSON.stringify({ error: { code: "too_many_requests", message: "Agent was just taken over; try again shortly.", retry_after: retryAfter } });
      done(false, COOLDOWN_STATUS, body, { ...JSON_HEADERS, "Retry-After": String(retryAfter) });
      return;
    }
    this.evict(agentId);
    done(true);
  }

  /** Tells the agent's connections they lost it, and stamps the take-over cooldown. */
  private evict(agentId: string): void {
    this.cooldownEnds.set(agentId, Date.now() + TAKEOVER_COOLDOWN_MS);
    const message: PhoenixMessage = [null, null, agentControlTopic(agentId), "supersede", {
      reason: "session.already_connected",
      message: "superseded",
      retryable: false,
      correlation_id: null,
    }];
    for (const [socket, holder] of this.sockets) {
      if (holder === agentId) {
        socket.send(JSON.stringify(message));
      }
    }
  }

  private handleConnection(socket: ServerSocket, url: string): void {
    this.connectionUrls.push(url);
    this.sockets.set(socket, connectionParams(url).get("agent_id"));
    socket.on("close", () => {
      const agentId = this.sockets.get(socket) ?? null;
      this.sockets.delete(socket);
      this.closed.record(agentId);
    });
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
      this.joined.record(topic);
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
    if (event === "phx_leave") this.left.record(topic);
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

function connectionParams(url: string): URLSearchParams {
  return new URL(url, "ws://peer").searchParams;
}

function responseFor(outcome: Exclude<JoinOutcome, "pending">): unknown {
  return outcome === "ok" ? {} : { reason: "rejected" };
}
