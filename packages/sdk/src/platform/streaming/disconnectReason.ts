import { z } from "zod";

export type WebSocketConflictPolicy = "supersede" | "reject";
export type WebSocketDisconnectSource =
  | "agent_control"
  | "upgrade"
  | "websocket_close";

export interface AgentControlSupersedeDisconnectReason {
  source: "agent_control";
  code: string;
  message: string;
  retryable: false;
  retryAfter: number | null;
  targetSocketId: string | null;
  correlationId: string | null;
}

export interface WebSocketUpgradeDisconnectReason {
  source: "upgrade";
  status: 400 | 409 | 429 | 503;
  code:
    | "invalid_on_conflict"
    | "connection_conflict"
    | "too_many_requests"
    | "tracking_failed";
  message: string;
  retryable: boolean;
  retryAfter: number | null;
  requestId: string | null;
}

export interface GenericWebSocketCloseReason {
  source: "websocket_close";
  code: "websocket.closed";
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

const UPGRADE_REASONS: Record<
  UpgradeCode,
  {
    status: WebSocketUpgradeDisconnectReason["status"];
    message: string;
    retryable: boolean;
  }
> = {
  invalid_on_conflict: {
    status: 400,
    message: "Invalid websocket conflict policy.",
    retryable: false,
  },
  connection_conflict: {
    status: 409,
    message: "Websocket connection conflict.",
    retryable: false,
  },
  too_many_requests: {
    status: 429,
    message: "Too many websocket connection attempts.",
    retryable: true,
  },
  tracking_failed: {
    status: 503,
    message: "Websocket connection tracking failed.",
    retryable: true,
  },
};

const upgradeErrorSchema = z.object({
  status: z.number(),
  body: z.preprocess(
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
  ),
  headers: z.record(z.unknown()).optional(),
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
  if (
    typeof payload.reason !== "string" ||
    typeof payload.message !== "string"
  ) {
    return null;
  }

  return {
    source: "agent_control",
    code: payload.reason,
    message: payload.message,
    retryable: false,
    retryAfter:
      typeof payload.retry_after === "number" ? payload.retry_after : null,
    targetSocketId:
      typeof payload.target_socket_id === "string"
        ? payload.target_socket_id
        : null,
    correlationId:
      typeof payload.correlation_id === "string"
        ? payload.correlation_id
        : null,
  };
}

export function parseUpgradeDisconnectReason(
  event: unknown,
): WebSocketUpgradeDisconnectReason | null {
  const parsed = upgradeErrorSchema.safeParse(event);
  if (!parsed.success) {
    return null;
  }

  const { status, body, headers } = parsed.data;
  const {
    code,
    message,
    retry_after: retryAfter,
    request_id: requestId,
  } = body.error;
  const reason = UPGRADE_REASONS[code];
  if (status !== reason.status) {
    return null;
  }

  return {
    source: "upgrade",
    status: reason.status,
    code,
    message: message ?? reason.message,
    retryable: reason.retryable,
    retryAfter: retryAfter ?? retryAfterFromHeaders(headers),
    requestId: requestId ?? null,
  };
}

export function genericCloseReason(event?: {
  code?: number;
  reason?: string;
}): GenericWebSocketCloseReason {
  return {
    source: "websocket_close",
    code: "websocket.closed",
    message: "Phoenix socket closed without a platform disconnect reason.",
    retryable: true,
    closeCode: typeof event?.code === "number" ? event.code : null,
    closeReason:
      typeof event?.reason === "string" && event.reason.length > 0
        ? event.reason
        : null,
  };
}

function retryAfterFromHeaders(
  headers: Record<string, unknown> | undefined,
): number | null {
  const value = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds : null;
  }
  return null;
}
