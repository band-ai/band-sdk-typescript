import { describe, expect, it, vi } from "vitest";

import {
  ClaudeSDKAdapter,
  type ClaudeSDKQuery,
} from "../src/adapters/claude-sdk/ClaudeSDKAdapter";
import { HistoryProvider } from "../src/runtime/types";
import { DeliveryFailedError } from "../src/core/deliveryFailedError";
import { FakeTools, findFailureEvent, makeMessage, expectTurnFailed } from "./testUtils";
import { describeDeliveryContract } from "./deliveryContract";
import { MCP_SERVER_NAME } from "../src/runtime/tools/schemas";

function streamFrom<T>(items: T[]): AsyncGenerator<T, void> {
  return (async function* generator(): AsyncGenerator<T, void> {
    for (const item of items) {
      yield item;
    }
  })();
}

describe("ClaudeSDKAdapter", () => {
  it("uses the stable query API and resumes by session id", async () => {
    const calls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
    let turn = 0;

    const queryFn: ClaudeSDKQuery = ({ prompt, options }) => {
      calls.push({ prompt, options: options as Record<string, unknown> });
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

  it("rehydrates session id from bootstrap task metadata", async () => {
    const calls: Array<{ options?: Record<string, unknown> }> = [];
    const queryFn: ClaudeSDKQuery = ({ options }) => {
      calls.push({ options: options as Record<string, unknown> });
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
    expect(tools.events.some((event) => event.messageType === "task")).toBe(true);
  });

  it("rehydrates legacy Claude session markers from bootstrap task metadata", async () => {
    const calls: Array<{ options?: Record<string, unknown> }> = [];
    const queryFn: ClaudeSDKQuery = ({ options }) => {
      calls.push({ options: options as Record<string, unknown> });
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
          result: "hit the turn cap",
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
          summary: "tool crashed",
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
          summary: "tool crashed",
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
