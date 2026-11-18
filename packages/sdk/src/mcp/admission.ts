import { AsyncLocalStorage } from "node:async_hooks";

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { AdapterToolsProtocol } from "../contracts/protocols";
import { fenceTurnForKeyedAdmission } from "../runtime/journal/journalTools";

/** The actual tools of the turn a keyed call was admitted on, and the room it names. */
export interface AdmissionOrigin {
  /** The turn's real tools as they stood at admission: a snapshot, not a forwarding proxy that a later turn could replace under the call. */
  tools: AdapterToolsProtocol;
  /** The room the call was admitted in, on a room-scoped bridge; absent on a single-context bridge, where the call names no room. */
  roomId?: string;
  /** The bridge confirmed the origin still stood current when it admitted the call. */
  isCurrent?: boolean;
}

/**
 * Resolves a keyed call's origin synchronously from the room it names, as the
 * bridge sees it: the room's actual tools, or nothing. A resolver that throws
 * or finds no room leaves the call without an origin: it is forwarded, but no
 * turn is fenced or selected for it.
 */
export type OriginResolver = (roomId: string) => AdmissionOrigin | undefined;

/** What the transport recorded for the message running in this async scope. */
export interface Admission {
  /** The call carried an `operation_id`, valid or not: it was admitted at the raw call. */
  keyed: boolean;
  /** The origin the bridge pinned for it, when one stood. */
  origin: AdmissionOrigin | undefined;
}

const admissionStorage = new AsyncLocalStorage<Admission>();

/** The admission standing in this async scope: a keyed call's, or nothing elsewhere. */
export function currentAdmission(): Admission | undefined {
  return admissionStorage.getStore();
}

/**
 * Whether the raw call's arguments carry an operation id under any value
 * type: presence admits the call, not validity — the journal decides what the
 * id stands for after the framework's own validation has had its say. A
 * `tools/call`'s arguments stand under `params.arguments`, per the protocol.
 */
export function hasKeyedOperation(params: unknown): boolean {
  const arguments_ = keyedArguments(params);
  return arguments_ !== undefined && Object.hasOwn(arguments_, "operation_id");
}

/** The `tools/call`'s arguments, when the params carry an object of them. */
function keyedArguments(params: unknown): Record<string, unknown> | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const arguments_ = (params as { arguments?: unknown }).arguments;
  if (typeof arguments_ !== "object" || arguments_ === null) {
    return undefined;
  }
  return arguments_ as Record<string, unknown>;
}

const TOOLS_CALL = "tools/call" as const;

/**
 * The one decorator every Band MCP bridge installs between its client-facing
 * transport and the framework's dispatch: HTTP, SSE, stdio, and the in-process
 * SDK server. A `tools/call` that carries an `operation_id` is admitted here,
 * before the framework's schema, capability, or business validation — the
 * turn it stands on is fenced, the origin's actual tools are pinned, and the
 * call is handed on running in that origin's admission scope. Anything that is
 * not a keyed tool call passes through untouched, and the full transport
 * surface — callbacks, sends, session, protocol, cancellation, cleanup — is
 * forwarded unchanged.
 */
export class AdmissionTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: Transport["onmessage"];
  private readonly inner: Transport;
  private readonly originResolver: OriginResolver | undefined;

  public constructor(inner: Transport, originResolver?: OriginResolver) {
    this.inner = inner;
    this.originResolver = originResolver;
  }

  /** `Protocol.connect` sets this transport's handlers just before calling it. */
  public start(): Promise<void> {
    const outer = this.onmessage;
    this.inner.onmessage = (message, extra) => {
      const admission = this.admit(message);
      if (admission === undefined) {
        outer?.(message, extra);
        return;
      }
      // The keyed call's execution, however far it runs and whatever the
      // framework answers, stays in the admission it was given.
      admissionStorage.run(admission, () => outer?.(message, extra));
    };
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    return this.inner.start();
  }

  public async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.inner.send(message, options);
  }

  public close(): Promise<void> {
    return this.inner.close();
  }

  /**
   * The admission for one inbound message: nothing for a message that is not a
   * keyed tool call; otherwise, in one synchronous step, the origin is
   * resolved and pinned and the turn it stands on is fenced. A resolver that
   * cannot prove an origin leaves the call admitted but originless: fenced on
   * nothing, forwarded on.
   */
  private admit(message: JSONRPCMessage): Admission | undefined {
    if (!("method" in message) || message.method !== TOOLS_CALL) {
      return undefined;
    }
    const params = message.params;
    if (!hasKeyedOperation(params)) {
      return undefined;
    }
    let origin: AdmissionOrigin | undefined;
    if (this.originResolver !== undefined) {
      const roomId = rawRoomId(params);
      try {
        origin = this.originResolver(roomId);
      } catch {
        origin = undefined;
      }
    }
    fenceTurnForKeyedAdmission(origin?.tools);
    return { keyed: true, origin };
  }

  public get innerTransport(): Transport {
    return this.inner;
  }
}

/** The room the raw call names, as given: its `room_id` argument when it is a string, else none. */
function rawRoomId(params: unknown): string {
  const arguments_ = keyedArguments(params);
  if (arguments_ === undefined) {
    return "";
  }
  const roomId = arguments_.room_id;
  return typeof roomId === "string" ? roomId : "";
}

/**
 * The origin of a keyed call on a bridge built around `getToolsForRoom`: the
 * room's actual tools, resolved synchronously, with `guard` — a bridge's
 * check that its connection or generation still stands — consulted before any
 * tools are resolved, so a retired bridge admits no origin at all.
 */
export function buildOriginResolver(
  getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined,
  multiRoom: boolean,
  guard?: () => boolean,
): OriginResolver {
  return (roomId: string) => {
    if (guard !== undefined && !guard()) {
      return undefined;
    }
    let tools: AdapterToolsProtocol | undefined;
    try {
      tools = multiRoom ? getToolsForRoom(roomId) : getToolsForRoom("");
    } catch {
      return undefined;
    }
    if (tools === undefined) {
      return undefined;
    }
    return { tools, ...(multiRoom ? { roomId } : {}), isCurrent: true };
  };
}