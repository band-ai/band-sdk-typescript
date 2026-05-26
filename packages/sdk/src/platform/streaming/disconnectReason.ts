export type WebSocketDisconnectSource = "agent_control" | "upgrade" | "websocket_close";

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
  code: "invalid_on_conflict" | "connection_conflict" | "too_many_requests" | "tracking_failed";
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

type UpgradeCode = WebSocketUpgradeDisconnectReason["code"];

const UPGRADE_REASONS: Record<UpgradeCode, {
  status: WebSocketUpgradeDisconnectReason["status"];
  message: string;
  retryable: boolean;
}> = {
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
  if (typeof payload.reason !== "string" || typeof payload.message !== "string") {
    return null;
  }

  return {
    source: "agent_control",
    code: payload.reason,
    message: payload.message,
    retryable: false,
    retryAfter: numberOrNull(payload.retry_after),
    targetSocketId: stringOrNull(payload.target_socket_id),
    correlationId: stringOrNull(payload.correlation_id),
  };
}

export function parseUpgradeDisconnectReason(event: unknown): WebSocketUpgradeDisconnectReason | null {
  if (!isRecord(event)) {
    return null;
  }

  const status = numberOrNull(event.status);
  const body = parseJsonObject(event.body);
  const error = isRecord(body?.error) ? body.error : null;
  if (!error || !isUpgradeCode(error.code)) {
    return null;
  }

  const reason = UPGRADE_REASONS[error.code];
  if (status !== reason.status) {
    return null;
  }

  return {
    source: "upgrade",
    status: reason.status,
    code: error.code,
    message: typeof error.message === "string" ? error.message : reason.message,
    retryable: reason.retryable,
    retryAfter: numberOrNull(error.retry_after) ?? retryAfterFromHeaders(event.headers),
    requestId: stringOrNull(error.request_id),
  };
}

export function genericCloseReason(event?: { code?: number; reason?: string }): GenericWebSocketCloseReason {
  return {
    source: "websocket_close",
    code: "websocket.closed",
    message: "Phoenix socket closed without a platform disconnect reason.",
    retryable: true,
    closeCode: typeof event?.code === "number" ? event.code : null,
    closeReason: typeof event?.reason === "string" && event.reason.length > 0 ? event.reason : null,
  };
}

function isUpgradeCode(value: unknown): value is UpgradeCode {
  return typeof value === "string" && value in UPGRADE_REASONS;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function retryAfterFromHeaders(headers: unknown): number | null {
  if (!isRecord(headers)) {
    return null;
  }

  return numberOrNull(headers["retry-after"] ?? headers["Retry-After"]);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
