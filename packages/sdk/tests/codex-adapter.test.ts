import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { CodexAdapter } from "../src/adapters/codex/CodexAdapter";
import {
  CodexJsonRpcError,
  type CodexClientLike,
  type CodexRpcEvent,
} from "../src/adapters/codex/appServerClient";
import type { InitializeParams } from "../src/adapters/codex/appServerProtocol";
import { HistoryProvider } from "../src/runtime/types";
import { FakeTools, findFailureEvent, makeMessage, expectTurnFailed } from "./testUtils";
import { describeDeliveryContract } from "./deliveryContract";

class FakeCodexClient implements CodexClientLike {
  public readonly requestCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  public readonly responses: Array<{ id: number | string; result?: Record<string, unknown>; error?: Record<string, unknown> }> = [];
  public connectCalls = 0;
  public closeCalls = 0;

  private readonly events: CodexRpcEvent[];
  private readonly requestHandler: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

  public constructor(options?: {
    events?: CodexRpcEvent[];
    requestHandler?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  }) {
    this.events = [...(options?.events ?? [])];
    this.requestHandler = options?.requestHandler ?? defaultRequestHandler;
  }

  public async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  public async initialize(params: InitializeParams): Promise<void> {
    await this.request("initialize", params as unknown as Record<string, unknown>);
    await this.notify("initialized", {});
  }

  public async request<TResult>(method: string, params?: Record<string, unknown>): Promise<TResult> {
    const safeParams = params ?? {};
    this.requestCalls.push({ method, params: safeParams });
    return await this.requestHandler(method, safeParams) as TResult;
  }

  public async notify(_method: string, _params?: Record<string, unknown>): Promise<void> {}

  public async respond(id: number | string, result: Record<string, unknown>): Promise<void> {
    this.responses.push({ id, result });
  }

  public async respondError(
    id: number | string,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    this.responses.push({
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    });
  }

