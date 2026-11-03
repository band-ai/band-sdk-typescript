import type { ClientRequest, IncomingMessage } from "http";
import { WebSocket as NodeWebSocket } from "ws";

type NodeUpgradeWebSocket = InstanceType<typeof NodeWebSocket> & {
  once(
    event: "unexpected-response",
    listener: (request: ClientRequest, response: IncomingMessage) => void,
  ): NodeUpgradeWebSocket;
  emit(event: "error", error: Error): boolean;
  emit(event: "close", code: number, reason: Buffer): boolean;
};

type NodeWebSocketConstructor = new (
  address: string | URL,
  protocols?: string | string[],
  options?: { headers?: Record<string, string>; handshakeTimeout?: number; closeTimeout?: number },
) => NodeUpgradeWebSocket;

/**
 * How long an upgrade may go unanswered. `ws` then closes the attempt (1006),
 * so a hung handshake reaches core `Session` as a failure it can retry.
 */
export const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * How long a close waits for the peer's close frame. `ws` defaults to 30 s;
 * phoenix gives up on its own close polling after about 1.5 s, and a close the
 * transport starts itself would otherwise hold Session's next attempt.
 */
export const WEBSOCKET_CLOSE_TIMEOUT_MS = 2_000;

export function createNodeWebSocketFactory(
  headers?: Record<string, string>,
  handshakeTimeoutMs = WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
): typeof WebSocket {
  const Constructor = NodeWebSocket as unknown as NodeWebSocketConstructor;

  class BandNodeWebSocket {
    public constructor(address: string | URL, protocols?: string | string[]) {
      const socket = new Constructor(address, protocols, {
        headers,
        handshakeTimeout: handshakeTimeoutMs,
        closeTimeout: WEBSOCKET_CLOSE_TIMEOUT_MS,
      });
      socket.once("unexpected-response", (request, response) => {
        // The refusal is in: stop `ws` aborting it as unanswered, and bound its body instead.
        request.setTimeout(0);
        void emitUpgradeError(socket, request, response, handshakeTimeoutMs);
      });
      return socket;
    }
  }

  return BandNodeWebSocket as unknown as typeof WebSocket;
}

async function emitUpgradeError(
  websocket: NodeUpgradeWebSocket,
  request: ClientRequest,
  response: IncomingMessage,
  bodyTimeoutMs: number,
): Promise<void> {
  const body = await readResponseBody(response, bodyTimeoutMs);
  request.destroy();
  // A local close while the body was in flight already reported this attempt.
  if (websocket.readyState !== NodeWebSocket.CONNECTING) {
    return;
  }
  const error = new Error(
    `Unexpected server response: ${response.statusCode ?? "unknown"}`,
  ) as Error & {
    status?: number;
    body?: string;
    headers?: IncomingMessage["headers"];
  };

  error.status = response.statusCode;
  error.body = body;
  error.headers = response.headers;

  websocket.emit("error", error);
  websocket.emit("close", 1006, Buffer.alloc(0));
}

/** Resolves with the body read before it ends, fails, or runs past `timeoutMs`; never rejects, since the status and headers matter more. */
function readResponseBody(response: IncomingMessage, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => response.destroy(), timeoutMs);
    response.on("data", (chunk: Buffer | string) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    response.on("error", () => undefined);
    response.once("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
