/**
 * A Cursor agent peer on the far side of a real ACP connection: the adapter's
 * `ClientSideConnection` and this peer's `AgentSideConnection` speak JSON-RPC
 * over in-memory streams, so every request crosses the wire the way it does
 * with `cursor-agent`. Each prompt runs the next scripted turn.
 */
import path from "node:path";

import { AgentSideConnection, ClientSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";

import type { ACPClientConnectionFactory } from "../../../src/adapters/acp/types";
import { MCP_SERVER_NAME } from "../../../src/contracts/toolSchemas";
import { createDeferred, type Deferred } from "../../../src/core/deferred";
import { CallHolds, RecordLog, type HeldCall } from "../../testUtils";

export interface Received {
  readonly method: string;
  readonly params: unknown;
}

/** What a scripted turn can do while Cursor holds the prompt. */
export interface CursorTurn {
  readonly sessionId: string;
  ask(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  plan(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  requestPermission(params: Omit<schema.RequestPermissionRequest, "sessionId">): Promise<schema.RequestPermissionResponse>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  say(text: string): Promise<void>;
  /**
   * Reports a Band tool Cursor ran, and finished, on an MCP server of its own:
   * Band learns of the call only from this stream. The call is named in its
   * first frame.
   */
  callTool(toolName: string, args?: Record<string, unknown>): Promise<void>;
}

type Script = (turn: CursorTurn) => Promise<unknown>;

interface QueuedTurn {
  script: Script;
  result: Deferred<unknown>;
}

/** An in-memory byte pipe the peer can hang up on. */
function pipe() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const writable = new WritableStream<Uint8Array>({ write: (chunk) => controller.enqueue(chunk) });
  const hangUp = () => {
    try {
      controller.close();
    } catch {
      // Already closed.
    }
  };
  return { readable, writable, hangUp };
}

/** Room a test addresses when it does not name one. */
export const DEFAULT_CURSOR_ROOM = "room-1";

/**
 * The Cursor processes the adapter starts, one per room. A room is told apart
 * by the workspace its process is launched in, which ends in the room id.
 */
export class FakeCursorAgent {
  public readonly received = new RecordLog<Received>();
  /** The environment each Cursor process was launched with. */
  public readonly launchEnvs: Array<Record<string, string> | undefined> = [];
  private readonly rooms = new Map<string, FakeCursorRoom>();

  /** Hands the adapter a real ACP connection to that room's Cursor process. */
  public readonly connectionFactory: ACPClientConnectionFactory = async (client, { env, cwd }) => {
    this.launchEnvs.push(env);
    return this.room(path.basename(cwd ?? DEFAULT_CURSOR_ROOM)).connect(client);
  };

  public room(roomId: string): FakeCursorRoom {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new FakeCursorRoom(this.received);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  /** Queues the script the next prompt in the default room runs. */
  public nextTurn<R>(script: (turn: CursorTurn) => Promise<R>): Promise<R> {
    return this.room(DEFAULT_CURSOR_ROOM).nextTurn(script);
  }

  public receivedOf(method: string): unknown[] {
    return this.received.entries.filter((request) => request.method === method).map((request) => request.params);
  }
}

/** One room's Cursor processes, one at a time: scripted turns, and the live connection. */
export class FakeCursorRoom {
  /** Processes started for this room. */
  public launches = 0;
  /** Whether the latest process has been stopped. */
  public stopped = false;
  /** A process that ignores being stopped keeps talking over its connection. */
  public lingersOnStop = false;
  private readonly turns: QueuedTurn[] = [];
  private sessions = 0;
  private toolCalls = 0;
  private readonly sessionHolds = new CallHolds<[]>();
  private peer: AgentSideConnection | null = null;

  public constructor(private readonly received: RecordLog<Received>) {}

  public connect(client: schema.Client): ReturnType<ACPClientConnectionFactory> {
    this.launches++;
    this.stopped = false;
    // A new process numbers its sessions from the start again.
    this.sessions = 0;
    const toAgent = pipe();
    const toClient = pipe();
    this.peer = new AgentSideConnection(() => this.agent(), ndJsonStream(toClient.writable, toAgent.readable));
    const connection = new ClientSideConnection(() => client, ndJsonStream(toAgent.writable, toClient.readable));
    return Promise.resolve({
      connection,
      stop: async () => {
        this.stopped = true;
        if (!this.lingersOnStop) {
          toAgent.hangUp();
          toClient.hangUp();
        }
      },
    });
  }

  /** Holds the next new session until released: the room's next turn stays mid-establishment. */
  public holdSession(): HeldCall<[]> {
    return this.sessionHolds.hold(() => true);
  }

  /** Queues the script the next prompt runs; resolves with what it returned. */
  public nextTurn<R>(script: (turn: CursorTurn) => Promise<R>): Promise<R> {
    const result = createDeferred<unknown>();
    this.turns.push({ script, result });
    return result.promise as Promise<R>;
  }

  private record(method: string, params: unknown): void {
    this.received.record({ method, params });
  }
  private agent(): Agent {
    return {
      initialize: async (params) => {
        this.record("initialize", params);
        return { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [{ id: "cursor_login", name: "Cursor login" }] };
      },
      authenticate: async (params) => {
        this.record("authenticate", params);
        return {};
      },
      newSession: async (params) => {
        this.record("session/new", params);
        await this.sessionHolds.pass();
        return { sessionId: `cursor-session-${++this.sessions}` };
      },
      prompt: async (params) => {
        this.record("session/prompt", params);
        const queued = this.turns.shift();
        if (queued) {
          queued.result.resolve(await queued.script(this.turn(params.sessionId)));
        }
        return { stopReason: "end_turn" };
      },
      cancel: async (params) => {
        this.record("session/cancel", params);
      },
    };
  }

  private turn(sessionId: string): CursorTurn {
    const peer = this.peer!;
    return {
      sessionId,
      ask: (params) => peer.extMethod("cursor/ask_question", { sessionId, ...params }),
      plan: (params) => peer.extMethod("cursor/create_plan", { sessionId, ...params }),
      extMethod: (method, params) => peer.extMethod(method, { sessionId, ...params }),
      requestPermission: (params) => peer.requestPermission({ sessionId, ...params }),
      notify: (method, params) => peer.extNotification(method, { sessionId, ...params }),
      say: (text) => peer.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }),
      callTool: (toolName, args = {}) => peer.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `call-${++this.toolCalls}`,
          title: `${MCP_SERVER_NAME}: ${toolName}`,
          status: "completed",
          rawInput: { providerIdentifier: MCP_SERVER_NAME, toolName, args },
        },
      }),
    };
  }
}
