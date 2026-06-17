import { describe, expect, it } from "vitest";

import { createBasicAgent } from "../examples/basic/basic-agent";
import { StubRestApi } from "../src/testing";
import type {
  StreamingTransport,
  TopicHandlers,
} from "../src/platform/streaming/transport";
import { FakeRestApi } from "./testUtils";

class NoopTransport implements StreamingTransport {
  public async connect(): Promise<void> {}
  public async disconnect(): Promise<void> {}
  public async join(_topic: string, _handlers: TopicHandlers): Promise<void> {}
  public async leave(_topic: string): Promise<void> {}
  public async runForever(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  public isConnected(): boolean {
    return true;
  }
}

describe("basic-agent example", () => {
  it("builds an agent instance without side effects on import", () => {
    const agent = createBasicAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });

  it("StubRestApi returns sensible defaults", async () => {
    const rest = new StubRestApi();
    await expect(rest.getAgentMe()).resolves.toMatchObject({
      id: "stub-agent",
      name: "Stub Agent",
    });
  });

  it("forwards wsUrl/restUrl from config into runtime link", async () => {
    const agent = createBasicAgent({
      agentId: "a1",
      apiKey: "k",
      wsUrl: "wss://staging.thenvoi.com/api/v1/socket",
      restUrl: "https://staging.thenvoi.com",
    });

    // Stub transport + REST so initialize() does not hit the network.
    (agent.runtime as unknown as { linkOptions: unknown }).linkOptions = {
      transport: new NoopTransport(),
      restApi: new FakeRestApi(),
    };

    await agent.runtime.initialize();

    expect(agent.runtime.link.wsUrl).toBe("wss://staging.thenvoi.com/api/v1/socket");
    expect(agent.runtime.link.restUrl).toBe("https://staging.thenvoi.com");
  });
});
