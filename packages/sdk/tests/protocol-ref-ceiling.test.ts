import { describe, expect, it } from "vitest";

import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";
import { Socket } from "phoenix";

describe("protocol ref ceiling", () => {
  it("guards Socket.makeRef before growth and goes terminal", () => {
    const original = Socket.prototype.makeRef;
    let calls = 0;
    Socket.prototype.makeRef = function patched(this: Socket): string {
      calls += 1;
      return original.call(this);
    };
    try {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
        reconnectMode: "manual",
        joinAgentControl: false,
        websocketFactory: class {
          public readyState = 0;
          public close(): void {}
          public send(): void {}
          public addEventListener(): void {}
        } as unknown as typeof WebSocket,
      });
      expect(transport.getProtocolRefCount()).toBeGreaterThan(0);
      const guarded = transport as unknown as { socket: Socket };
      expect(typeof guarded.socket.makeRef).toBe("function");
      expect(calls).toBeGreaterThan(0);
    } finally {
      Socket.prototype.makeRef = original;
    }
  });
});
