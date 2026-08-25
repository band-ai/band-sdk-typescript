import { createServer } from "http";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it } from "vitest";

import { WebSocketDisconnectError } from "../src/platform/streaming/disconnectReason";
import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
  servers.clear();
});

describe("PhoenixChannelsTransport upgrade failures", () => {
  it("parses structured Node websocket upgrade rejection responses", async () => {
    const server = createServer();
    servers.add(server);
    server.on("upgrade", (_request, socket) => {
      socket.write(
        [
          "HTTP/1.1 409 Conflict",
          "Content-Type: application/json",
          "Retry-After: 7",
          "",
          JSON.stringify({
            error: {
              code: "connection_conflict",
              message: "Connection already exists for this agent.",
              request_id: "req-1",
            },
          }),
        ].join("\r\n"),
      );
      socket.end();
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const transport = new PhoenixChannelsTransport({
      wsUrl: `ws://127.0.0.1:${port}/socket`,
      apiKey: "key-1",
      agentId: "agent-1",
      reconnectAfterMs: () => 60_000,
    });

    await expect(transport.connect()).rejects.toBeInstanceOf(
      WebSocketDisconnectError,
    );
    expect(transport.getDisconnectReason()).toMatchObject({
      source: "upgrade",
      status: 409,
      code: "connection_conflict",
      message: "Connection already exists for this agent.",
      requestId: "req-1",
      retryAfter: 7,
    });
  });
});
