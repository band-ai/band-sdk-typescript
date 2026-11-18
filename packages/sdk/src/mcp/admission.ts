import { AsyncLocalStorage } from "node:async_hooks";

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { AdapterToolsProtocol } from "../contracts/protocols";
import { NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../contracts/toolSchemas";
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
  /** The call's turn fence stood: the turn it was admitted on is fenced against an unkeyed replacement. When it did not stand, the dispatch is refused rather than run unfenced. */
  fenced: boolean;
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
    if (typeof inner.setProtocolVersion === "function") {
      const innerSet = inner.setProtocolVersion;
      this.setProtocolVersion = (version) => innerSet.call(inner, version);
    }
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
    // Compose, never replace: a caller that set handlers on the inner
    // transport before the decorator stood still gets them called.
    const innerClose = this.inner.onclose;
    this.inner.onclose = () => {
      innerClose?.();
      this.onclose?.();
    };
    const innerError = this.inner.onerror;
    this.inner.onerror = (error) => {
      innerError?.(error);
      this.onerror?.(error);
    };
    return this.inner.start();
  }

  /** The inner transport's session, so a framework that tracks it keeps tracking the real one. */
public get sessionId(): string | undefined {
  return this.inner.sessionId;
}

/** Extra surface some transports (notably the HTTP client's) expose for their session or protocol state. */
public get capabilities(): unknown {
  return (this.inner as { capabilities?: unknown }).capabilities;
}

/**
 * The framework's protocol version, set on the inner transport it actually
 * speaks on — the wrapper stands in for it only when the inner stands in
 * for it, so a framework checking `typeof transport.setProtocolVersion`
 * sees exactly what the inner supports.
 */
public setProtocolVersion?: (version: string) => void;

  public async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.inner.send(message, options);
  }

  public close(): Promise<void> {
    return this.inner.close();
  }

/**
   * The admission for one inbound message: nothing for a message that is not
   * a keyed tool call; otherwise, in one synchronous step, the origin is
   * resolved and pinned and the turn it stands on is fenced. A resolver that
   * cannot prove an origin leaves the call admitted but originless; a fence
   * that cannot be stood leaves the call admitted but unfenced — either way
   * the dispatch is refused rather than run against a turn it did not fence.
   */
  private admit(message: JSONRPCMessage): Admission | undefined {
    if (!("method" in message) || message.method !== TOOLS_CALL) {
      return undefined;
    }
    const params = message.params;
    if (!hasKeyedOperation(params)) {
      return undefined;
    }
    // Only the canonical publication tools admit: an unrelated tool or event
    // that carries its own operation_id passes through untouched, and its
    // turn's reply is never fenced or suppressed by it.
    const name = typeof (params as { name?: unknown } | null)?.name === "string" ? (params as { name: string }).name : "";
    if (name !== SEND_MESSAGE_TOOL_NAME && name !== NO_REPLY_TOOL_NAME) {
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
    let fenced = false;
    if (origin !== undefined) {
      try {
        fenced = fenceTurnForKeyedAdmission(origin.tools);
      } catch {
        // The fence's stand could not be read: it did not stand, and the
        // dispatch is refused rather than run against a turn it did not fence.
        fenced = false;
      }
    }
    return { keyed: true, origin, fenced };
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