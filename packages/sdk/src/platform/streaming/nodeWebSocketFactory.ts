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

export function createNodeWebSocketFactory(): typeof WebSocket {
  return class ThenvoiNodeWebSocket extends NodeWebSocket {
    public constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols);
      const socket = this as unknown as NodeUpgradeWebSocket;
      socket.once("unexpected-response", (request, response) => {
        void emitUpgradeError(socket, request, response);
      });
    }
  } as unknown as typeof WebSocket;
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
