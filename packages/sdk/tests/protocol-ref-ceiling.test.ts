import { describe, expect, it, vi } from "vitest";

import { TransportError } from "../src/core/errors";
import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";

vi.mock("../src/platform/streaming/resourceLimits", () => ({
  REALTIME_WORKING_AGENT_EXECUTION_MAX: 32,
  REALTIME_MAX_FRAME_BYTES: 65_536,
  REALTIME_MAX_PENDING_CONTROLS: 16,
  REALTIME_MAX_REFS: 5,
}));

const phoenixMock = vi.hoisted(() => {
  class FakeChannel {
    public readonly topic: string;
    public constructor(topic: string) {
      this.topic = topic;
    }
    public on(): number {
      return 1;
    }
    public off(): void {}
    public join() {
      const chain = {
        receive: (_kind: string, callback: (payload?: unknown) => void) => {
          queueMicrotask(() => callback({}));
          return chain;
        },
      };
      return chain;
    }
    public leave() {
      const chain = {
        receive: (_kind: string, callback: () => void) => {
          queueMicrotask(() => callback());
          return chain;
        },
      };
      return chain;
    }
  }
  class FakeSocket {
    public channels: FakeChannel[] = [];
    public constructor(_url: string, _options: unknown) {}
    public onOpen(handler: () => void): void {
      queueMicrotask(handler);
    }
    public onClose(): void {}
    public onError(): void {}
    public connect(): void {}
    public disconnect(): void {}
    public channel(topic: string): FakeChannel {
      const channel = new FakeChannel(topic);
      this.channels.push(channel);
      return channel;
    }
    public remove(): void {}
  }
  return { FakeChannel, FakeSocket };
});

vi.mock("phoenix", () => ({
  Channel: phoenixMock.FakeChannel,
  Socket: phoenixMock.FakeSocket,
}));

describe("protocol ref ceiling", () => {
  it("stops joins when REALTIME_MAX_REFS is exhausted at the transport owner", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      reconnectAfterMs: () => Number.POSITIVE_INFINITY,
    });
    await transport.connect();
    await expect(
      (async () => {
        for (let i = 0; i < 8; i += 1) {
          await transport.join(`topic:${i}`, { ping: () => undefined });
        }
      })(),
    ).rejects.toBeInstanceOf(TransportError);
    expect(transport.getProtocolRefCount()).toBeGreaterThan(5);
    await transport.disconnect().catch(() => undefined);
  });
});