  public async recvEvent(): Promise<CodexRpcEvent> {
    const next = this.events.shift();
    if (!next) {
      throw new Error("No more fake Codex events available");
    }
    return next;
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class ToolSchemaFakeTools extends FakeTools {
  public readonly toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  public override getOpenAIToolSchemas(): Array<Record<string, unknown>> {
    return [
      {
        type: "function",
        function: {
          name: "band_send_message",
          description: "Send a message to the room.",
          parameters: {
            type: "object",
            properties: {
              content: { type: "string" },
              mentions: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["content", "mentions"],
          },
        },
      },
    ];
  }

  public override async executeToolCall(toolName: string, arguments_: Record<string, unknown>): Promise<unknown> {
    this.toolCalls.push({ name: toolName, args: arguments_ });
    return { ok: true, tool: toolName };
  }
}

function defaultRequestHandler(method: string, params: Record<string, unknown>): unknown {
  if (method === "initialize") {
    return { userAgent: "codex-test" };
  }

  if (method === "thread/start") {
    return {
      thread: { id: "thread-1" },
      model: "gpt-5.3-codex",
      params,
    };
  }

  if (method === "thread/resume") {
    return {
      thread: { id: String(params.threadId ?? "thread-resumed") },
      model: "gpt-5.3-codex",
    };
  }

  if (method === "turn/start") {
    return {
      turn: { id: "turn-1", status: "inProgress", error: null },
    };
  }

  if (method === "model/list") {
    return {
      data: [
        { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", description: "", hidden: false, isDefault: true },
        { id: "gpt-5.2", displayName: "GPT-5.2", description: "", hidden: false, isDefault: false },
      ],
    };
  }

  if (method === "turn/interrupt") {
    return {};
  }

  throw new Error(`Unexpected fake Codex request: ${method}`);
}

describe("CodexAdapter", () => {
  it("a /model list against a downed app server reports a failure and fails only that turn", async () => {
    // `/model list` is the one local command that reaches Codex, and local
    // commands run before onMessage's failure catch — so a bare rejection here
    // escaped to failRuntime and stopped every room.
    const adapter = new CodexAdapter({
      factory: async () => new FakeCodexClient({
        requestHandler: (method, params) => {
          if (method === "model/list") {
            throw new Error("app server is down");
          }
          return defaultRequestHandler(method, params);
        },
      }),
    });

    const tools = new FakeTools();
    await expectTurnFailed(adapter.onMessage(
      makeMessage("/model list", "room-models"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-models" },
    ));

    expect(tools.messages).toEqual([]);
    expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
      provider: "codex",
      message: "app server is down",
    });
  });

  describeDeliveryContract([{
    path: "final agent message",
    turn: async (tools) => {
      const fakeClient = new FakeCodexClient({
        events: [
          {
            kind: "notification",
            method: "item/completed",
            params: { item: { type: "agentMessage", id: "msg-1", text: "the answer" } },
          },
          {
            kind: "notification",
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "completed", error: null } },
          },
        ],
      });

      const adapter = new CodexAdapter({ factory: async () => fakeClient });
      await adapter.onMessage(
        makeMessage("question"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-delivery" },
      );
    },
  }, {
    path: "local /help command reply",
    turn: async (tools) => {
      // Local commands are answered before the Codex client is ever reached,
      // and outside onMessage's failure catch — so this path had its own way
      // of escaping, and its own way of taking the runtime down.
      const adapter = new CodexAdapter({ factory: async () => new FakeCodexClient() });
      await adapter.onMessage(
        makeMessage("/help"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-help" },
      );
    },
  }]);

  it("registers platform and custom tools and executes them through the app-server", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "request",
          id: 1,
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-platform",
            tool: "band_send_message",
            arguments: {
              content: "hello",
              mentions: ["@user"],
            },
          },
        },
        {
          kind: "request",
          id: 2,
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-custom",
            tool: "post_action",
            arguments: {
              text: "working",
            },
          },
        },
        {
          kind: "notification",
          method: "item/completed",
          params: {
            item: {
              type: "reasoning",
              id: "reason-1",
              summary: ["thinking"],
              content: [],
            },
          },
        },
        {
          kind: "notification",
          method: "item/completed",
          params: {
            item: {
              type: "commandExecution",
              id: "cmd-1",
              command: "echo ok",
              cwd: "/tmp",
              aggregatedOutput: "ok",
              exitCode: 0,
              status: "completed",
            },
          },
        },
        {
          kind: "notification",
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              error: null,
            },
          },
        },
      ],
    });

    const adapter = new CodexAdapter({
      config: {
        model: "gpt-5.3-codex",
        cwd: "/tmp/workdir",
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        reasoningEffort: "medium",
        enableExecutionReporting: true,
        emitThoughtEvents: true,
        systemPrompt: "Coordinate room work and use tools.",
      },
      customTools: [
        {
          name: "post_action",
          description: "Post a progress action.",
          schema: z.object({
            text: z.string(),
          }),
          handler: async (args) => `action:${String(args.text ?? "")}`,
        },
      ],
      factory: async () => fakeClient,
    });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await adapter.onMessage(
      makeMessage("diagnose and fix"),
      tools,
      new HistoryProvider([
        { sender_name: "Alice", sender_type: "User", content: "historical message", message_type: "text" },
      ]),
      "Participants changed",
      "Contacts updated",
      { isSessionBootstrap: true, roomId: "room-1" },
    );

    const threadStart = fakeClient.requestCalls.find((call) => call.method === "thread/start");
    expect(threadStart).toBeDefined();
    expect(threadStart?.params).toMatchObject({
      model: "gpt-5.3-codex",
      cwd: "/tmp/workdir",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      developerInstructions: expect.stringContaining("Coordinate room work and use tools."),
      dynamicTools: expect.arrayContaining([
        expect.objectContaining({ name: "band_send_message" }),
        expect.objectContaining({ name: "post_action" }),
      ]),
    });

    const turnStart = fakeClient.requestCalls.find((call) => call.method === "turn/start");
    expect(turnStart?.params.input).toEqual([
      {
        type: "text",
        text: "[Conversation History]\nThe following is the conversation history from a previous session. Use it to maintain continuity.\n[Alice]: historical message",
      },
      { type: "text", text: "[System]: Participants changed" },
      { type: "text", text: "[System]: Contacts updated" },
      { type: "text", text: "[User]: diagnose and fix" },
    ]);

    expect(tools.toolCalls).toEqual([
      {
        name: "band_send_message",
        args: {
          content: "hello",
          mentions: ["@user"],
        },
      },
    ]);
    expect(fakeClient.responses).toEqual([
      {
        id: 1,
        result: {
          contentItems: [{ type: "inputText", text: "{\"ok\":true,\"tool\":\"band_send_message\"}" }],
          success: true,
        },
      },
      {
        id: 2,
        result: {
          contentItems: [{ type: "inputText", text: "action:working" }],
          success: true,
        },
      },
    ]);
    expect(tools.messages).toEqual([]);
    expect(tools.events.some((event) => event.messageType === "thought" && event.content === "thinking")).toBe(true);
    expect(tools.events.some((event) => event.messageType === "tool_call" && event.content.includes("\"name\":\"exec\""))).toBe(true);
    expect(tools.events.some((event) => event.messageType === "task" && event.metadata?.codex_thread_id === "thread-1")).toBe(true);
  });

  it("falls back to a new thread and injects history when resume fails", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "notification",
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "msg-1",
              text: "resumed via fallback",
            },
          },
        },
        {
          kind: "notification",
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              error: null,
            },
          },
        },
      ],
      requestHandler: async (method, params) => {
        if (method === "thread/resume") {
          throw new CodexJsonRpcError(-32002, "Thread expired");
        }
        return defaultRequestHandler(method, params);
      },
    });

    const adapter = new CodexAdapter({
      factory: async () => fakeClient,
    });

    await adapter.onMessage(
      makeMessage("continue"),
      tools,
      new HistoryProvider([
        {
          sender_name: "Alice",
          sender_type: "User",
          content: "Earlier context",
          message_type: "text",
        },
        {
          message_type: "task",
          metadata: {
            codex_thread_id: "thread-old",
          },
        },
      ]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-42" },
    );

    expect(fakeClient.requestCalls.map((call) => call.method)).toContain("thread/resume");
    expect(fakeClient.requestCalls.map((call) => call.method)).toContain("thread/start");

    const turnStart = fakeClient.requestCalls.find((call) => call.method === "turn/start");
    expect(turnStart?.params.input).toEqual([
      {
        type: "text",
        text: "[Conversation History]\nThe following is the conversation history from a previous session. Use it to maintain continuity.\n[Alice]: Earlier context",
      },
      { type: "text", text: "[User]: continue" },
    ]);
    expect(tools.messages).toEqual(["resumed via fallback"]);
  });

  it("does not resume an older thread when bootstrap metadata requests a reset", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "notification",
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "msg-1",
              text: "fresh thread after reset",
            },
          },
        },
        {
          kind: "notification",
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              error: null,
            },
          },
        },
      ],
    });

    const adapter = new CodexAdapter({
      factory: async () => fakeClient,
    });

    await adapter.onMessage(
      {
        ...makeMessage("restart here"),
        metadata: {
          linear_reset_room_session: true,
        },
      },
      tools,
      new HistoryProvider([
        {
          sender_name: "Alice",
          sender_type: "User",
          content: "Old context that should be ignored",
          message_type: "text",
        },
        {
          message_type: "task",
          metadata: {
            codex_thread_id: "thread-old",
          },
        },
      ]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-reset" },
    );

    expect(fakeClient.requestCalls.map((call) => call.method)).not.toContain("thread/resume");
    expect(fakeClient.requestCalls.map((call) => call.method)).toContain("thread/start");
    const turnStart = fakeClient.requestCalls.find((call) => call.method === "turn/start");
    expect(turnStart?.params.input).toEqual([
      { type: "text", text: "[User]: restart here" },
    ]);
    expect(tools.messages).toEqual(["fresh thread after reset"]);
  });

  it("does not emit empty reasoning placeholders as thought events", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "notification",
          method: "item/completed",
          params: {
            item: {
              type: "reasoning",
              id: "reason-empty",
              summary: [],
              content: [],
            },
          },
        },
        {
          kind: "notification",
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              error: null,
            },
          },
        },
      ],
    });

    const adapter = new CodexAdapter({
      config: {
        emitThoughtEvents: true,
      },
      factory: async () => fakeClient,
    });

    await adapter.onStarted("Codex Agent", "Codex parity adapter");
    await adapter.onMessage(
      makeMessage("think quietly"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-empty-reasoning" },
    );

    expect(tools.events.some((event) => event.messageType === "thought" && event.content === "(reasoning)")).toBe(false);
  });

  it("renders default Band prompt and appends customSection when no full override is set", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "notification",
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              error: null,
            },
          },
        },
      ],
    });

    const adapter = new CodexAdapter({
      config: {
        customSection: "Linear policy: always post_thought before complete_session.",
      },
      factory: async () => fakeClient,
    });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await adapter.onMessage(
      makeMessage("check"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-custom-section" },
    );

    const threadStart = fakeClient.requestCalls.find((call) => call.method === "thread/start");
    const developerInstructions = typeof threadStart?.params.developerInstructions === "string"
      ? threadStart.params.developerInstructions
      : "";

    expect(developerInstructions).toContain("Linear policy: always post_thought before complete_session.");
    expect(developerInstructions).toContain("Use `band_send_message(content, mentions)` to respond.");
  });

  it("handles local slash commands without starting a turn", async () => {
    const fakeClient = new FakeCodexClient();
    const adapter = new CodexAdapter({
      config: {
        model: "gpt-5.3-codex",
      },
      factory: async () => fakeClient,
    });

    const tools = new ToolSchemaFakeTools();
    await adapter.onMessage(
      makeMessage("/status"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-cmd" },
    );
    await adapter.onMessage(
      makeMessage("/model list"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-cmd" },
    );
    await adapter.onMessage(
      makeMessage("/model gpt-5.2"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-cmd" },
    );
    await adapter.onMessage(
      makeMessage("/reasoning nope"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-cmd" },
    );

    expect(fakeClient.requestCalls.some((call) => call.method === "turn/start")).toBe(false);
    expect(tools.messages[0]).toContain("Codex status");
    expect(tools.messages[1]).toContain("Available models:");
    expect(tools.messages[2]).toContain("Model override set to");
    expect(tools.messages[3]).toContain("Invalid reasoning effort `nope`");
  });

  it("logs client initialization failures, surfaces them via sendFailure, then fails the turn", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const adapter = new CodexAdapter({
      factory: async () => {
        throw new Error("codex init failed");
      },
      logger,
    });
    const tools = new ToolSchemaFakeTools();

    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-init" },
    ));

    expect(logger.error).toHaveBeenCalledWith(
      "Codex client initialization failed",
      expect.objectContaining({
        error: expect.any(Error),
      }),
    );
    const failureEvent = findFailureEvent(tools);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "codex",
      message: "codex init failed",
      code: null,
      detail: null,
    });
    expect(tools.messages).toEqual([]);
  });

  it("emits a structured sendFailure for a getOrCreateThread failure (thread/start rejecting after a resume miss)", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      requestHandler: (method, params) => {
        if (method === "thread/start") {
          throw new Error("thread/start failed");
        }
        return defaultRequestHandler(method, params);
      },
    });
    const adapter = new CodexAdapter({ factory: async () => fakeClient });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-thread-fail" },
    ));

    const failureEvent = findFailureEvent(tools);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "codex",
      message: "thread/start failed",
      code: null,
      detail: null,
    });
    expect(tools.messages).toEqual([]);
    expect(fakeClient.requestCalls.some((call) => call.method === "turn/start")).toBe(false);
  });

  it("passes a Codex protocol-level error notification through to sendFailure with its code and detail", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "notification",
          method: "error",
          params: {
            error: { code: "invalid_request", message: "bad turn input" },
          },
        },
        {
          kind: "notification",
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed", error: null } },
        },
      ],
    });
    const adapter = new CodexAdapter({ factory: async () => fakeClient });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-proto-error" },
    );

    const failureEvent = findFailureEvent(tools);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "codex",
      code: "invalid_request",
      message: "bad turn input",
      detail: { code: "invalid_request", message: "bad turn input" },
    });
  });

  it("does not surface a retryable protocol-level error notification as a failure", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "notification",
          method: "error",
          params: {
            error: { message: "transient hiccup" },
            willRetry: true,
          },
        },
        {
          kind: "notification",
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed", error: null } },
        },
      ],
    });
    const adapter = new CodexAdapter({ factory: async () => fakeClient });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-retry-error" },
    );

    expect(tools.events.some((event) => event.messageType === "error")).toBe(false);
  });

  it("reports a mid-turn error notification only once, even when turn/completed also ends in failure", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "notification",
          method: "error",
          params: {
            error: { code: "invalid_request", message: "bad turn input" },
          },
        },
        {
          kind: "notification",
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "failed", error: null } },
        },
      ],
    });
    const adapter = new CodexAdapter({ factory: async () => fakeClient });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-double-report" },
    );

    const failureEvents = tools.events.filter((event) => event.messageType === "error");
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]?.metadata?.failure).toMatchObject({
      provider: "codex",
      code: "invalid_request",
      message: "bad turn input",
    });
  });

  it("reports a mid-turn error notification only once, even when the turn is then interrupted", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "notification",
          method: "error",
          params: {
            error: { code: "invalid_request", message: "bad turn input" },
          },
        },
        // recvEvent's queue is exhausted after this: the fake throws on the
        // next call, exactly like a real recvEvent timeout, driving
        // emitTurnOutcome's "interrupted" branch.
      ],
    });
    const adapter = new CodexAdapter({ factory: async () => fakeClient });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-double-report-interrupted" },
    );

    const failureEvents = tools.events.filter((event) => event.messageType === "error");
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]?.metadata?.failure).toMatchObject({
      provider: "codex",
      code: "invalid_request",
      message: "bad turn input",
    });
  });

  it("emits a structured sendFailure with code 'interrupted' when the turn is interrupted (e.g. a recvEvent timeout)", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({ events: [] });
    const adapter = new CodexAdapter({ factory: async () => fakeClient });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-interrupt" },
    );

    const failureEvent = findFailureEvent(tools);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "codex",
      code: "interrupted",
      message: "Turn timed out",
    });
    // Posted alongside the structured event, not replaced by it: this is the
    // one reply that has always notified the requester their turn failed, and
    // mentions ride on messages only. The friendly sentence stays the visible
    // text while the raw provider message goes in the event.
    expect(tools.messages).toEqual(["I stopped before completing this request."]);
    expect(fakeClient.requestCalls.some((call) => call.method === "turn/interrupt")).toBe(true);
  });

  it("emits a structured sendFailure with the codex-declared turnStatus when the transport closes mid-turn", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        { kind: "notification", method: "transport/closed", params: {} },
      ],
    });
    const adapter = new CodexAdapter({ factory: async () => fakeClient });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-transport-closed" },
    );

    const failureEvent = findFailureEvent(tools);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "codex",
      code: "failed",
      message: expect.stringContaining("Codex transport closed unexpectedly"),
    });
    // Same text in both, as before this contract existed — the event adds
    // structure without taking the requester's notification away.
    expect(tools.messages).toEqual([
      "I couldn't complete this request (failed): Codex transport closed unexpectedly",
    ]);
  });

  it("rejects malformed item/tool/call payloads", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "request",
          id: 1,
          method: "item/tool/call",
          params: {
            tool: "band_send_message",
            arguments: {
              content: "hello",
            },
          },
        },
        {
          kind: "notification",
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              error: null,
            },
          },
        },
      ],
    });

    const adapter = new CodexAdapter({
      factory: async () => fakeClient,
    });

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-invalid-tool-call" },
    );

    expect(tools.toolCalls).toEqual([]);
    expect(fakeClient.responses).toContainEqual({
      id: 1,
      error: {
        code: -32602,
        message: "Invalid params for item/tool/call",
      },
    });
  });

  it("reports custom tool failures with structured output while returning compatible text to Codex", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "request",
          id: 1,
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-custom-fail",
            tool: "post_action",
            arguments: {
              text: "boom",
            },
          },
        },
        {
          kind: "notification",
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              error: null,
            },
          },
        },
      ],
    });

    const adapter = new CodexAdapter({
      config: {
        enableExecutionReporting: true,
      },
      customTools: [
        {
          name: "post_action",
          description: "Post an action.",
          schema: z.object({
            text: z.string(),
          }),
          handler: async () => {
            throw new Error("custom boom");
          },
        },
      ],
      factory: async () => fakeClient,
    });

    await adapter.onMessage(
      makeMessage("run custom"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-custom-failure" },
    );

    expect(fakeClient.responses).toContainEqual({
      id: 1,
      result: {
        contentItems: [{ type: "inputText", text: "Error: Custom tool post_action failed: custom boom" }],
        success: false,
      },
    });

    const toolResultEvent = tools.events.find((event) => event.messageType === "tool_result");
    expect(toolResultEvent).toBeDefined();
    if (!toolResultEvent) {
      throw new Error("Expected a tool_result event");
    }

    const payload = JSON.parse(toolResultEvent.content) as {
      name: string;
      output: {
        ok: false;
        errorType: string;
        toolName: string;
        message: string;
      };
      tool_call_id: string;
    };
    expect(payload.name).toBe("post_action");
    expect(payload.tool_call_id).toBe("call-custom-fail");
    expect(payload.output).toMatchObject({
      ok: false,
      toolName: "post_action",
      message: "Custom tool post_action failed: custom boom",
    });
    expect(["CustomToolExecutionError", "CustomToolUnknownError"]).toContain(payload.output.errorType);
  });

  it("sends the default band clientInfo name and title on initialize", async () => {
    const fakeClient = new FakeCodexClient();
    const adapter = new CodexAdapter({
      config: {
        model: "gpt-5.3-codex",
        cwd: "/tmp/workdir",
      },
      factory: async () => fakeClient,
    });

    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    const initializeCall = fakeClient.requestCalls.find((call) => call.method === "initialize");
    expect(initializeCall).toBeDefined();
    const clientInfo = initializeCall?.params.clientInfo as { name: string; title: string };
    expect(clientInfo.name).toBe("band_codex_adapter");
    expect(clientInfo.title).toBe("Band Codex Adapter");
  });

  it("lets the caller override clientInfo name and title via config", async () => {
    const fakeClient = new FakeCodexClient();
    const adapter = new CodexAdapter({
      config: {
        model: "gpt-5.3-codex",
        cwd: "/tmp/workdir",
        clientName: "custom_codex_adapter",
        clientTitle: "Custom Codex Adapter",
      },
      factory: async () => fakeClient,
    });

    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    const initializeCall = fakeClient.requestCalls.find((call) => call.method === "initialize");
    expect(initializeCall).toBeDefined();
    const clientInfo = initializeCall?.params.clientInfo as { name: string; title: string };
    expect(clientInfo.name).toBe("custom_codex_adapter");
    expect(clientInfo.title).toBe("Custom Codex Adapter");
  });
});
