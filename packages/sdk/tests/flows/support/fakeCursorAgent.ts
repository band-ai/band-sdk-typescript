/**
 * A Cursor agent peer on the far side of a real ACP connection: the adapter's
 * `ClientSideConnection` and this peer's `AgentSideConnection` speak JSON-RPC
 * over in-memory streams, so every request crosses the wire the way it does
 * with `cursor-agent`. Each prompt runs the next scripted turn.
 */
import { AgentSideConnection, ClientSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";

import type { ACPClientConnectionFactory } from "../../../src/adapters/acp/types";
import { createDeferred, type Deferred } from "../../../src/core/deferred";
import { TrafficLog } from "../../testUtils";

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

export class FakeCursorAgent {
  public readonly received: Received[] = [];
  /** The environment each Cursor process was launched with. */
  public readonly launchEnvs: Array<Record<string, string> | undefined> = [];
  private readonly traffic = new TrafficLog();
  private readonly turns: QueuedTurn[] = [];
  private sessions = 0;
  private peer: AgentSideConnection | null = null;

  /** Hands the adapter a real ACP connection to this peer. */
  public readonly connectionFactory: ACPClientConnectionFactory = async (client, { env }) => {
    this.launchEnvs.push(env);
    const toAgent = pipe();
    const toClient = pipe();
    this.peer = new AgentSideConnection(() => this.agent(), ndJsonStream(toClient.writable, toAgent.readable));
    const connection = new ClientSideConnection(() => client, ndJsonStream(toAgent.writable, toClient.readable));
    return {
      connection,
      stop: async () => {
        toAgent.hangUp();
        toClient.hangUp();
      },
    };
  };

  /** Queues the script the next prompt runs; resolves with what it returned. */
  public nextTurn<R>(script: (turn: CursorTurn) => Promise<R>): Promise<R> {
    const result = createDeferred<unknown>();
    this.turns.push({ script, result });
    return result.promise as Promise<R>;
  }

  public receivedOf(method: string): unknown[] {
    return this.received.filter((request) => request.method === method).map((request) => request.params);
  }

  public until(predicate: () => boolean): Promise<void> {
    return this.traffic.until(predicate);
  }

  private record(method: string, params: unknown): void {
    this.received.push({ method, params });
    this.traffic.record();
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
    };
  }
}
