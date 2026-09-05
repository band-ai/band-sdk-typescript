import { describe, expect, it, vi } from "vitest";

import { ParlantAdapter } from "../src/adapters/parlant/ParlantAdapter";
import { FakeTools, makeMessage } from "./testUtils";

class FakeParlantClient {
  public readonly customers = {
    create: async (_params: {
      id?: string;
      name: string;
      metadata?: Record<string, string | undefined>;
    }) => {
      this.customerCreateCount += 1;
      return { id: `customer-${this.customerCreateCount}` };
    },
  };

  public readonly sessions = {
    create: async (_params: {
      agentId: string;
      customerId?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }) => {
      this.sessionCreateCount += 1;
      return { id: `session-${this.sessionCreateCount}` };
    },
    createEvent: async (
      sessionId: string,
      params: {
        kind: "message" | "status" | "tool" | "custom";
        source:
          | "customer"
          | "customer_ui"
          | "human_agent"
          | "human_agent_on_behalf_of_ai_agent"
          | "ai_agent"
          | "system";
        message?: string;
        data?: unknown;
        moderation?: "auto" | "paranoid" | "none";
        metadata?: Record<string, unknown>;
      },
    ) => {
      this.eventCreateCalls.push({ sessionId, params });
      this.nextOffset += 1;
      return { id: `event-${this.nextOffset}`, offset: this.nextOffset };
    },
    listEvents: async (_sessionId: string) => {
      return this.eventPollBatches.shift() ?? [];
    },
  };

  public customerCreateCount = 0;
  public sessionCreateCount = 0;
  public nextOffset = 0;
  public readonly eventCreateCalls: Array<{
    sessionId: string;
    params: Record<string, unknown>;
  }> = [];
  public eventPollBatches: Array<Array<Record<string, unknown>>> = [];
}

