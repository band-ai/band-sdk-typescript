import { describe, expect, it, vi } from "vitest";

import { A2AAdapter } from "../src/adapters/a2a/A2AAdapter";
import { A2AHistoryConverter, buildA2AAuthHeaders } from "../src/adapters/a2a/types";
import { FakeTools, makeMessage } from "./testUtils";

function streamFrom<T>(items: T[]): AsyncGenerator<T, void> {
  return (async function* generator(): AsyncGenerator<T, void> {
    for (const item of items) {
      yield item;
    }
  })();
}

class FakeA2AClient {
  public readonly sendMessageCalls: Array<{ message?: { contextId?: string; taskId?: string } }> = [];
  public readonly resubscribeCalls: Array<{ id?: string }> = [];
  private readonly streamBatches: unknown[][];
  private readonly resubscribeBatches: unknown[][];
  private readonly sendResponses: unknown[];
  private readonly sendErrors: Error[];
  private readonly resubscribeErrors: Error[];

  public constructor(options: {
    streamBatches?: unknown[][];
    resubscribeBatches?: unknown[][];
    sendResponses?: unknown[];
    sendErrors?: Error[];
    resubscribeErrors?: Error[];
  }) {
    this.streamBatches = [...(options.streamBatches ?? [])];
    this.resubscribeBatches = [...(options.resubscribeBatches ?? [])];
    this.sendResponses = [...(options.sendResponses ?? [])];
    this.sendErrors = [...(options.sendErrors ?? [])];
    this.resubscribeErrors = [...(options.resubscribeErrors ?? [])];
  }

  public sendMessageStream(
    params: { message?: { contextId?: string; taskId?: string } },
  ): AsyncGenerator<unknown, void> {
    this.sendMessageCalls.push(params);
    return streamFrom(this.streamBatches.shift() ?? []);
  }

  public async sendMessage(
    params: { message?: { contextId?: string; taskId?: string } },
  ): Promise<unknown> {
    this.sendMessageCalls.push(params);
    const error = this.sendErrors.shift();
    if (error) {
      throw error;
    }
    return this.sendResponses.shift() ?? null;
  }

  public resubscribeTask(params: { id?: string }): AsyncGenerator<unknown, void> {
    this.resubscribeCalls.push(params);
    const error = this.resubscribeErrors.shift();
    if (error) {
      return (async function* generator(): AsyncGenerator<unknown, void> {
        throw error;
      })();
    }
    return streamFrom(this.resubscribeBatches.shift() ?? []);
  }
}

describe("A2AHistoryConverter", () => {
  it("extracts most recent A2A session metadata from task history events", () => {
    const converter = new A2AHistoryConverter();
    const state = converter.convert([
      {
        message_type: "task",
        metadata: {
          a2a_context_id: "ctx-1",
          a2a_task_id: "task-1",
          a2a_task_state: "working",
        },
      },
      {
        message_type: "text",
      },
      {
        message_type: "task",
        metadata: {
          a2a_context_id: "ctx-2",
          a2a_task_id: "task-2",
          a2a_task_state: "input-required",
        },
      },
    ]);

    expect(state).toEqual({
      contextId: "ctx-2",
      taskId: "task-2",
      taskState: "input-required",
    });
  });
});

