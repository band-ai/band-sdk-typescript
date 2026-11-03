import { z } from "zod";
import { classifyClose, classifyUpgrade, validateEventPayload } from "@band-ai/band-sdk-core";

export type WebSocketConflictPolicy = "supersede" | "reject";
export type WebSocketDisconnectSource = "agent_control" | "upgrade" | "websocket_close";

export interface AgentControlSupersedeDisconnectReason {
  source: "agent_control";
  code: string;
  message: string;
  retryable: boolean;
  retryAfter: number | null;
  targetSocketId: string | null;
  correlationId: string | null;
}

export interface WebSocketUpgradeDisconnectReason {
  source: "upgrade";
  status: number;
  /** The platform's code, or `upgrade_rejected` when the refusal carries none (e.g. a 403 from the edge). */
  code:
    | "invalid_on_conflict"
    | "connection_conflict"
    | "too_many_requests"
    | "tracking_failed"
    | "upgrade_rejected";
  message: string;
  retryable: boolean;
  retryAfter: number | null;
  requestId: string | null;
}

export interface GenericWebSocketCloseReason {
  source: "websocket_close";
  /**
   * `websocket.rapid_disconnect` when sockets kept dropping right after
   * connecting; `websocket.control_join_failed` when the transport dropped the
   * socket because the mandatory agent_control join failed.
   */
  code: "websocket.closed" | "websocket.rapid_disconnect" | "websocket.control_join_failed";
  message: string;
  retryable: boolean;
  closeCode: number | null;
  closeReason: string | null;
}

export type WebSocketDisconnectReason =
  | AgentControlSupersedeDisconnectReason
  | WebSocketUpgradeDisconnectReason
  | GenericWebSocketCloseReason;

const UPGRADE_CODES = [
  "invalid_on_conflict",
  "connection_conflict",
  "too_many_requests",
  "tracking_failed",
] as const;

type UpgradeCode = (typeof UPGRADE_CODES)[number];

// Whether each is retryable is core's call (`classifyUpgrade`), not this table's.
const UPGRADE_REASONS: Record<UpgradeCode, { status: number; message: string }> = {
  invalid_on_conflict: { status: 400, message: "Invalid websocket conflict policy." },
  connection_conflict: { status: 409, message: "Websocket connection conflict." },
  too_many_requests: { status: 429, message: "Too many websocket connection attempts." },
  tracking_failed: { status: 503, message: "Websocket connection tracking failed." },
};

const platformUpgradeBodySchema = z.preprocess(
  (body) => {
    if (typeof body !== "string") {
      return body;
    }

    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  },
  z.object({
    error: z.object({
      code: z.enum(UPGRADE_CODES),
      message: z.string().optional(),
      retry_after: z.number().nullable().optional(),
      request_id: z.string().nullable().optional(),
    }),
  }),
);

const upgradeErrorSchema = z.object({
  status: z.number().int(),
  body: z.unknown().optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
});

export class WebSocketDisconnectError extends Error {
  public readonly reason: WebSocketDisconnectReason;

  public constructor(reason: WebSocketDisconnectReason) {
    super(reason.message);
    this.name = "WebSocketDisconnectError";
    this.reason = reason;
  }
}

export function parseSupersedeDisconnectReason(
  payload: Record<string, unknown>,
): AgentControlSupersedeDisconnectReason | null {
  try {
    const normalized = validateEventPayload("supersede", payload) as Record<
      string,
      unknown
    >;
    return {
      source: "agent_control",
      code: normalized.reason as string,
      message: normalized.message as string,
      retryable: normalized.retryable as boolean,
      // Core's payload contract accepts a negative hint that its Session rejects.
      retryAfter: validRetryAfter(normalized.retry_after),
      targetSocketId: (normalized.target_socket_id as string | null) ?? null,
      correlationId: normalized.correlation_id as string | null,
    };
  } catch {
    return null;
  }
}

/**
 * The reason for an HTTP upgrade the server refused, or `null` when `event`
 * carries no HTTP status (a network failure before any response). The
 * platform's own code is kept when its body and status match one.
 */
export function parseUpgradeDisconnectReason(
  event: unknown,
): WebSocketUpgradeDisconnectReason | null {
  const parsed = upgradeErrorSchema.safeParse(event);
  if (!parsed.success) {
    return null;
  }

  const { status, body, headers } = parsed.data;
  const [terminal] = classifyUpgrade(status);
  const platform = platformUpgradeBodySchema.safeParse(body);
  const platformError = platform.success && UPGRADE_REASONS[platform.data.error.code].status === status
    ? platform.data.error
    : null;

  return {
    source: "upgrade",
    status,
    code: platformError?.code ?? "upgrade_rejected",
    message: platformError
      ? platformError.message ?? UPGRADE_REASONS[platformError.code].message
      : `Websocket upgrade rejected with HTTP ${status}.`,
    retryable: !terminal,
    retryAfter: validRetryAfter(platformError?.retry_after) ?? retryAfterFromHeaders(headers),
    requestId: platformError?.request_id ?? null,
  };
}

/** The close event phoenix hands its close callbacks. */
export interface CloseEventLike {
  code?: number;
  reason?: string;
}

export function genericCloseReason(event?: CloseEventLike): GenericWebSocketCloseReason {
  const closeCode = closeCodeOf(event);
  const [terminal] = classifyClose(closeCode ?? undefined);
  return {
    source: "websocket_close",
    code: "websocket.closed",
    message: "Phoenix socket closed without a platform disconnect reason.",
    retryable: !terminal,
    closeCode,
    closeReason: closeReasonOf(event),
  };
}

/** Sockets kept dropping right after connecting, so core's breaker ended the session. */
export function rapidDisconnectReason(event?: CloseEventLike): GenericWebSocketCloseReason {
  return {
    source: "websocket_close",
    code: "websocket.rapid_disconnect",
    message: "Phoenix socket kept disconnecting right after connecting.",
    retryable: false,
    closeCode: closeCodeOf(event),
    closeReason: closeReasonOf(event),
  };
}

/** The transport dropped the socket because the mandatory agent_control join failed; Session decides the retry. */
export function controlJoinFailedReason(): GenericWebSocketCloseReason {
  return {
    source: "websocket_close",
    code: "websocket.control_join_failed",
    message: "Mandatory agent_control channel join failed.",
    retryable: true,
    closeCode: null,
    closeReason: null,
  };
}

function closeCodeOf(event?: CloseEventLike): number | null {
  return typeof event?.code === "number" ? event.code : null;
}

function closeReasonOf(event?: CloseEventLike): string | null {
  return typeof event?.reason === "string" && event.reason.length > 0 ? event.reason : null;
}

/** A usable `Retry-After` in seconds; a negative or non-finite one is no hint. */
function validRetryAfter(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function retryAfterFromHeaders(
  headers: Record<string, unknown> | undefined,
): number | null {
  const value = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (typeof value === "string" && value.trim() !== "") {
    return validRetryAfter(Number(value));
  }
  return validRetryAfter(value);
}
