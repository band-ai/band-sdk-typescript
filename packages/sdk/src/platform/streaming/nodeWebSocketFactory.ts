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
  options?: { headers?: Record<string, string> },
) => NodeUpgradeWebSocket;

export function createNodeWebSocketFactory(headers?: Record<string, string>): typeof WebSocket {
  const Constructor = NodeWebSocket as unknown as NodeWebSocketConstructor;

  class ThenvoiNodeWebSocket {
    public constructor(address: string | URL, protocols?: string | string[]) {
      const socket = new Constructor(address, protocols, headers ? { headers } : undefined);
      socket.once("unexpected-response", (request, response) => {
        void emitUpgradeError(socket, request, response);
      });
      return socket;
    }
  }

  return ThenvoiNodeWebSocket as unknown as typeof WebSocket;
}

async function emitUpgradeError(
  websocket: NodeUpgradeWebSocket,
  request: ClientRequest,
  response: IncomingMessage,
): Promise<void> {
  const body = await readResponseBody(response);
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

  request.destroy();
  websocket.emit("error", error);
  websocket.emit("close", 1006, Buffer.alloc(0));
}

async function readResponseBody(response: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of response as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
