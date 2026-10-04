import { realpathSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { CodexAdapter } from "../src/adapters/codex";
import {
  CodexJsonRpcError,
  type CodexClientLike,
  type CodexRpcEvent,
} from "../src/adapters/codex/appServerClient";
import type { InitializeParams } from "../src/adapters/codex/appServerProtocol";
import { NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import { trackTurn } from "../src/core/turn";
import { BASE_INSTRUCTIONS } from "../src/runtime/prompts";
import { HistoryProvider } from "../src/runtime/types";
import { FakeTools, failureEvents, findFailureEvent, makeMessage, expectTurnFailed, roomWorkspacePath, tmpRoot } from "./testUtils";
import { describeDeliveryContract } from "./deliveryContract";
import { CLOSING_TEXT, TOOL_REPLY, describeTurnOutcomeContract, turnInput, type TurnScript } from "./turnOutcomeContract";

class FakeCodexClient implements CodexClientLike {
  public readonly requestCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  public readonly responses: Array<{ id: number | string; result?: Record<string, unknown>; error?: Record<string, unknown> }> = [];
  public connectCalls = 0;
  public closeCalls = 0;

  private readonly events: CodexRpcEvent[];
  private readonly requestHandler: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  private readonly hangWhenEmpty: boolean;
  public closeNeverSettles = false;

  public constructor(options?: {
    events?: CodexRpcEvent[];
    requestHandler?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
    hangWhenEmpty?: boolean;
  }) {
    this.events = [...(options?.events ?? [])];
    this.requestHandler = options?.requestHandler ?? defaultRequestHandler;
    this.hangWhenEmpty = options?.hangWhenEmpty ?? false;
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
    if (next) {
      return next;
    }
    if (this.hangWhenEmpty) {
      return new Promise(() => undefined);
    }
    throw new Error("No more fake Codex events available");
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeNeverSettles) {
      return new Promise(() => undefined);
    }
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
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() },
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

      const adapter = new CodexAdapter({ config: { cwd: tmpRoot() }, factory: async () => fakeClient });
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
      const adapter = new CodexAdapter({ config: { cwd: tmpRoot() }, factory: async () => new FakeCodexClient() });
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

  describeTurnOutcomeContract([{
    adapter: "CodexAdapter",
    turn: async (script, tools) => {
      const client = new FakeCodexClient({ events: scriptedTurnEvents(script) });
      await new CodexAdapter({ config: { cwd: tmpRoot() }, factory: async () => client }).onEvent(turnInput(tools));
    },
  }]);

  it("settles a local command's turn without counting its notice as the reply", async () => {
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() }, factory: async () => new FakeCodexClient() });
    // The tracking `onEvent` wraps a turn's tools in, so the turn can be read after.
    const tools = trackTurn(new FakeTools());

    await adapter.onMessage(makeMessage("/help"), tools, new HistoryProvider([]), null, null, {
      isSessionBootstrap: false,
      roomId: "room-1",
    });

    expect(tools.messages).toEqual([expect.stringContaining("Codex commands")]);
    expect(tools.turn.verdict()).toBe("complete");
    // A notice counted as the reply would suppress the relay of a model's real answer.
    expect(tools.turn.replied).toBe(false);
  });

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

    const root = tmpRoot();
    const adapter = new CodexAdapter({
      config: {
        model: "gpt-5.3-codex",
        cwd: root,
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
      cwd: roomWorkspacePath(root, "room-1"),
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

    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() },
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

    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() },
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
      config: { cwd: tmpRoot(),
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
      config: { cwd: tmpRoot(),
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
    expect(developerInstructions).toContain(BASE_INSTRUCTIONS.trim());
  });

  it("handles local slash commands without starting a turn", async () => {
    const fakeClient = new FakeCodexClient();
    const adapter = new CodexAdapter({
      config: { cwd: tmpRoot(),
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
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() },
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
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() }, factory: async () => fakeClient });
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

  it("evicts a client whose thread/start rejected with a transport-level error, so the next turn gets a fresh one instead of retrying a dead client forever", async () => {
    const tools = new ToolSchemaFakeTools();
    let factoryCalls = 0;
    const clients: FakeCodexClient[] = [];
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() },
      factory: async () => {
        factoryCalls += 1;
        const client = new FakeCodexClient({
          events: factoryCalls === 1
            ? []
            : [{
              kind: "notification",
              method: "turn/completed",
              params: { turn: { id: "turn-1", status: "completed", error: null } },
            }],
          requestHandler: (method, params) => {
            if (method === "thread/start" && factoryCalls === 1) {
              throw new Error("app-server transport closed");
            }
            return defaultRequestHandler(method, params);
          },
        });
        clients.push(client);
        return client;
      },
    });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-transport-fail" },
    ));
    expect(factoryCalls).toBe(1);

    await adapter.onMessage(
      makeMessage("hello again"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-transport-fail" },
    );

    expect(factoryCalls).toBe(2);
    expect(clients[1].requestCalls.some((call) => call.method === "turn/start")).toBe(true);
  });

  it("starts a new thread after turn/start evicts the client that owned the old thread", async () => {
    const tools = new ToolSchemaFakeTools();
    let factoryCalls = 0;
    const clients: FakeCodexClient[] = [];
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() },
      factory: async () => {
        factoryCalls += 1;
        const clientNumber = factoryCalls;
        const client = new FakeCodexClient({
          events: clientNumber === 2
            ? [{
              kind: "notification",
              method: "turn/completed",
              params: { turn: { id: "turn-1", status: "completed", error: null } },
            }]
            : [],
          requestHandler: (method, params) => {
            if (method === "thread/start") {
              return { thread: { id: `thread-${clientNumber}` }, model: "gpt-5.3-codex", params };
            }
            if (method === "turn/start" && clientNumber === 1) {
              throw new Error("app-server transport closed");
            }
            return defaultRequestHandler(method, params);
          },
        });
        clients.push(client);
        return client;
      },
    });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-turn-transport-fail" },
    ));

    await adapter.onMessage(
      makeMessage("hello again"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-turn-transport-fail" },
    );

    expect(factoryCalls).toBe(2);
    expect(clients[1].requestCalls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(clients[1].requestCalls.find((call) => call.method === "turn/start")?.params).toMatchObject({
      threadId: "thread-2",
    });
  });

  describe("per-room clients", () => {
    function answeringClient(text: string): FakeCodexClient {
      return new FakeCodexClient({
        events: [
          { kind: "notification", method: "item/completed", params: { item: { type: "agentMessage", id: "msg-1", text } } },
          { kind: "notification", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", error: null } } },
        ],
      });
    }

    function turnIn(adapter: CodexAdapter, roomId: string, tools = new ToolSchemaFakeTools()): Promise<void> {
      return adapter.onMessage(makeMessage(`hello from ${roomId}`, roomId), tools, new HistoryProvider([]), null, null, {
        isSessionBootstrap: true,
        roomId,
      });
    }

    it("starts no Codex client until a room's first message", async () => {
      const factory = vi.fn(async () => answeringClient("hi"));
      const adapter = new CodexAdapter({ config: { cwd: tmpRoot() }, factory });

      await adapter.onStarted("Codex Agent", "Codex parity adapter");

      expect(factory).not.toHaveBeenCalled();
    });

    it("gives each room its own client, started and threaded in that room's workspace", async () => {
      const root = tmpRoot();
      const clients = new Map<string, FakeCodexClient>();
      const factory = vi.fn(async ({ roomId }: { roomId: string; cwd: string }) => {
        const client = answeringClient(`answer for ${roomId}`);
        clients.set(roomId, client);
        return client;
      });
      const adapter = new CodexAdapter({ config: { cwd: root }, factory });

      await adapter.onStarted("Codex Agent", "Codex parity adapter");
      await turnIn(adapter, "room-a");
      await turnIn(adapter, "room-b");

      expect(factory.mock.calls.map(([context]) => context)).toEqual([
        { roomId: "room-a", cwd: roomWorkspacePath(root, "room-a") },
        { roomId: "room-b", cwd: roomWorkspacePath(root, "room-b") },
      ]);
      for (const roomId of ["room-a", "room-b"]) {
        const threadStart = clients.get(roomId)?.requestCalls.find((call) => call.method === "thread/start");
        expect(threadStart?.params.cwd).toBe(roomWorkspacePath(root, roomId));
      }
    });

    it("starts each room's client in the folder workspaceForRoom names", async () => {
      const root = tmpRoot();
      const factory = vi.fn(async () => answeringClient("hi"));
      const adapter = new CodexAdapter({
        config: { workspaceForRoom: (roomId) => path.join(root, "custom", roomId) },
        factory,
      });

      await adapter.onStarted("Codex Agent", "Codex parity adapter");
      await turnIn(adapter, "room-a");

      expect(factory).toHaveBeenCalledWith({ roomId: "room-a", cwd: path.join(realpathSync(root), "custom", "room-a") });
    });

    it("rejects cwd together with workspaceForRoom when built", () => {
      expect(() => new CodexAdapter({ config: { cwd: tmpRoot(), workspaceForRoom: () => tmpRoot() } }))
        .toThrow("either cwd or workspaceForRoom");
    });

    it("keeps each concurrent room's events to that room", async () => {
      const adapter = new CodexAdapter({
        config: { cwd: tmpRoot() },
        factory: async ({ roomId }) => answeringClient(`answer for ${roomId}`),
      });
      const toolsA = new ToolSchemaFakeTools();
      const toolsB = new ToolSchemaFakeTools();

      await adapter.onStarted("Codex Agent", "Codex parity adapter");
      await Promise.all([turnIn(adapter, "room-a", toolsA), turnIn(adapter, "room-b", toolsB)]);

      expect(toolsA.messages).toEqual(["answer for room-a"]);
      expect(toolsB.messages).toEqual(["answer for room-b"]);
    });

    it("closes only the leaving room's client", async () => {
      const clients = new Map<string, FakeCodexClient>();
      const adapter = new CodexAdapter({
        config: { cwd: tmpRoot() },
        factory: async ({ roomId }) => {
          const client = answeringClient("hi");
          clients.set(roomId, client);
          return client;
        },
      });

      await adapter.onStarted("Codex Agent", "Codex parity adapter");
      await turnIn(adapter, "room-a");
      await turnIn(adapter, "room-b");
      await adapter.onCleanup("room-a");
      await vi.waitFor(() => expect(clients.get("room-a")?.closeCalls).toBe(1));

      expect(clients.get("room-b")?.closeCalls).toBe(0);
      await adapter.stop();
      expect(clients.get("room-b")?.closeCalls).toBe(1);
    });

    it("closes a client that finishes starting after its room left", async () => {
      let finishInitialize!: () => void;
      const initializing = new Promise<void>((resolve) => { finishInitialize = resolve; });
      const client = new FakeCodexClient({
        events: [
          { kind: "notification", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", error: null } } },
        ],
        requestHandler: async (method, params) => {
          if (method === "initialize") {
            await initializing;
          }
          return defaultRequestHandler(method, params);
        },
      });
      const adapter = new CodexAdapter({ config: { cwd: tmpRoot() }, factory: async () => client });

      await adapter.onStarted("Codex Agent", "Codex parity adapter");
      const turn = turnIn(adapter, "room-a");
      await vi.waitFor(() => expect(client.requestCalls.map((call) => call.method)).toContain("initialize"));
      await adapter.onCleanup("room-a");
      finishInitialize();

      await expectTurnFailed(turn);
      await adapter.stop();
      expect(client.closeCalls).toBe(1);
    });

    it("keeps another room's client when one room's transport fails", async () => {
      const failing = new FakeCodexClient({
        requestHandler: (method, params) => {
          if (method === "turn/start") {
            throw new Error("app-server transport closed");
          }
          return defaultRequestHandler(method, params);
        },
      });
      const healthy = answeringClient("still here");
      const adapter = new CodexAdapter({
        config: { cwd: tmpRoot() },
        factory: async ({ roomId }) => roomId === "room-a" ? failing : healthy,
      });
      const toolsB = new ToolSchemaFakeTools();

      await adapter.onStarted("Codex Agent", "Codex parity adapter");
      await expectTurnFailed(turnIn(adapter, "room-a"));
      await turnIn(adapter, "room-b", toolsB);

      expect(failing.closeCalls).toBe(1);
      expect(healthy.closeCalls).toBe(0);
      expect(toolsB.messages).toEqual(["still here"]);
    });
  });

  it("keeps a client whose thread/start rejected with an ordinary Codex JSON-RPC error, since the transport itself is still healthy", async () => {
    const tools = new ToolSchemaFakeTools();
    let factoryCalls = 0;
    let failNext = true;
    const fakeClient = new FakeCodexClient({
      events: [{
        kind: "notification",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed", error: null } },
      }],
      requestHandler: (method, params) => {
        if (method === "thread/start" && failNext) {
          failNext = false;
          throw new CodexJsonRpcError(-32001, "invalid thread/start params");
        }
        return defaultRequestHandler(method, params);
      },
    });
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() },
      factory: async () => {
        factoryCalls += 1;
        return fakeClient;
      },
    });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-json-rpc-error" },
    ));
    expect(factoryCalls).toBe(1);

    await adapter.onMessage(
      makeMessage("hello again"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-json-rpc-error" },
    );

    expect(factoryCalls).toBe(1);
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
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() }, factory: async () => fakeClient });
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
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() }, factory: async () => fakeClient });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-retry-error" },
    );

    expect(findFailureEvent(tools)).toBeUndefined();
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
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() }, factory: async () => fakeClient });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-double-report" },
    ));

    const failures = failureEvents(tools);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.metadata?.failure).toMatchObject({
      provider: "codex",
      code: "invalid_request",
      message: "bad turn input",
    });
  });

  it("reports a mid-turn error notification only once, even when the turn is then interrupted", async () => {
    vi.useFakeTimers();
    try {
      const tools = new ToolSchemaFakeTools();
      const fakeClient = new FakeCodexClient({
        hangWhenEmpty: true,
        events: [
          {
            kind: "notification",
            method: "error",
            params: {
              error: { code: "invalid_request", message: "bad turn input" },
            },
          },
        ],
      });
      const adapter = new CodexAdapter({ factory: async () => fakeClient, config: { cwd: tmpRoot(), turnTimeoutMs: 1_000 } });
      await adapter.onStarted("Codex Agent", "Codex parity adapter");

      const turn = adapter.onMessage(
        makeMessage("hello"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-double-report-interrupted" },
      );
      turn.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      await expectTurnFailed(turn);

      const failures = failureEvents(tools);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.metadata?.failure).toMatchObject({
        provider: "codex",
        code: "invalid_request",
        message: "bad turn input",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a structured sendFailure with code 'timeout' and fails the turn when interrupted (e.g. a recvEvent timeout)", async () => {
    vi.useFakeTimers();
    try {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({ hangWhenEmpty: true });
    const adapter = new CodexAdapter({ factory: async () => fakeClient, config: { cwd: tmpRoot(), turnTimeoutMs: 1_000 } });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    const turn = adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-interrupt" },
    );
    turn.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    await expectTurnFailed(turn);

    const failureEvent = findFailureEvent(tools);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "codex",
      code: "timeout",
      message: "Turn timed out",
    });
    // Posted alongside the structured event, not replaced by it: this is the
    // one reply that has always notified the requester their turn failed, and
    // mentions ride on messages only. The friendly sentence stays the visible
    // text while the raw provider message goes in the event.
    expect(tools.messages).toEqual(["I stopped before completing this request."]);
    expect(fakeClient.requestCalls.some((call) => call.method === "turn/interrupt")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the shared client on turn timeout so a replacement turn started before the abandoned turn completes cannot lose its events to a stale drain", async () => {
    class QueueingFakeCodexClient implements CodexClientLike {
      public readonly requestCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
      public closeCalls = 0;
      private readonly queue: CodexRpcEvent[] = [];
      private waiter: { resolve: (event: CodexRpcEvent) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null } | null = null;
      private turnCount = 0;
      private closed = false;

      public async connect(): Promise<void> {}
      public async initialize(params: InitializeParams): Promise<void> {
        await this.request("initialize", params as unknown as Record<string, unknown>);
      }

      public async request<TResult>(method: string, params?: Record<string, unknown>): Promise<TResult> {
        const safeParams = params ?? {};
        this.requestCalls.push({ method, params: safeParams });
        if (method === "turn/start") {
          this.turnCount += 1;
          return { turn: { id: `turn-${this.turnCount}`, status: "inProgress", error: null } } as TResult;
        }
        if (method === "thread/start") {
          return { thread: { id: "thread-1" }, model: "gpt-5.3-codex" } as TResult;
        }
        return {} as TResult;
      }

      public async notify(): Promise<void> {}
      public async respond(): Promise<void> {}
      public async respondError(): Promise<void> {}
      public async close(): Promise<void> {
        this.closed = true;
        this.closeCalls += 1;
        this.queue.length = 0;
        if (this.waiter) {
          const waiter = this.waiter;
          this.waiter = null;
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.reject(new Error("Codex client closed"));
        }
      }

      public push(event: CodexRpcEvent): void {
        if (this.closed) {
          return;
        }
        if (this.waiter) {
          const waiter = this.waiter;
          this.waiter = null;
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.resolve(event);
          return;
        }
        this.queue.push(event);
      }

      public async recvEvent(timeoutMs?: number): Promise<CodexRpcEvent> {
        if (this.closed) {
          throw new Error("Codex client closed");
        }
        if (this.queue.length > 0) {
          return this.queue.shift() as CodexRpcEvent;
        }
        return await new Promise<CodexRpcEvent>((resolve, reject) => {
          const timer = timeoutMs === undefined ? null : setTimeout(() => {
            this.waiter = null;
            reject(new Error("Timed out waiting for Codex app-server event"));
          }, timeoutMs);
          this.waiter = { resolve, reject, timer };
        });
      }
    }

    vi.useFakeTimers();
    try {
      const tools = new ToolSchemaFakeTools();
      const abandonedClient = new QueueingFakeCodexClient();
      const replacementClient = new QueueingFakeCodexClient();
      let factoryCalls = 0;
      const adapter = new CodexAdapter({
        factory: async () => {
          factoryCalls += 1;
          return factoryCalls === 1 ? abandonedClient : replacementClient;
        },
        config: { cwd: tmpRoot(), turnTimeoutMs: 1_000 },
      });
      await adapter.onStarted("Codex Agent", "Codex parity adapter");

      const turn1 = adapter.onMessage(
        makeMessage("hello"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-drain-race" },
      );
      turn1.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      await expectTurnFailed(turn1);

      const nextTools = new ToolSchemaFakeTools();
      const turn2 = adapter.onMessage(
        makeMessage("follow up"),
        nextTools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-drain-race" },
      );
      await vi.advanceTimersByTimeAsync(0);

      abandonedClient.push({
        kind: "notification",
        method: "item/agentMessage/delta",
        params: { delta: "STRAY-FROM-TURN-1 " },
      });
      abandonedClient.push({
        kind: "notification",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "interrupted", error: null } },
      });

      await Promise.resolve();
      await Promise.resolve();

      replacementClient.push({
        kind: "notification",
        method: "item/agentMessage/delta",
        params: { delta: "real-turn-2-answer" },
      });
      replacementClient.push({
        kind: "notification",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed", error: null } },
      });
      await turn2;

      expect(nextTools.messages).toEqual(["real-turn-2-answer"]);
      expect(factoryCalls).toBe(2);
      expect(abandonedClient.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a recvEvent transport rejection as a transport failure, not a timeout", async () => {
    let rejectRecv!: (error: Error) => void;
    const recvStarted = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((inner) => {
        resolve = inner;
      });
      return { promise, resolve };
    })();
    class TransportDeathClient extends FakeCodexClient {
      public override async recvEvent(): Promise<CodexRpcEvent> {
        recvStarted.resolve();
        return await new Promise<CodexRpcEvent>((_, reject) => {
          rejectRecv = reject;
        });
      }
    }
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new TransportDeathClient();
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() }, factory: async () => fakeClient });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    const turn = adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-recv-transport-death" },
    );
    turn.catch(() => undefined);
    await recvStarted.promise;
    rejectRecv(new Error("Codex app-server closed with code 1."));
    await expectTurnFailed(turn);

    const failureEvent = findFailureEvent(tools);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "codex",
      message: expect.stringContaining("Codex app-server closed with code 1."),
    });
    expect((failureEvent?.metadata?.failure as { code?: unknown } | undefined)?.code).not.toBe("timeout");
    expect(fakeClient.closeCalls).toBe(1);
  });

  it("reports a turn timeout without waiting on a close() that never settles, and the next turn gets a new client", async () => {
    vi.useFakeTimers();
    try {
      const tools = new ToolSchemaFakeTools();
      const abandonedClient = new FakeCodexClient({ hangWhenEmpty: true });
      abandonedClient.closeNeverSettles = true;
      const replacementClient = new FakeCodexClient({
        events: [
          {
            kind: "notification",
            method: "item/agentMessage/delta",
            params: { delta: "fresh-client-answer" },
          },
          {
            kind: "notification",
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "completed", error: null } },
          },
        ],
      });
      let factoryCalls = 0;
      const adapter = new CodexAdapter({
        factory: async () => {
          factoryCalls += 1;
          return factoryCalls === 1 ? abandonedClient : replacementClient;
        },
        config: { cwd: tmpRoot(), turnTimeoutMs: 1_000 },
      });
      await adapter.onStarted("Codex Agent", "Codex parity adapter");

      const turn1 = adapter.onMessage(
        makeMessage("hello"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-hanging-close" },
      );
      turn1.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      await expectTurnFailed(turn1);
      expect(abandonedClient.closeCalls).toBe(1);

      const nextTools = new ToolSchemaFakeTools();
      await adapter.onMessage(
        makeMessage("follow up"),
        nextTools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-hanging-close" },
      );
      expect(nextTools.messages).toEqual(["fresh-client-answer"]);
      expect(factoryCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a structured sendFailure with the codex-declared turnStatus when the transport closes mid-turn", async () => {
    const tools = new ToolSchemaFakeTools();
    const fakeClient = new FakeCodexClient({
      events: [
        { kind: "notification", method: "transport/closed", params: {} },
      ],
    });
    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() }, factory: async () => fakeClient });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");

    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-transport-closed" },
    ));

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

    const adapter = new CodexAdapter({ config: { cwd: tmpRoot() },
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
      config: { cwd: tmpRoot(),
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
    const fakeClient = new FakeCodexClient({
      events: [{ kind: "notification", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", error: null } } }],
    });
    const adapter = new CodexAdapter({
      config: {
        model: "gpt-5.3-codex",
        cwd: tmpRoot(),
      },
      factory: async () => fakeClient,
    });

    await adapter.onStarted("Codex Agent", "Codex parity adapter");
    await adapter.onMessage(makeMessage("hi"), new ToolSchemaFakeTools(), new HistoryProvider([]), null, null, { isSessionBootstrap: true, roomId: "room-1" });

    const initializeCall = fakeClient.requestCalls.find((call) => call.method === "initialize");
    expect(initializeCall).toBeDefined();
    const clientInfo = initializeCall?.params.clientInfo as { name: string; title: string };
    expect(clientInfo.name).toBe("band_codex_adapter");
    expect(clientInfo.title).toBe("Band Codex Adapter");
  });

  it("lets the caller override clientInfo name and title via config", async () => {
    const fakeClient = new FakeCodexClient({
      events: [{ kind: "notification", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", error: null } } }],
    });
    const adapter = new CodexAdapter({
      config: {
        model: "gpt-5.3-codex",
        cwd: tmpRoot(),
        clientName: "custom_codex_adapter",
        clientTitle: "Custom Codex Adapter",
      },
      factory: async () => fakeClient,
    });

    await adapter.onStarted("Codex Agent", "Codex parity adapter");
    await adapter.onMessage(makeMessage("hi"), new ToolSchemaFakeTools(), new HistoryProvider([]), null, null, { isSessionBootstrap: true, roomId: "room-1" });

    const initializeCall = fakeClient.requestCalls.find((call) => call.method === "initialize");
    expect(initializeCall).toBeDefined();
    const clientInfo = initializeCall?.params.clientInfo as { name: string; title: string };
    expect(clientInfo.name).toBe("custom_codex_adapter");
    expect(clientInfo.title).toBe("Custom Codex Adapter");
  });

  it("appends memory guidance to a raw systemPrompt when memory tools are enabled", async () => {
    const rawPrompt = "Coordinate room work and use tools.";
    const fakeClient = new FakeCodexClient({
      events: [
        {
          kind: "notification",
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed", error: null } },
        },
      ],
    });
    const adapter = new CodexAdapter({
      includeMemoryTools: true,
      config: {
        model: "gpt-5.3-codex",
        cwd: tmpRoot(),
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        systemPrompt: rawPrompt,
      },
      factory: async () => fakeClient,
    });
    await adapter.onStarted("Codex Agent", "Codex parity adapter");
    await adapter.onMessage(
      makeMessage("remember this"),
      new FakeTools(),
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-memory-guidance" },
    );

    const instructions = fakeClient.requestCalls.find((call) => call.method === "thread/start")?.params.developerInstructions;
    expect(instructions).toContain(rawPrompt);
    expect(instructions).toContain("## Memory Tools");
  });
});

/** The app-server events of one contract turn: the model's tool calls and closing message, then completion. */
function scriptedTurnEvents(script: TurnScript): CodexRpcEvent[] {
  const call = (tool: string, arguments_: Record<string, unknown>): CodexRpcEvent => ({
    kind: "request",
    id: 1,
    method: "item/tool/call",
    params: { threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool, arguments: arguments_ },
  });
  const say = (text: string): CodexRpcEvent => ({
    kind: "notification",
    method: "item/completed",
    params: { item: { type: "agentMessage", id: "msg-1", text } },
  });
  const steps: Record<TurnScript, CodexRpcEvent[]> = {
    decline: [call(NO_REPLY_TOOL_NAME, { reason: "FYI only" }), say(CLOSING_TEXT)],
    toolReply: [call(SEND_MESSAGE_TOOL_NAME, { content: TOOL_REPLY, mentions: ["@user"] }), say(CLOSING_TEXT)],
    act: [call("band_add_participant", { name: "Helper" })],
    finalText: [say(CLOSING_TEXT)],
    nothing: [],
  };
  return [
    ...steps[script],
    { kind: "notification", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", error: null } } },
  ];
}
