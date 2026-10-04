import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  ClaudeSDKAdapter,
  type ClaudeSDKAdapterOptions,
  type ClaudeSDKQueryParams,
  type ClaudeSDKQuery,
} from "../src/adapters/claude-sdk/ClaudeSDKAdapter";
import { HistoryProvider } from "../src/runtime/types";
import { DeliveryFailedError } from "../src/core/deliveryFailedError";
import { RestFacade } from "../src/client/rest/RestFacade";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { FakeRestApi, FakeTools, findFailureEvent, makeMessage, makeRoster, expectTurnFailed } from "./testUtils";
import { describeDeliveryContract } from "./deliveryContract";
import { MCP_SERVER_NAME, NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import type { AdapterToolsProtocol, FrameworkAdapterInput } from "../src/contracts/protocols";
import { createDeferred } from "../src/core/deferred";
import { CLOSING_TEXT, TOOL_REPLY, describeTurnOutcomeContract, turnInput, type TurnScript } from "./turnOutcomeContract";

function streamFrom<T>(items: T[]): AsyncGenerator<T, void> {
  return (async function* generator(): AsyncGenerator<T, void> {
    for (const item of items) {
      yield item;
    }
  })();
}

describe("ClaudeSDKAdapter", () => {
  it("uses the stable query API and resumes by session id", async () => {
    const calls: ClaudeSDKQueryParams[] = [];
    let turn = 0;

    const queryFn: ClaudeSDKQuery = ({ prompt, options }) => {
      calls.push({ prompt, options });
      turn += 1;

      if (turn === 1) {
        return streamFrom([
          {
            type: "assistant",
            session_id: "session-1",
            message: {
              content: [{ type: "text", text: "first response" }],
            },
          } as never,
          {
            type: "result",
            subtype: "success",
            result: "first response",
            session_id: "session-1",
          } as never,
        ]) as never;
      }

      return streamFrom([
        {
          type: "assistant",
          session_id: "session-1",
          message: {
            content: [{ type: "text", text: "second response" }],
          },
        } as never,
        {
          type: "result",
          subtype: "success",
          result: "second response",
          session_id: "session-1",
        } as never,
      ]) as never;
    };

    const adapter = new ClaudeSDKAdapter({
      queryFn,
      model: "claude-sonnet-4-6",
      permissionMode: "acceptEdits",
    });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    const bootstrapHistory = new HistoryProvider([
      {
        sender_name: "Alice",
        sender_type: "User",
        content: "historic context",
      },
    ]);

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      bootstrapHistory,
      "Participants changed",
      "Contacts updated",
      { isSessionBootstrap: true, roomId: "room-1" },
    );
    await adapter.onMessage(
      makeMessage("follow up"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    expect(tools.messages).toEqual(["first response", "second response"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options?.model).toBe("claude-sonnet-4-6");
    expect(calls[0]?.options?.permissionMode).toBe("acceptEdits");
    expect(calls[0]?.options?.systemPrompt).toBeTypeOf("string");
    expect(calls[0]?.options?.mcpServers).toBeTruthy();
    expect(Object.keys(calls[0]?.options?.mcpServers ?? {})).toEqual([MCP_SERVER_NAME]);
    expect(Array.isArray(calls[0]?.options?.allowedTools)).toBe(true);
    expect(calls[0]?.prompt).toContain("[Previous conversation context]");
    expect(calls[0]?.prompt).toContain("[System]: Participants changed");
    expect(calls[0]?.prompt).toContain("[System]: Contacts updated");
    expect(calls[0]?.prompt).toContain("room_id=\"room-1\"");
    expect(calls[1]?.options?.resume).toBe("session-1");
  });

  describe("isolation from the host's Claude Code", () => {
    /** The options the adapter's first query was started with. */
    async function firstQueryOptions(options: ClaudeSDKAdapterOptions = {}): Promise<ClaudeSDKQueryParams["options"]> {
      let captured: ClaudeSDKQueryParams["options"];
      const queryFn: ClaudeSDKQuery = ({ options: queryOptions }) => {
        captured = queryOptions;
        return streamFrom([]);
      };
      const adapter = new ClaudeSDKAdapter({ ...options, queryFn });
      await adapter.onStarted("Isolated Agent", "Isolation test agent");
      await adapter.onMessage(makeMessage("hello"), new FakeTools(), new HistoryProvider([]), null, null, {
        isSessionBootstrap: false,
        roomId: "room-1",
      });
      return captured;
    }

    it("loads no host settings, denies cross-session tools and tool search, refuses inbound peers, and disables claude.ai connectors by default", async () => {
      const options = await firstQueryOptions();

      expect(options?.settingSources).toEqual([]);
      // Spelled out, not the adapter's constants: the contract must fail if a constant loses an entry.
      expect(options?.disallowedTools).toEqual(["ListAgents", "SendMessage", "SendFile", "ToolSearch"]);
      expect(options?.settings).toMatchObject({ crossSessionInbound: "refuse", disableClaudeAiConnectors: true });
    });

    it("forwards the caller's settingSources unchanged", async () => {
      const options = await firstQueryOptions({ settingSources: ["user"] });

      expect(options?.settingSources).toEqual(["user"]);
    });
  });

  it("reports tool summary events when execution reporting is enabled", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "tool_use_summary",
          summary: "Used band_send_message",
          preceding_tool_use_ids: ["tool-1"],
          session_id: "session-2",
        } as never,
        {
          type: "assistant",
          session_id: "session-2",
          message: {
            content: [{ type: "text", text: "done" }],
          },
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({
      queryFn,
      enableExecutionReporting: true,
    });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("run a tool"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-2" },
    );

    expect(tools.messages).toEqual(["done"]);
    const toolCallEvents = tools.events.filter((event) => event.messageType === "tool_call");
    expect(toolCallEvents).toHaveLength(1);
    const payload = JSON.parse(toolCallEvents[0]?.content ?? "{}");
    expect(payload.type).toBe("tool_use_summary");
    expect(payload.summary).toBe("Used band_send_message");
  });

  it("rehydrates session id from bootstrap task metadata without prompting it", async () => {
    const calls: ClaudeSDKQueryParams[] = [];
    const queryFn: ClaudeSDKQuery = ({ prompt, options }) => {
      calls.push({ prompt, options });
      return streamFrom([
        {
          type: "assistant",
          session_id: "session-from-history",
          message: {
            content: [{ type: "text", text: "ok" }],
          },
        } as never,
      ]) as never;
    };

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([
        {
          message_type: "task",
          content: "Claude SDK session",
          metadata: {
            claude_sdk_session_id: "session-from-history",
          },
        },
      ]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-9" },
    );

    expect(calls[0]?.options?.resume).toBe("session-from-history");
    expect(calls[0]?.prompt).not.toContain("[Previous conversation context]");
    expect(calls[0]?.prompt).not.toContain("Claude SDK session");
    expect(calls[0]?.prompt).not.toContain("session-from-history");
    expect(tools.events.some((event) => event.messageType === "task")).toBe(true);
  });

  it("prompts only text history on bootstrap and keeps session resume off the prompt", async () => {
    const calls: ClaudeSDKQueryParams[] = [];
    const queryFn: ClaudeSDKQuery = ({ prompt, options }) => {
      calls.push({ prompt, options });
      return streamFrom([
        {
          type: "assistant",
          session_id: "session-from-history",
          message: {
            content: [{ type: "text", text: "ok" }],
          },
        } as never,
      ]) as never;
    };

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    await adapter.onMessage(
      makeMessage("hello"),
      new FakeTools(),
      new HistoryProvider([
        { sender_name: "Alice", message_type: "text", content: "typed text" },
        { sender_name: "Bob", content: "legacy text" },
        {
          message_type: "task",
          content: "Claude SDK session",
          metadata: { claude_sdk_session_id: "session-from-history" },
        },
        { message_type: "tool_call", content: JSON.stringify({ type: "tool_use_summary" }) },
        { message_type: "tool_result", content: "tool output" },
        { message_type: "thought", content: "internal reasoning" },
        { message_type: "error", content: "provider error" },
        { message_type: "unknown", content: "unrecognized content" },
        { sender_name: "Carol", message_type: "text", content: "after non-text" },
      ]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-mixed" },
    );

    const prompt = calls[0]?.prompt ?? "";
    expect(calls[0]?.options?.resume).toBe("session-from-history");
    expect(prompt).toContain("[Previous conversation context]");
    expect(prompt).toContain("[Alice]: typed text");
    expect(prompt).toContain("[Bob]: legacy text");
    expect(prompt).toContain("[Carol]: after non-text");
    expect(prompt).not.toContain("Claude SDK session");
    expect(prompt).not.toContain("session-from-history");
    expect(prompt).not.toContain("tool_use_summary");
    expect(prompt).not.toContain("tool output");
    expect(prompt).not.toContain("internal reasoning");
    expect(prompt).not.toContain("provider error");
    expect(prompt).not.toContain("unrecognized content");
  });

  it("rehydrates legacy Claude session markers from bootstrap task metadata", async () => {
    const calls: Array<Pick<ClaudeSDKQueryParams, "options">> = [];
    const queryFn: ClaudeSDKQuery = ({ options }) => {
      calls.push({ options });
      return streamFrom([
        {
          type: "assistant",
          session_id: "session-from-history",
          message: {
            content: [{ type: "text", text: "ok" }],
          },
        } as never,
      ]) as never;
    };

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    await adapter.onMessage(
      makeMessage("hello"),
      new FakeTools(),
      new HistoryProvider([
        {
          message_type: "task",
          metadata: {
            claude_session_id: "legacy-session-from-history",
          },
        },
      ]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-legacy" },
    );

    expect(calls[0]?.options?.resume).toBe("legacy-session-from-history");
  });

  it("logs session marker failures and continues responding", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "assistant",
          session_id: "session-logger",
          message: {
            content: [{ type: "text", text: "still answered" }],
          },
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({
      queryFn,
      enableMcpTools: false,
      logger,
    });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools({ failOn: ["sendEvent"] });
    await adapter.onMessage(
      makeMessage("hello", "room-log"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-log" },
    );

    expect(tools.messages).toEqual(["still answered"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Claude SDK session marker event failed",
      expect.objectContaining({
        roomId: "room-log",
        sessionId: "session-logger",
      }),
    );
  });

  it("surfaces a query-loop failure as a structured sendFailure event", async () => {
    const queryFn: ClaudeSDKQuery = () => {
      throw new Error("claude query blew up");
    };

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello", "room-fail"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-fail" },
    ));

    expect(tools.messages).toEqual([]);
    const failureEvent = findFailureEvent(tools);
    expect(failureEvent?.content).toBe("claude query blew up");
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "claude-sdk",
      message: "claude query blew up",
      code: null,
      detail: null,
    });
  });


  it("reports a non-success result event as a terminal provider failure without prior assistant text", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "result",
          subtype: "error_max_turns",
          errors: ["hit the turn cap"],
          session_id: "session-fail",
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello", "room-result-fail"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-result-fail" },
    ));

    expect(tools.messages).toEqual([]);
    const failureEvent = findFailureEvent(tools);
    expect(tools.events.filter((event) => event.messageType === "error")).toHaveLength(1);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "claude-sdk",
      code: "error_max_turns",
      message: "hit the turn cap",
    });
  });

  it("keeps preceding assistant text once, then fails the turn on a non-success result", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "assistant",
          session_id: "session-partial",
          message: {
            content: [{ type: "text", text: "almost done" }],
          },
        } as never,
        {
          type: "result",
          subtype: "error_during_execution",
          errors: ["tool crashed"],
          session_id: "session-partial",
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello", "room-result-partial"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-result-partial" },
    ));

    expect(tools.messages).toEqual(["almost done"]);
    const failureEvent = findFailureEvent(tools);
    expect(tools.events.filter((event) => event.messageType === "error")).toHaveLength(1);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "claude-sdk",
      code: "error_during_execution",
      message: "tool crashed",
    });
  });

  it("reports the Claude result failure even when partial-text delivery is rejected", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "assistant",
          session_id: "session-partial-delivery",
          message: {
            content: [{ type: "text", text: "almost done" }],
          },
        } as never,
        {
          type: "result",
          subtype: "error_during_execution",
          errors: ["tool crashed"],
          session_id: "session-partial-delivery",
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools({ failOn: ["sendMessage"] });
    await expect(adapter.onMessage(
      makeMessage("hello", "room-result-partial-delivery"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-result-partial-delivery" },
    )).rejects.toBeInstanceOf(DeliveryFailedError);
    expect(tools.messages).toEqual([]);
    expect(tools.events.filter((event) => event.messageType === "error")).toHaveLength(1);
    expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
      provider: "claude-sdk",
      code: "error_during_execution",
      message: "tool crashed",
    });
  });

  it("treats success+is_error as a terminal Claude failure and does not deliver the result", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in",
          session_id: "session-is-error",
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello", "room-is-error"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-is-error" },
    ));

    expect(tools.messages).toEqual([]);
    expect(tools.events.filter((event) => event.messageType === "error")).toHaveLength(1);
    expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
      provider: "claude-sdk",
      code: "error",
      message: "Not logged in",
    });
  });

  it("still delivers a success result when is_error is false", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "all good",
          session_id: "session-is-error-false",
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("hello", "room-is-error-false"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-is-error-false" },
    );

    expect(tools.messages).toEqual(["all good"]);
    expect(tools.events.filter((event) => event.messageType === "error")).toEqual([]);
  });

  describe("a turn's Band tool calls through the MCP bridge", () => {
    const ROOM_ID = "room-send";
    const SENDER = makeMessage("hello", ROOM_ID);

    /** Real Band tools over a fake REST API, recording every message that reaches the room. */
    function recordingRoomTools(): { tools: AgentTools; posted: string[] } {
      const posted: string[] = [];
      const api = new FakeRestApi({
        createChatMessage: async (_roomId, message) => {
          posted.push(message.content);
          return {};
        },
      });
      const roster = makeRoster([{ id: SENDER.senderId, handle: "@user", name: "User", type: "User" }]);
      return { tools: new AgentTools({ roomId: ROOM_ID, rest: new RestFacade({ api }), roster }), posted };
    }

    function roomTurn(tools: AdapterToolsProtocol): FrameworkAdapterInput {
      return {
        message: SENDER,
        tools,
        history: new HistoryProvider([]),
        participantsMessage: null,
        contactsMessage: null,
        isSessionBootstrap: false,
        roomId: ROOM_ID,
      };
    }

    const connections = new Map<McpSdkServerConfigWithInstance["instance"], Promise<Client>>();

    /** Claude Code's one connection to an adapter's Band MCP server, opened on first use and closed with the test. */
    function connectionTo(server: McpSdkServerConfigWithInstance): Promise<Client> {
      const open = connections.get(server.instance) ?? (async () => {
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(serverTransport);
        const client = new Client({ name: "claude-code-stand-in", version: "1.0.0" });
        await client.connect(clientTransport);
        onTestFinished(async () => {
          connections.delete(server.instance);
          await client.close();
        });
        return client;
      })();
      connections.set(server.instance, open);
      return open;
    }

    /** Calls a Band tool on the MCP server the adapter started the query with, as Claude Code would. */
    async function callBandTool(options: ClaudeSDKQueryParams["options"], name: string, args: Record<string, unknown> = {}): Promise<void> {
      const client = await connectionTo(options?.mcpServers?.[MCP_SERVER_NAME] as McpSdkServerConfigWithInstance);
      const result = await client.callTool({ name, arguments: { room_id: ROOM_ID, ...args } });
      expect(result.isError, `${name} failed`).toBeUndefined();
    }

    const assistantText = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
    const success = (text: string) => ({ type: "result", subtype: "success", result: text });
    const closing = (text: string) => [assistantText(text), success(text)] as never[];

    /** What Claude does in one contract turn, its tool calls landing through the MCP bridge. */
    async function* contractTurn(script: TurnScript, options: ClaudeSDKQueryParams["options"]): AsyncGenerator<never> {
      switch (script) {
        case "decline":
          await callBandTool(options, NO_REPLY_TOOL_NAME, { reason: "FYI only" });
          yield* closing(CLOSING_TEXT);
          return;
        case "toolReply":
          await callBandTool(options, SEND_MESSAGE_TOOL_NAME, { content: TOOL_REPLY, mentions: ["@user"] });
          yield* closing(CLOSING_TEXT);
          return;
        case "act":
          await callBandTool(options, "band_add_participant", { name: "Helper" });
          yield success("") as never;
          return;
        case "finalText":
          yield* closing(CLOSING_TEXT);
          return;
        case "nothing":
          yield success("") as never;
          return;
      }
    }

    describeTurnOutcomeContract([{
      adapter: "ClaudeSDKAdapter",
      turn: async (script, tools) => {
        const adapter = new ClaudeSDKAdapter({ queryFn: ({ options }) => contractTurn(script, options) });
        await adapter.onStarted("Parity Agent", "Parity test agent");
        await adapter.onEvent(turnInput(tools, SENDER));
      },
    }]);

    it("keeps preceding text off the room on a failed result after a tool reply, and still reports the failure", async () => {
      const { tools, posted } = recordingRoomTools();
      const adapter = new ClaudeSDKAdapter({
        queryFn: async function* ({ options }) {
          await callBandTool(options, SEND_MESSAGE_TOOL_NAME, { content: "pineapple", mentions: ["@user"] });
          yield* [assistantText("Done!"), { type: "result", subtype: "error_max_turns", summary: "hit the turn cap" }] as never[];
        },
      });
      await adapter.onStarted("Parity Agent", "Parity test agent");

      await expectTurnFailed(adapter.onEvent(roomTurn(tools)));

      expect(posted).toEqual(["pineapple"]);
    });

    it("records each of two concurrent same-room turns' replies on that turn", async () => {
      const firstStarted = createDeferred();
      const releaseFirst = createDeferred();
      let queries = 0;
      const adapter = new ClaudeSDKAdapter({
        // The first turn's reply is held until the second turn is queued, so it lands while both are in flight.
        queryFn: async function* ({ options }) {
          const isFirst = ++queries === 1;
          if (isFirst) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          await callBandTool(options, SEND_MESSAGE_TOOL_NAME, { content: isFirst ? "first reply" : "second reply", mentions: ["@user"] });
          yield* closing(CLOSING_TEXT);
        },
      });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      const first = recordingRoomTools();
      const second = recordingRoomTools();

      const firstTurn = adapter.onEvent(roomTurn(first.tools));
      await firstStarted.promise;
      const secondTurn = adapter.onEvent(roomTurn(second.tools));
      releaseFirst.resolve();
      await Promise.all([firstTurn, secondTurn]);

      expect(first.posted).toEqual(["first reply"]);
      expect(second.posted).toEqual(["second reply"]);
    });
  });

  describeDeliveryContract([{
    path: "final assistant text",
    turn: async (tools) => {
      const queryFn: ClaudeSDKQuery = () =>
        streamFrom([
          {
            type: "assistant",
            session_id: "session-delivery",
            message: {
              content: [{ type: "text", text: "final answer" }],
            },
          } as never,
        ]) as never;

      const adapter = new ClaudeSDKAdapter({ queryFn });
      await adapter.onStarted("Parity Agent", "Parity test agent");

      await adapter.onMessage(
        makeMessage("hello", "room-delivery"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-delivery" },
      );
    },
  }]);
});
