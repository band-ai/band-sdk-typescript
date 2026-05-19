export type WebSocketDisconnectSource = "agent_control" | "upgrade" | "websocket_close";

type NestedPath = readonly string[];

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
    retryAfter: normalizeNumber(payload.retry_after),
    targetSocketId: normalizeString(payload.target_socket_id),
    correlationId: normalizeString(payload.correlation_id),
  };
}

export function parseUpgradeDisconnectReason(event: unknown): WebSocketUpgradeDisconnectReason | null {
  const status = normalizeStatus(readFirst(event, [
    ["status"],
    ["statusCode"],
    ["response", "status"],
  ]));
  if (status !== 400 && status !== 409 && status !== 429 && status !== 503) {
    return null;
  }

  const body = parseUpgradeBody(event);
  const error = isRecord(body?.error) ? body.error : null;
  if (!error) {
    return null;
  }

  const code = typeof error.code === "string" ? error.code : null;
  if (!isSupportedUpgradeCode(status, code)) {
    return null;
  }

  return {
    source: "upgrade",
    status,
    code,
    message: typeof error.message === "string" ? error.message : defaultUpgradeMessage(code),
    retryable: code === "too_many_requests" || code === "tracking_failed",
    retryAfter: normalizeNumber(error.retry_after) ?? readRetryAfterHeader(event),
    requestId: normalizeString(error.request_id),
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

function parseUpgradeBody(event: unknown): Record<string, unknown> | null {
  const body = readFirst(event, [
    ["body"],
    ["response", "body"],
    ["responseText"],
    ["response", "responseText"],
    ["data"],
    ["response", "data"],
  ]);

  if (isRecord(body)) {
    return body;
  }

  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return null;
}

function isSupportedUpgradeCode(
  status: number,
  code: unknown,
): code is WebSocketUpgradeDisconnectReason["code"] {
  return (status === 400 && code === "invalid_on_conflict")
    || (status === 409 && code === "connection_conflict")
    || (status === 429 && code === "too_many_requests")
    || (status === 503 && code === "tracking_failed");
}

function defaultUpgradeMessage(code: WebSocketUpgradeDisconnectReason["code"]): string {
  switch (code) {
    case "invalid_on_conflict":
      return "Invalid websocket conflict policy.";
    case "connection_conflict":
      return "Websocket connection conflict.";
    case "too_many_requests":
      return "Too many websocket connection attempts.";
    case "tracking_failed":
      return "Websocket connection tracking failed.";
  }
}

function readRetryAfterHeader(event: unknown): number | null {
  const headers = readFirst(event, [["headers"], ["response", "headers"]]);
  if (!headers) {
    return null;
  }

  if (typeof (headers as { get?: unknown }).get === "function") {
    return normalizeNumber((headers as { get: (name: string) => unknown }).get("Retry-After"));
  }

  if (isRecord(headers)) {
    return normalizeNumber(headers["Retry-After"] ?? headers["retry-after"]);
  }

  return null;
}

function readFirst(value: unknown, paths: NestedPath[]): unknown {
  for (const path of paths) {
    const found = readNested(value, path);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function readNested(value: unknown, path: NestedPath): unknown {
  let cursor = value;
  for (const segment of path) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function normalizeStatus(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