describe("A2AAdapter", () => {
  it("builds auth headers and rejects CRLF header values", () => {
    expect(
      buildA2AAuthHeaders({
        headers: {
          "X-Custom": "value",
        },
        apiKey: "api-key",
        bearerToken: "token",
      }),
    ).toEqual({
      "X-Custom": "value",
      "X-API-Key": "api-key",
      Authorization: "Bearer token",
    });

    expect(() =>
      buildA2AAuthHeaders({
        headers: {
          "X-Bad": "bad\nvalue",
        },
      }),
    ).toThrow("X-Bad header value must not contain CR or LF characters.");
  });

  it("rehydrates context/task state and forwards streamed task updates", async () => {
    const client = new FakeA2AClient({
      resubscribeBatches: [
        [
          {
            kind: "status-update",
            taskId: "task-9",
            contextId: "ctx-9",
            status: { state: "working" },
          },
        ],
      ],
      streamBatches: [
        [
          {
            kind: "status-update",
            taskId: "task-9",
            contextId: "ctx-9",
            status: {
              state: "working",
              message: {
                kind: "message",
                parts: [{ kind: "text", text: "Thinking..." }],
              },
            },
          },
          {
            kind: "status-update",
            taskId: "task-9",
            contextId: "ctx-9",
            status: {
              state: "input-required",
              message: {
                kind: "message",
                parts: [{ kind: "text", text: "Need the currency pair." }],
              },
            },
          },
          {
            kind: "artifact-update",
            taskId: "task-9",
            contextId: "ctx-9",
            artifact: {
              parts: [{ kind: "text", text: "1 USD = 0.92 EUR" }],
            },
          },
          {
            kind: "status-update",
            taskId: "task-9",
            contextId: "ctx-9",
            status: { state: "completed" },
          },
        ],
      ],
    });

    const adapter = new A2AAdapter({
      remoteUrl: "a2a-remote",
      clientFactory: async () => client,
    });
    await adapter.onStarted("A2A Bridge", "Bridge remote A2A agents");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("Convert 1 USD"),
      tools,
      {
        contextId: "ctx-9",
        taskId: "task-9",
        taskState: "input_required",
      },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-1" },
    );

    expect(client.resubscribeCalls).toEqual([{ id: "task-9" }]);
    const request = client.sendMessageCalls[0];
    expect(request?.message?.contextId).toBe("ctx-9");
    expect(request?.message?.taskId).toBe("task-9");

    expect(tools.messages).toContain("Need the currency pair.");
    expect(tools.messages).toContain("1 USD = 0.92 EUR");
    expect(tools.events.some((event) => event.messageType === "thought")).toBe(true);
    expect(tools.events.filter((event) => event.messageType === "task")).toHaveLength(2);
  });

  it("clears terminal task id but preserves context id for the next user turn", async () => {
    const client = new FakeA2AClient({
      streamBatches: [
        [
          {
            kind: "status-update",
            taskId: "task-1",
            contextId: "ctx-1",
            status: {
              state: "completed",
              message: {
                kind: "message",
                parts: [{ kind: "text", text: "Done." }],
              },
            },
          },
        ],
        [],
      ],
    });

    const adapter = new A2AAdapter({
      remoteUrl: "a2a-remote",
      clientFactory: async () => client,
    });

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("First turn", "room-2"),
      tools,
      { contextId: null, taskId: null, taskState: null },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-2" },
    );
    await adapter.onMessage(
      makeMessage("Second turn", "room-2"),
      tools,
      { contextId: null, taskId: null, taskState: null },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-2" },
    );

    const first = client.sendMessageCalls[0];
    const second = client.sendMessageCalls[1];

    expect(first?.message?.contextId).toBeUndefined();
    expect(second?.message?.contextId).toBe("ctx-1");
    expect(second?.message?.taskId).toBeUndefined();
  });

  it("reports adapter errors to the room and rethrows", async () => {
    const client = new FakeA2AClient({
      sendErrors: [new Error("upstream failure")],
    });

    const adapter = new A2AAdapter({
      remoteUrl: "a2a-remote",
      streaming: false,
      clientFactory: async () => client,
    });

    const tools = new FakeTools();
    await expect(
      adapter.onMessage(
        makeMessage("hello"),
        tools,
        { contextId: null, taskId: null, taskState: null },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-3" },
      ),
    ).rejects.toThrow("upstream failure");

    expect(tools.events).toHaveLength(1);
    expect(tools.events[0]?.messageType).toBe("error");
    expect(tools.events[0]?.content).toContain("upstream failure");
    expect(tools.events[0]?.metadata).toMatchObject({ a2a_error: "upstream failure" });
  });

  it("honors a custom maxStreamEvents limit and logs the failure", async () => {
    const client = new FakeA2AClient({
      streamBatches: [
        [
          {
            kind: "message",
            parts: [{ kind: "text", text: "first chunk" }],
          },
          {
            kind: "message",
            parts: [{ kind: "text", text: "second chunk" }],
          },
        ],
      ],
    });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const adapter = new A2AAdapter({
      remoteUrl: "a2a-remote",
      clientFactory: async () => client,
      maxStreamEvents: 1,
      logger,
    });

    const tools = new FakeTools();
    await expect(
      adapter.onMessage(
        makeMessage("hello", "room-limit"),
        tools,
        { contextId: null, taskId: null, taskState: null },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-limit" },
      ),
    ).rejects.toThrow("maximum event limit (1)");

    expect(tools.messages).toEqual(["first chunk"]);
    expect(tools.events).toHaveLength(1);
    expect(tools.events[0]?.messageType).toBe("error");
    expect(tools.events[0]?.content).toContain("maximum event limit (1)");
    expect(logger.error).toHaveBeenCalledWith(
      "A2A adapter request failed",
      expect.objectContaining({
        roomId: "room-limit",
        remoteUrl: "a2a-remote",
      }),
    );
  });

  it("logs per-event handler failures and continues streaming later events", async () => {
    const client = new FakeA2AClient({
      streamBatches: [
        [
          {
            kind: "message",
            parts: [{ kind: "text", text: "first chunk" }],
          },
          {
            kind: "message",
            parts: [{ kind: "text", text: "second chunk" }],
          },
        ],
      ],
    });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const adapter = new A2AAdapter({
      remoteUrl: "a2a-remote",
      clientFactory: async () => client,
      logger,
    });
    const tools = new FakeTools({
      failOn: ["sendMessage"],
      errorFactory: () => {
        const error = new Error("downstream send failed");
        tools.sendMessage = vi.fn(async (content: string) => {
          tools.messages.push(content);
          return { ok: true };
        }) as typeof tools.sendMessage;
        return error;
      },
    });

    await expect(
      adapter.onMessage(
        makeMessage("hello", "room-stream"),
        tools,
        { contextId: null, taskId: null, taskState: null },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-stream" },
      ),
    ).resolves.toBeUndefined();

    expect(tools.messages).toEqual(["second chunk"]);
    expect(logger.error).toHaveBeenCalledWith(
      "A2A stream event handling failed; continuing stream",
      expect.objectContaining({
        roomId: "room-stream",
        remoteUrl: "a2a-remote",
        streamEventCount: 1,
      }),
    );
  });

  it("rejects invalid maxStreamEvents values", () => {
    expect(
      () =>
        new A2AAdapter({
          remoteUrl: "a2a-remote",
          maxStreamEvents: 0,
        }),
    ).toThrow("positive integer");
  });

  it("unwraps nested non-streaming task results and extracts replies from agent history", async () => {
    const client = new FakeA2AClient({
      sendResponses: [
        {
          result: {
            result: {
              kind: "task",
              id: "task-7",
              contextId: "ctx-7",
              status: { state: "completed" },
              history: [
                {
                  kind: "message",
                  role: "agent",
                  parts: [{ root: { text: "History answer" } }],
                },
              ],
            },
          },
        },
      ],
    });

    const adapter = new A2AAdapter({
      remoteUrl: "a2a-remote",
      streaming: false,
      clientFactory: async () => client,
    });

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("hello", "room-non-stream"),
      tools,
      { contextId: null, taskId: null, taskState: null },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-non-stream" },
    );
    await adapter.onMessage(
      makeMessage("follow up", "room-non-stream"),
      tools,
      { contextId: null, taskId: null, taskState: null },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-non-stream" },
    );

    expect(tools.messages).toContain("History answer");
    expect(tools.events.some((event) =>
      event.messageType === "task" && event.metadata?.a2a_task_state === "completed"
    )).toBe(true);
    expect(client.sendMessageCalls[1]?.message?.contextId).toBe("ctx-7");
    expect(client.sendMessageCalls[1]?.message?.taskId).toBeUndefined();
  });

  it("clears failed tasks and starts a fresh task on the next turn", async () => {
    const client = new FakeA2AClient({
      streamBatches: [
        [
          {
            kind: "status-update",
            taskId: "task-failed",
            contextId: "ctx-failed",
            status: {
              state: "failed",
              message: {
                kind: "message",
                parts: [{ kind: "text", text: "The upstream request failed." }],
              },
            },
          },
        ],
        [],
      ],
    });

    const adapter = new A2AAdapter({
      remoteUrl: "a2a-remote",
      clientFactory: async () => client,
    });

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("first", "room-failed"),
      tools,
      { contextId: null, taskId: null, taskState: null },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-failed" },
    );
    await adapter.onMessage(
      makeMessage("second", "room-failed"),
      tools,
      { contextId: null, taskId: null, taskState: null },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-failed" },
    );

    expect(tools.events).toContainEqual(
      expect.objectContaining({
        messageType: "error",
        metadata: { a2a_state: "failed" },
      }),
    );
    expect(client.sendMessageCalls[1]?.message?.contextId).toBe("ctx-failed");
    expect(client.sendMessageCalls[1]?.message?.taskId).toBeUndefined();
  });

  it("drops terminal bootstrap tasks and warns when resubscribe fails", async () => {
    const terminalClient = new FakeA2AClient({
      resubscribeBatches: [
        [
          {
            kind: "status-update",
            taskId: "task-old",
            contextId: "ctx-old",
            status: { state: "completed" },
          },
        ],
      ],
      streamBatches: [[]],
    });
    const terminalAdapter = new A2AAdapter({
      remoteUrl: "a2a-remote",
      clientFactory: async () => terminalClient,
    });

    await terminalAdapter.onMessage(
      makeMessage("new turn", "room-terminal-bootstrap"),
      new FakeTools(),
      {
        contextId: "ctx-prev",
        taskId: "task-old",
        taskState: "working",
      },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-terminal-bootstrap" },
    );

    expect(terminalClient.sendMessageCalls[0]?.message?.contextId).toBe("ctx-old");
    expect(terminalClient.sendMessageCalls[0]?.message?.taskId).toBeUndefined();

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const failingClient = new FakeA2AClient({
      resubscribeErrors: [new Error("socket reset")],
      streamBatches: [[]],
    });
    const failingAdapter = new A2AAdapter({
      remoteUrl: "a2a-remote",
      clientFactory: async () => failingClient,
      logger,
    });

    await failingAdapter.onMessage(
      makeMessage("retry", "room-resubscribe-error"),
      new FakeTools(),
      {
        contextId: "ctx-keep",
        taskId: "task-keep",
        taskState: "working",
      },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-resubscribe-error" },
    );

    expect(logger.warn).toHaveBeenCalledWith(
      "A2A task resubscribe failed; continuing with fresh task",
      expect.objectContaining({
        roomId: "room-resubscribe-error",
        taskId: "task-keep",
      }),
    );
    expect(failingClient.sendMessageCalls[0]?.message?.contextId).toBe("ctx-keep");
    expect(failingClient.sendMessageCalls[0]?.message?.taskId).toBeUndefined();
  });

  it("warns when bootstrap resubscribe exceeds the event limit", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const client = new FakeA2AClient({
      resubscribeBatches: [
        [
          { result: null },
          { result: null },
        ],
      ],
      streamBatches: [[]],
    });
    const adapter = new A2AAdapter({
      remoteUrl: "a2a-remote",
      clientFactory: async () => client,
      logger,
      maxStreamEvents: 1,
    });

    await adapter.onMessage(
      makeMessage("resume", "room-limit-bootstrap"),
      new FakeTools(),
      {
        contextId: "ctx-limit",
        taskId: "task-limit",
        taskState: "working",
      },
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-limit-bootstrap" },
    );

    expect(logger.warn).toHaveBeenCalledWith(
      "A2A task resubscribe exceeded event limit; continuing with fresh task",
      expect.objectContaining({
        roomId: "room-limit-bootstrap",
        taskId: "task-limit",
        maxStreamEvents: 1,
      }),
    );
    expect(client.sendMessageCalls[0]?.message?.contextId).toBe("ctx-limit");
    expect(client.sendMessageCalls[0]?.message?.taskId).toBeUndefined();
  });
});