describe("ParlantAdapter", () => {
  it("creates a session and forwards ai-agent response", async () => {
    const client = new FakeParlantClient();
    client.eventPollBatches.push([
      {
        kind: "message",
        offset: 10,
        data: {
          message: "Parlant says hello",
        },
      },
    ]);

    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => client,
      responseTimeoutSeconds: 1,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("Hi", "room-1"),
      tools,
      [],
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    expect(client.customerCreateCount).toBe(1);
    expect(client.sessionCreateCount).toBe(1);
    expect(
      client.eventCreateCalls.some((call) => call.params.source === "customer"),
    ).toBe(true);
    expect(tools.messages).toEqual(["Parlant says hello"]);
  });

  it("injects history once on bootstrap and does not duplicate later", async () => {
    const client = new FakeParlantClient();
    client.eventPollBatches.push([
      {
        kind: "message",
        offset: 20,
        data: { message: "First response" },
      },
    ]);
    client.eventPollBatches.push([
      {
        kind: "message",
        offset: 30,
        data: { message: "Second response" },
      },
    ]);

    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => client,
      responseTimeoutSeconds: 1,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const history = [
      {
        role: "user" as const,
        content: "[User]: Earlier question",
        sender: "User",
        senderType: "User",
      },
      {
        role: "assistant" as const,
        content: "Earlier answer",
        sender: "Assistant",
        senderType: "Agent",
      },
    ];

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("Current question", "room-bootstrap"),
      tools,
      history,
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-bootstrap" },
    );

    const historicalEventsAfterFirst = client.eventCreateCalls.filter(
      (call) => call.params.metadata && (call.params.metadata as Record<string, unknown>).historical === true,
    ).length;

    await adapter.onMessage(
      makeMessage("Follow up", "room-bootstrap"),
      tools,
      history,
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-bootstrap" },
    );

    const historicalEventsAfterSecond = client.eventCreateCalls.filter(
      (call) => call.params.metadata && (call.params.metadata as Record<string, unknown>).historical === true,
    ).length;

    expect(historicalEventsAfterFirst).toBeGreaterThan(0);
    expect(historicalEventsAfterSecond).toBe(historicalEventsAfterFirst);
  });

  it("emits an error event when no response arrives before timeout", async () => {
    const client = new FakeParlantClient();
    client.eventPollBatches.push([]);
    client.eventPollBatches.push([]);

    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => client,
      responseTimeoutSeconds: 1,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("Hi", "room-timeout"),
      tools,
      [],
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-timeout" },
    );

    expect(tools.messages).toEqual([]);
    expect(tools.events.some((event) => event.messageType === "error")).toBe(true);
  });

  it("emits an error event instead of sending an invisible-only reply", async () => {
    const client = new FakeParlantClient();
    client.eventPollBatches.push([
      {
        kind: "message",
        offset: 10,
        data: {
          message: "​",
        },
      },
    ]);

    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => client,
      responseTimeoutSeconds: 1,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("Hi", "room-invisible"),
      tools,
      [],
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-invisible" },
    );

    expect(tools.messages).toEqual([]);
    expect(tools.events.some((event) => event.messageType === "error")).toBe(true);
  });

  it("serializes bootstrap initialization for concurrent first messages in one room", async () => {
    const client = new FakeParlantClient();
    client.eventPollBatches.push(
      [{ kind: "message", offset: 40, data: { message: "First concurrent response" } }],
      [{ kind: "message", offset: 50, data: { message: "Second concurrent response" } }],
    );

    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => client,
      responseTimeoutSeconds: 1,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const history = [
      {
        role: "user" as const,
        content: "[User]: Earlier question",
        sender: "User",
        senderType: "User",
      },
      {
        role: "assistant" as const,
        content: "Earlier answer",
        sender: "Assistant",
        senderType: "Agent",
      },
    ];

    const tools = new FakeTools();
    await Promise.all([
      adapter.onMessage(
        makeMessage("Current question A", "room-race"),
        tools,
        history,
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-race" },
      ),
      adapter.onMessage(
        makeMessage("Current question B", "room-race"),
        tools,
        history,
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-race" },
      ),
    ]);

    const historicalEvents = client.eventCreateCalls.filter(
      (call) => call.params.metadata && (call.params.metadata as Record<string, unknown>).historical === true,
    );

    expect(client.customerCreateCount).toBe(1);
    expect(client.sessionCreateCount).toBe(1);
    expect(historicalEvents).toHaveLength(2);
    expect(tools.messages).toHaveLength(2);
  });

  it("logs skipped bootstrap history events instead of swallowing them", async () => {
    const client = new FakeParlantClient();
    client.eventPollBatches.push([
      {
        kind: "message",
        offset: 60,
        data: { message: "Recovered response" },
      },
    ]);

    const originalCreateEvent = client.sessions.createEvent;
    let failedHistoricalAssistantEvent = false;
    client.sessions.createEvent = async (sessionId, params) => {
      const metadata = (params.metadata ?? {}) as Record<string, unknown>;
      if (
        !failedHistoricalAssistantEvent
        && metadata.historical === true
        && params.source === "ai_agent"
      ) {
        failedHistoricalAssistantEvent = true;
        throw new Error("history injection failed");
      }

      return originalCreateEvent(sessionId, params);
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => client,
      responseTimeoutSeconds: 1,
      logger,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const history = [
      {
        role: "user" as const,
        content: "[User]: Earlier question",
        sender: "User",
        senderType: "User",
      },
      {
        role: "assistant" as const,
        content: "Earlier answer",
        sender: "Assistant",
        senderType: "Agent",
      },
    ];

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("Current question", "room-history-warn"),
      tools,
      history,
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-history-warn" },
    );

    expect(tools.messages).toEqual(["Recovered response"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Parlant history injection failed",
      expect.objectContaining({
        sessionId: "session-1",
        roomRole: "assistant",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Parlant history injection completed with skipped events",
      expect.objectContaining({
        sessionId: "session-1",
        failedEvents: 1,
      }),
    );
  });

  it("logs adapter request failures before surfacing them to the room", async () => {
    const client = new FakeParlantClient();
    client.sessions.listEvents = async () => {
      throw new Error("poll failed");
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => client,
      responseTimeoutSeconds: 1,
      logger,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const tools = new FakeTools();
    await expect(
      adapter.onMessage(
        makeMessage("Hi", "room-error"),
        tools,
        [],
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-error" },
      ),
    ).rejects.toThrow("poll failed");

    expect(tools.events).toHaveLength(1);
    expect(tools.events[0]?.messageType).toBe("error");
    expect(tools.events[0]?.content).toContain("poll failed");
    expect(logger.error).toHaveBeenCalledWith(
      "Parlant adapter request failed",
      expect.objectContaining({
        roomId: "room-error",
        agentId: "agent-1",
      }),
    );
  });

  it("logs client initialization failures before surfacing adapter errors", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => {
        throw new Error("parlant init failed");
      },
      logger,
      responseTimeoutSeconds: 1,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const tools = new FakeTools();
    await expect(
      adapter.onMessage(
        makeMessage("Hi", "room-init"),
        tools,
        [],
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-init" },
      ),
    ).rejects.toThrow("parlant init failed");

    expect(logger.error).toHaveBeenCalledWith(
      "Parlant client initialization failed",
      expect.objectContaining({
        error: expect.any(Error),
      }),
    );
    expect(tools.events.some((event) => event.messageType === "error")).toBe(true);
  });

  it("stamps band_room_id metadata and a \"Band Room \" title on session creation", async () => {
    const client = new FakeParlantClient();
    client.eventPollBatches.push([
      { kind: "message", offset: 70, data: { message: "hello" } },
    ]);

    const sessionCreateCalls: Array<{
      agentId: string;
      customerId?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const originalCreate = client.sessions.create;
    client.sessions.create = async (params) => {
      sessionCreateCalls.push(params);
      return originalCreate(params);
    };

    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => client,
      responseTimeoutSeconds: 1,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("Hi", "room-band-meta"),
      tools,
      [],
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-band-meta" },
    );

    expect(sessionCreateCalls).toHaveLength(1);
    const created = sessionCreateCalls[0]!;
    expect(created.title?.startsWith("Band Room ")).toBe(true);
    const sessionMetadata = created.metadata as Record<string, unknown>;
    expect(sessionMetadata.band_room_id).toBe("room-band-meta");
    expect(Object.keys(sessionMetadata)).not.toContain("thenvoi_room_id");
  });

  it("forwards the customer message event with band_source and band_room_id metadata (not thenvoi_room_id)", async () => {
    const client = new FakeParlantClient();
    client.eventPollBatches.push([
      { kind: "message", offset: 80, data: { message: "hello" } },
    ]);

    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => client,
      responseTimeoutSeconds: 1,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("Hi", "room-band-source"),
      tools,
      [],
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-band-source" },
    );

    const customerEvent = client.eventCreateCalls.find(
      (call) => call.params.source === "customer",
    );
    expect(customerEvent).toBeDefined();
    const metadata = customerEvent!.params.metadata as Record<string, unknown>;
    expect(metadata.band_source).toBe("band-sdk-typescript");
    expect(metadata.band_room_id).toBe("room-band-source");
    expect(Object.keys(metadata)).not.toContain("thenvoi_room_id");
    expect(Object.keys(metadata)).not.toContain("thenvoi_source");
  });

  it("stamps band_system_prompt on the bootstrap system-prompt event", async () => {
    const client = new FakeParlantClient();
    client.eventPollBatches.push([
      { kind: "message", offset: 90, data: { message: "hello" } },
    ]);

    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => client,
      responseTimeoutSeconds: 1,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("Hi", "room-system-prompt"),
      tools,
      [],
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-system-prompt" },
    );

    const systemEvent = client.eventCreateCalls.find(
      (call) => call.params.source === "system",
    );
    expect(systemEvent).toBeDefined();
    const metadata = systemEvent!.params.metadata as Record<string, unknown>;
    expect(metadata.band_system_prompt).toBe(true);
    expect(Object.keys(metadata)).not.toContain("thenvoi_system_prompt");
  });

  it("never emits legacy thenvoi_ keys or Thenvoi brand values in any outbound payload", async () => {
    const client = new FakeParlantClient();
    client.eventPollBatches.push([
      { kind: "message", offset: 100, data: { message: "hello" } },
    ]);

    const sessionCreateCalls: Array<{
      agentId: string;
      customerId?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const originalCreate = client.sessions.create;
    client.sessions.create = async (params) => {
      sessionCreateCalls.push(params);
      return originalCreate(params);
    };
    const customerCreateCalls: Array<{
      id?: string;
      name: string;
      metadata?: Record<string, string | undefined>;
    }> = [];
    const originalCustomerCreate = client.customers.create;
    client.customers.create = async (params) => {
      customerCreateCalls.push(params);
      return originalCustomerCreate(params);
    };

    const adapter = new ParlantAdapter({
      environment: "https://parlant.example",
      agentId: "agent-1",
      clientFactory: async () => client,
      responseTimeoutSeconds: 1,
    });

    await adapter.onStarted("Parlant Bridge", "Bridge to parlant");

    const history = [
      {
        role: "user" as const,
        content: "[User]: Earlier question",
        sender: "User",
        senderType: "User",
      },
      {
        role: "assistant" as const,
        content: "Earlier answer",
        sender: "Assistant",
        senderType: "Agent",
      },
    ];

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("Hi", "room-plain"),
      tools,
      history,
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-plain" },
    );

    const strings: string[] = [];
    const keys: string[] = [];
    const collect = (metadata: Record<string, unknown> | undefined) => {
      if (!metadata) return;
      for (const [key, value] of Object.entries(metadata)) {
        keys.push(key);
        if (typeof value === "string") strings.push(value);
      }
    };
    for (const call of sessionCreateCalls) {
      if (call.title !== undefined) strings.push(call.title);
      collect(call.metadata);
    }
    for (const call of customerCreateCalls) {
      strings.push(call.name);
      collect(call.metadata as Record<string, unknown> | undefined);
    }
    for (const call of client.eventCreateCalls) {
      collect(call.params.metadata as Record<string, unknown> | undefined);
    }

    expect(sessionCreateCalls).toHaveLength(1);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((key) => key.startsWith("thenvoi_"))).toBe(false);
    expect(
      strings.some(
        (value) =>
          value.includes("Thenvoi") || value.includes("thenvoi-sdk-typescript"),
      ),
    ).toBe(false);
  });
});
