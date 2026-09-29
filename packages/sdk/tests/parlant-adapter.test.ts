import { describe, expect, it, vi } from "vitest";

import { ParlantAdapter, type ParlantAdapterOptions } from "../src/adapters/parlant/ParlantAdapter";
import { PREVIOUS_CONTEXT_HEADER } from "../src/adapters/shared/conversationPrompt";
import { ValidationError } from "../src/core/errors";
import { HistoryProvider } from "../src/runtime/types";
import { FakeTools, failureEvents, findFailureEvent, makeMessage, expectTurnFailed } from "./testUtils";
import { describeDeliveryContract } from "./deliveryContract";

type SessionCreateParams = {
  agentId: string;
  customerId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

class FakeParlantClient {
  public readonly agents = {
    create: async (params: { name: string; description?: string }) => {
      this.agentCreateCalls.push(params);
      return { id: `agent-owned-${this.agentCreateCalls.length}` };
    },
    delete: async (agentId: string) => {
      this.deleted.push(`agent:${agentId}`);
    },
  };

  public readonly customers = {
    create: async (_params: {
      id?: string;
      name: string;
      metadata?: Record<string, string | undefined>;
    }) => {
      this.customerCreateCount += 1;
      return { id: `customer-${this.customerCreateCount}` };
    },
    delete: async (customerId: string) => {
      this.deleted.push(`customer:${customerId}`);
    },
  };

  public readonly sessions = {
    create: async (params: SessionCreateParams) => {
      this.sessionCreateCalls.push(params);
      return { id: `session-${this.sessionCreateCalls.length}` };
    },
    delete: async (sessionId: string) => {
      this.deleted.push(`session:${sessionId}`);
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
          | "ai_agent";
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
  public readonly agentCreateCalls: Array<{ name: string; description?: string }> = [];
  public readonly sessionCreateCalls: SessionCreateParams[] = [];
  public readonly deleted: string[] = [];
  public nextOffset = 0;
  public readonly eventCreateCalls: Array<{
    sessionId: string;
    params: Record<string, unknown>;
  }> = [];
  public eventPollBatches: Array<Array<Record<string, unknown>>> = [];
}

const AGENT_NAME = "Parlant Bridge";
const AGENT_DESCRIPTION = "Bridge to parlant";

const NO_HISTORY = new HistoryProvider([]);

const roomHistory = () =>
  new HistoryProvider([
    { sender_name: "Alice", message_type: "text", content: "Earlier question" },
    { sender_name: AGENT_NAME, message_type: "text", content: "Earlier answer" },
  ]);

const replyWith = (client: FakeParlantClient, ...replies: string[]) => {
  client.eventPollBatches.push(
    ...replies.map((message, index) => [{ kind: "message", offset: 10 * (index + 1), data: { message } }]),
  );
};

const fakeLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** An adapter on a borrowed agent; `options` override any of that (`agentId: undefined` makes it own one). */
const newAdapter = (client: FakeParlantClient, options: Partial<ParlantAdapterOptions> = {}) =>
  new ParlantAdapter({
    environment: "https://parlant.example",
    agentId: "agent-1",
    clientFactory: async () => client,
    responseTimeoutSeconds: 1,
    ...options,
  });

const startedAdapter = async (client: FakeParlantClient, options?: Partial<ParlantAdapterOptions>) => {
  const adapter = newAdapter(client, options);
  await adapter.onStarted(AGENT_NAME, AGENT_DESCRIPTION);
  return adapter;
};

interface TurnOptions {
  content?: string;
  tools?: FakeTools;
  history?: HistoryProvider;
  bootstrap?: boolean;
}

const turn = (
  adapter: ParlantAdapter,
  roomId: string,
  { content = "Hi", tools = new FakeTools(), history = NO_HISTORY, bootstrap = false }: TurnOptions = {},
) => adapter.onMessage(makeMessage(content, roomId), tools, history, null, null, { isSessionBootstrap: bootstrap, roomId });

describe("ParlantAdapter", () => {
  it("creates a session and forwards ai-agent response", async () => {
    const client = new FakeParlantClient();
    replyWith(client, "Parlant says hello");
    const adapter = await startedAdapter(client);

    const tools = new FakeTools();
    await turn(adapter, "room-1", { tools });

    expect(client.customerCreateCount).toBe(1);
    expect(client.sessionCreateCalls).toHaveLength(1);
    expect(
      client.eventCreateCalls.some((call) => call.params.source === "customer"),
    ).toBe(true);
    expect(tools.messages).toEqual(["Parlant says hello"]);
  });

  describeDeliveryContract([{
    path: "agent message",
    turn: async (tools) => {
      const client = new FakeParlantClient();
      replyWith(client, "Parlant says hello");
      await turn(await startedAdapter(client), "room-1", { tools });
    },
  }]);

  it("emits an error event when no response arrives before timeout", async () => {
    const client = new FakeParlantClient();
    client.eventPollBatches.push([]);
    client.eventPollBatches.push([]);
    const adapter = await startedAdapter(client);

    const tools = new FakeTools();
    await expectTurnFailed(turn(adapter, "room-timeout", { tools }));

    expect(tools.messages).toEqual([]);
    const failureEvent = findFailureEvent(tools);
    expect(failureEvent).toBeDefined();
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "parlant",
      message: "Parlant did not return a response before timeout.",
      code: "timeout",
    });
    // The timeout branch throws from inside the same try its own catch
    // guards — without rethrowIfRecoverableTurnFailure, the catch re-reports
    // a second, code-less duplicate.
    expect(failureEvents(tools)).toHaveLength(1);
  });

  it("creates one customer and session for concurrent first messages in one room", async () => {
    const client = new FakeParlantClient();
    replyWith(client, "First concurrent response", "Second concurrent response");
    const adapter = await startedAdapter(client);

    const tools = new FakeTools();
    await Promise.all(
      ["Current question A", "Current question B"].map((content) =>
        turn(adapter, "room-race", { content, tools, history: roomHistory(), bootstrap: true }),
      ),
    );

    expect(client.customerCreateCount).toBe(1);
    expect(client.sessionCreateCalls).toHaveLength(1);
    expect(tools.messages).toHaveLength(2);
  });

  it("reports, then fails the turn, on adapter request failures", async () => {
    const client = new FakeParlantClient();
    client.sessions.listEvents = async () => {
      throw new Error("poll failed");
    };
    const logger = fakeLogger();
    const adapter = await startedAdapter(client, { logger });

    const tools = new FakeTools();
    await expectTurnFailed(turn(adapter, "room-error", { tools }));

    expect(tools.events).toHaveLength(1);
    expect(tools.events[0]?.messageType).toBe("error");
    expect(tools.events[0]?.content).toContain("poll failed");
    expect(tools.events[0]?.metadata?.failure).toMatchObject({
      provider: "parlant",
      message: expect.stringContaining("poll failed"),
      code: null,
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Parlant adapter request failed",
      expect.objectContaining({
        roomId: "room-error",
        agentId: "agent-1",
      }),
    );
  });

  it("reports, then fails the turn, on a client initialization failure", async () => {
    const logger = fakeLogger();
    const adapter = await startedAdapter(new FakeParlantClient(), {
      clientFactory: async () => {
        throw new Error("parlant init failed");
      },
      logger,
    });

    const tools = new FakeTools();
    await expectTurnFailed(turn(adapter, "room-init", { tools }));

    expect(logger.error).toHaveBeenCalledWith(
      "Parlant client initialization failed",
      expect.objectContaining({
        error: expect.any(Error),
      }),
    );
    const failureEvent = findFailureEvent(tools);
    expect(failureEvent).toBeDefined();
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "parlant",
      message: "parlant init failed",
      code: null,
    });
  });

  it("stamps band_room_id metadata and a \"Band Room \" title on session creation", async () => {
    const client = new FakeParlantClient();
    replyWith(client, "hello");
    await turn(await startedAdapter(client), "room-band-meta");

    expect(client.sessionCreateCalls).toHaveLength(1);
    const created = client.sessionCreateCalls[0]!;
    expect(created.title?.startsWith("Band Room ")).toBe(true);
    const sessionMetadata = created.metadata as Record<string, unknown>;
    expect(sessionMetadata.band_room_id).toBe("room-band-meta");
    expect(Object.keys(sessionMetadata)).not.toContain("thenvoi_room_id");
  });

  it("forwards the customer message event with band_source and band_room_id metadata (not thenvoi_room_id)", async () => {
    const client = new FakeParlantClient();
    replyWith(client, "hello");
    await turn(await startedAdapter(client), "room-band-source");

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

  it("creates its own agent from the rendered prompt and never posts a system event", async () => {
    const client = new FakeParlantClient();
    replyWith(client, "hello");
    const adapter = await startedAdapter(client, { agentId: undefined, customSection: "End every reply with ZEBRA." });
    await turn(adapter, "room-owned", { bootstrap: true });

    expect(client.agentCreateCalls).toHaveLength(1);
    expect(client.agentCreateCalls[0]!.name).toBe(`band-${AGENT_NAME}`);
    expect(client.agentCreateCalls[0]!.description).toContain("End every reply with ZEBRA.");
    expect(client.sessionCreateCalls[0]!.agentId).toBe("agent-owned-1");
    expect(client.eventCreateCalls.map((call) => call.params.source)).toEqual(["customer"]);
  });

  it("uses a borrowed agent as-is", async () => {
    const client = new FakeParlantClient();
    replyWith(client, "hello");
    await turn(await startedAdapter(client), "room-borrowed", { bootstrap: true });

    expect(client.agentCreateCalls).toEqual([]);
    expect(client.sessionCreateCalls[0]!.agentId).toBe("agent-1");
  });

  it.each([
    { customSection: "Be brief." },
    { systemPrompt: "You are a bot." },
  ])("refuses a prompt for a borrowed agent: %o", (prompt) => {
    expect(
      () => new ParlantAdapter({ environment: "https://parlant.example", agentId: "agent-1", ...prompt }),
    ).toThrow(ValidationError);
  });

  it("folds bootstrap history into the first turn as one customer event", async () => {
    const client = new FakeParlantClient();
    replyWith(client, "First response", "Second response");
    const adapter = await startedAdapter(client);

    const tools = new FakeTools();
    await turn(adapter, "room-bootstrap", { content: "Current question", tools, history: roomHistory(), bootstrap: true });
    await turn(adapter, "room-bootstrap", { content: "Follow up", tools, history: roomHistory() });

    expect(client.eventCreateCalls.map((call) => call.params.source)).toEqual(["customer", "customer"]);
    const [first, second] = client.eventCreateCalls.map((call) => call.params.message as string);
    expect(first).toContain(PREVIOUS_CONTEXT_HEADER);
    expect(first).toContain("[Alice]: Earlier question");
    expect(first).toContain(`[${AGENT_NAME}]: Earlier answer`);
    expect(first!.endsWith("Current question")).toBe(true);
    expect(second).toBe("Follow up");
    expect(tools.messages).toEqual(["First response", "Second response"]);
  });

  it.each([
    { agentId: undefined, ownAgent: ["agent:agent-owned-1"] },
    { agentId: "agent-1", ownAgent: [] },
  ])("deletes the room's session and customer on cleanup, and only its own agent on stop (agentId: $agentId)", async ({ agentId, ownAgent }) => {
    const client = new FakeParlantClient();
    replyWith(client, "hello");
    const adapter = await startedAdapter(client, { agentId });
    await turn(adapter, "room-cleanup", { bootstrap: true });

    await adapter.onCleanup("room-cleanup");
    await adapter.onRuntimeStop();

    expect(client.deleted).toEqual(["session:session-1", "customer:customer-1", ...ownAgent]);
  });

  it("deletes an agent still being created when the runtime stops", async () => {
    const client = new FakeParlantClient();
    let finishCreate!: () => void;
    const create = client.agents.create;
    client.agents.create = async (params) => {
      await new Promise<void>((resolve) => (finishCreate = resolve));
      return create(params);
    };
    const adapter = newAdapter(client, { agentId: undefined });

    const starting = adapter.onStarted(AGENT_NAME, AGENT_DESCRIPTION);
    await vi.waitFor(() => expect(finishCreate).toBeDefined());
    const stopping = adapter.onRuntimeStop();
    finishCreate();
    await Promise.all([starting, stopping]);

    expect(client.deleted).toEqual(["agent:agent-owned-1"]);
  });

  it("logs a failed delete on cleanup instead of throwing", async () => {
    const client = new FakeParlantClient();
    replyWith(client, "hello");
    client.sessions.delete = async () => {
      throw new Error("server gone");
    };
    const logger = fakeLogger();
    const adapter = await startedAdapter(client, { logger });
    await turn(adapter, "room-gone", { bootstrap: true });

    await expect(adapter.onCleanup("room-gone")).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith("Failed to delete the Parlant session", expect.objectContaining({ id: "session-1" }));
    expect(client.deleted).toEqual(["customer:customer-1"]);
  });

  it("never emits legacy thenvoi_ keys or Thenvoi brand values in any outbound payload", async () => {
    const client = new FakeParlantClient();
    replyWith(client, "hello");

    const { sessionCreateCalls } = client;
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

    await turn(await startedAdapter(client), "room-plain", { history: roomHistory(), bootstrap: true });

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
