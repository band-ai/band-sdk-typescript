import { AsyncLocalStorage } from "node:async_hooks";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

import { asNonEmptyString, asOptionalRecord } from "../core/coercion";
import type { AdapterToolsProtocol } from "../contracts/protocols";
import { errorClassOf } from "../core/errors";
import { resolveLogger, type Logger } from "../core/logger";
import { KEYED_OPERATION_TOOL_NAMES, ROOM_ID_ARG, carriesOperationIdArg } from "../contracts/toolSchemas";
import { fenceTurnForKeyedAdmission } from "../runtime/journal/journalTools";
import { ForwardingTransport } from "./forwardingTransport";

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
export type Admission = { origin: AdmissionOrigin; logger: Logger; refusal?: undefined } | { refusal: string };

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
 * Installed by every Band MCP bridge in front of the framework's dispatch: a
 * keyed `tools/call` is admitted before the framework validates it — its turn
 * fenced, its origin's tools pinned — and dispatched in that admission's scope.
 */
export class AdmissionTransport extends ForwardingTransport {
  private readonly originResolver: OriginResolver | undefined;
  private readonly logger: Logger;

  public constructor(inner: Transport, originResolver?: OriginResolver, logger?: Logger) {
    super(inner);
    this.originResolver = originResolver;
    this.logger = resolveLogger(logger);
  }

  protected override receive(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    const admission = this.admit(message);
    if (admission === undefined) {
      super.receive(message, extra);
      return;
    }
    // The keyed call's execution, however far it runs and whatever the
    // framework answers, stays in the admission it was given.
    admissionStorage.run(admission, () => super.receive(message, extra));
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
    const params = asOptionalRecord(message.params);
    const name = params?.name;
    // An unrelated tool that carries its own operation_id passes through untouched.
    if (typeof name !== "string" || !KEYED_OPERATION_TOOL_NAMES.has(name)) {
      return undefined;
    }
    const arguments_ = asOptionalRecord(params?.arguments);
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
        ...errorClassOf(error),
      });
    }
    if (origin === undefined) {
      return this.refuse(name, "noOrigin");
    }
    let fenced = false;
    try {
      fenced = fenceTurnForKeyedAdmission(origin.tools);
    } catch (error) {
      this.logger.warn("a keyed call's turn fence threw; the call is refused", {
        tool: name,
        ...errorClassOf(error),
      });
    }
    return fenced ? { origin, logger: this.logger } : this.refuse(name, "notFenced");
  }

  private refuse(tool: string, reason: keyof typeof KEYED_ADMISSION_REFUSALS): Admission {
    this.logger.debug("a keyed call was refused at admission", { tool, reason });
    return { refusal: KEYED_ADMISSION_REFUSALS[reason] };
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
