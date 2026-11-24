import { AsyncLocalStorage } from "node:async_hooks";

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { asNonEmptyString, asOptionalRecord } from "../adapters/shared/coercion";
import type { AdapterToolsProtocol } from "../contracts/protocols";
import { resolveLogger, type Logger } from "../core/logger";
import { KEYED_OPERATION_TOOL_NAMES, ROOM_ID_ARG, carriesOperationIdArg } from "../contracts/toolSchemas";
import { fenceTurnForKeyedAdmission } from "../runtime/journal/journalTools";

/** The actual tools of the turn a keyed call was admitted on, and the room it names. */
export interface AdmissionOrigin {
  /** The turn's real tools as they stood at admission: a snapshot, not a forwarding proxy that a later turn could replace under the call. */
  tools: AdapterToolsProtocol;
  /** The room the call was admitted in, on a room-scoped bridge; absent on a single-context bridge, where the call names no room. */
  roomId?: string;
}

/**
 * Resolves a keyed call's origin synchronously from the room it names, as the
 * bridge sees it: the room's actual tools, or nothing.
 */
export type OriginResolver = (roomId: string) => AdmissionOrigin | undefined;

/**
 * What the transport recorded for a keyed call running in this async scope:
 * the origin it was pinned and fenced on, or the refusal its dispatch earns.
 */
export type Admission = { origin: AdmissionOrigin; refusal?: undefined } | { refusal: string };

const admissionStorage = new AsyncLocalStorage<Admission>();

/** The admission standing in this async scope: a keyed call's, or nothing elsewhere. */
export function currentAdmission(): Admission | undefined {
  return admissionStorage.getStore();
}

/** The room a call's `room_id` names, trimmed; admission and dispatch read it the same way. */
export function roomIdOf(value: unknown): string | null {
  return asNonEmptyString(value);
}

const TOOLS_CALL = "tools/call" as const;

/** The refusal a keyed call earns at admission, by the step that did not stand. */
export const KEYED_ADMISSION_REFUSALS = {
  notServed:
    "This server does not serve operation_id: the call is refused rather than posted without its key. Nothing was posted, settled, or fenced.",
  noOrigin:
    "The call's operation was admitted with no origin that can run it: the call is refused. Nothing was re-resolved, posted, settled, or fenced.",
  notFenced:
    "The call's operation was admitted on a turn whose fence did not stand (its tools do not journal replies): the call is refused. Nothing was posted or settled.",
} as const;

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
  private readonly logger: Logger;

  public constructor(inner: Transport, originResolver?: OriginResolver, logger?: Logger) {
    this.inner = inner;
    this.originResolver = originResolver;
    this.logger = resolveLogger(logger);
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

  /**
   * The framework's protocol version, set on the inner transport it actually
   * speaks on; present only when the inner supports it.
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
   * a keyed publication call; otherwise, in one synchronous step, the origin
   * is resolved and pinned and the turn it stands on is fenced, or the
   * refusal its dispatch earns is recorded. A keyed call never falls through
   * to an unkeyed post, even on a bridge that does not serve operation ids.
   */
  private admit(message: JSONRPCMessage): Admission | undefined {
    if (!("method" in message) || message.method !== TOOLS_CALL) {
      return undefined;
    }
    const params = message.params;
    const name = (params as { name?: unknown } | undefined)?.name;
    // An unrelated tool that carries its own operation_id passes through untouched.
    if (typeof name !== "string" || !KEYED_OPERATION_TOOL_NAMES.has(name)) {
      return undefined;
    }
    const arguments_ = asOptionalRecord(asOptionalRecord(params)?.arguments);
    if (!carriesOperationIdArg(arguments_)) {
      return undefined;
    }
    if (this.originResolver === undefined) {
      return this.refuse(name, "notServed");
    }
    let origin: AdmissionOrigin | undefined;
    try {
      origin = this.originResolver(roomIdOf(arguments_?.[ROOM_ID_ARG]) ?? "");
    } catch (error) {
      this.logger.warn("a keyed call's origin resolver threw; the call is refused", {
        tool: name,
        errorClass: error instanceof Error ? error.name : typeof error,
      });
    }
    if (origin === undefined) {
      return this.refuse(name, "noOrigin");
    }
    return fenceTurnForKeyedAdmission(origin.tools) ? { origin } : this.refuse(name, "notFenced");
  }

  private refuse(tool: string, reason: keyof typeof KEYED_ADMISSION_REFUSALS): Admission {
    this.logger.debug("a keyed call was refused at admission", { tool, reason });
    return { refusal: KEYED_ADMISSION_REFUSALS[reason] };
  }

  public get innerTransport(): Transport {
    return this.inner;
  }
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
    // A throwing resolver is the admission's to log and refuse.
    const tools = multiRoom ? getToolsForRoom(roomId) : getToolsForRoom("");
    if (tools === undefined) {
      return undefined;
    }
    return { tools, ...(multiRoom ? { roomId } : {}) };
  };
}
