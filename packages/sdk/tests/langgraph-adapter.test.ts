import { describe, expect, it, vi } from "vitest";

import { LangGraphAdapter } from "../src/adapters/langgraph";
import { HistoryProvider } from "../src/runtime/types";
import { FakeTools, makeMessage } from "./testUtils";

const langGraphMocks = vi.hoisted(() => ({
  createReactAgent: vi.fn(),
  tool: vi.fn(),
}));

vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: langGraphMocks.createReactAgent,
}));

vi.mock("@langchain/core/tools", () => ({
  tool: langGraphMocks.tool,
}));

function streamFrom<T>(items: T[]): AsyncGenerator<T, void> {
  return (async function* generator(): AsyncGenerator<T, void> {
    for (const item of items) {
      yield item;
    }
  })();
}

describe("LangGraphAdapter", () => {
  it("constructs a graph with official LangGraph SDK when llm is provided", async () => {
    langGraphMocks.createReactAgent.mockReset();
    langGraphMocks.tool.mockReset();

    const graph = {
      async invoke() {
        return { messages: [["assistant", "SDK graph reply"]] };
      },
    };
    langGraphMocks.createReactAgent.mockReturnValue(graph);
    langGraphMocks.tool.mockImplementation((_fn, fields) => ({ name: fields.name }));

    class FakeToolsWithSchemas extends FakeTools {
      public getToolSchemas(): Array<Record<string, unknown>> {
        return [
          {
            type: "function",
            function: {
              name: "thenvoi_send_message",
              description: "Send a message",
              parameters: {
                type: "object",
                properties: {
                  content: { type: "string" },
                },
                required: ["content"],
              },
            },
          },
        ];
      }
    }

    const llm = { provider: "test-llm" };
    const adapter = new LangGraphAdapter({ llm });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeToolsWithSchemas();
    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-sdk" },
    );

    expect(langGraphMocks.tool).toHaveBeenCalledTimes(1);
    expect(langGraphMocks.createReactAgent).toHaveBeenCalledTimes(1);
    const args = langGraphMocks.createReactAgent.mock.calls[0]?.[0] as {
      llm: unknown;
      tools: unknown[];
      prompt?: string;
    };
    expect(args.llm).toBe(llm);
    expect(args.tools).toHaveLength(1);
    expect(typeof args.prompt).toBe("string");
    expect(args.prompt).toContain("LangGraph Agent");
    expect(tools.messages).toEqual(["SDK graph reply"]);
  });

  it("builds bootstrap messages and forwards final assistant text", async () => {
    const invokeCalls: Array<{ messages?: Array<[string, string]> }> = [];
    const graph = {
      async invoke(input: Record<string, unknown>) {
        invokeCalls.push(input as { messages?: Array<[string, string]> });
        return {
          messages: [["assistant", "LangGraph reply"]],
        };
      },
    };

    const adapter = new LangGraphAdapter({ graph });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([{ sender_type: "User", content: "historic context" }]),
      "Participants changed",
      "Contacts changed",
      { isSessionBootstrap: true, roomId: "room-1" },
    );

    expect(invokeCalls).toHaveLength(1);
    const messages = invokeCalls[0]?.messages ?? [];
    expect(messages[0]?.[0]).toBe("system");
    expect(messages.map((entry) => entry[1])).toEqual([
      messages[0]?.[1],
      "historic context",
      "[System]: Participants changed",
      "[System]: Contacts changed",
      "hello",
    ]);
    expect(tools.messages).toEqual(["LangGraph reply"]);
  });

  it("reports tool stream events when enabled and extracts final text from stream", async () => {
    const graph = {
      streamEvents() {
        return streamFrom([
          { event: "on_tool_start", name: "thenvoi_send_message" },
          { event: "on_tool_end", name: "thenvoi_send_message" },
          {
            event: "on_chain_end",
            data: { output: { messages: [["assistant", "streamed reply"]] } },
          },
        ]);
      },
      async invoke() {
        throw new Error("invoke should not be called when streaming is used");
      },
    };

    const adapter = new LangGraphAdapter({ graph, emitExecutionEvents: true });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("run"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-2" },
    );

    expect(tools.events).toHaveLength(2);
    expect(tools.events[0]?.messageType).toBe("tool_call");
    expect(tools.events[1]?.messageType).toBe("tool_result");
    expect(tools.messages).toEqual(["streamed reply"]);
  });

  it("re-injects system prompt after room cleanup", async () => {
    const invokeCalls: Array<{ messages?: Array<[string, string]> }> = [];
    const graph = {
      async invoke(input: Record<string, unknown>) {
        invokeCalls.push(input as { messages?: Array<[string, string]> });
        return { messages: [["assistant", "ok"]] };
      },
    };

    const adapter = new LangGraphAdapter({ graph });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("first", "room-3"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-3" },
    );
    await adapter.onCleanup("room-3");
    await adapter.onMessage(
      makeMessage("second", "room-3"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-3" },
    );

    expect(invokeCalls).toHaveLength(2);
    expect(invokeCalls[0]?.messages?.[0]?.[0]).toBe("system");
    expect(invokeCalls[1]?.messages?.[0]?.[0]).toBe("system");
  });

  it("logs stream event serialization fallbacks instead of swallowing them", async () => {
    const circularEvent: Record<string, unknown> = {
      event: "on_tool_start",
      name: "thenvoi_send_message",
    };
    circularEvent.self = circularEvent;

    const graph = {
      streamEvents() {
        return streamFrom([
          circularEvent,
          {
            event: "on_chain_end",
            data: { output: { messages: [["assistant", "done"]] } },
          },
        ]);
      },
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const adapter = new LangGraphAdapter({
      graph,
      emitExecutionEvents: true,
      logger,
    });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("run", "room-serialize"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-serialize" },
    );

    expect(tools.events).toHaveLength(1);
    expect(tools.events[0]?.messageType).toBe("tool_call");
    expect(JSON.parse(tools.events[0]?.content ?? "{}")).toMatchObject({
      event: "on_tool_start",
      serialization_error: expect.any(String),
    });
    expect(tools.messages).toEqual(["done"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "LangGraph event serialization fell back to a safe value",
      expect.objectContaining({
        eventType: "on_tool_start",
      }),
    );
  });
});
