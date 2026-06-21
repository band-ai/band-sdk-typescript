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

  it("replays history on follow-ups with the triggering message kept exactly once, last", async () => {
    const invokeCalls: Array<{ messages?: Array<[string, string]> }> = [];
    const graph = {
      async invoke(input: Record<string, unknown>) {
        invokeCalls.push(input as { messages?: Array<[string, string]> });
        return { messages: [["assistant", "ack"]] };
      },
    };

    const adapter = new LangGraphAdapter({ graph });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeTools();
    // The platform records the triggering message before snapshotting history, so on follow-up
    // turns history.raw already contains it (id === message.id). It must not be dropped or doubled.
    await adapter.onMessage(
      { ...makeMessage("what is the status?"), id: "msg-3" },
      tools,
      new HistoryProvider([
        { id: "msg-1", sender_type: "User", content: "deploy the service" },
        { id: "msg-2", sender_type: "Agent", content: "Working on it." },
        { id: "msg-3", sender_type: "User", content: "what is the status?" },
      ]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-dedup" },
    );

    const messages = invokeCalls[0]?.messages ?? [];
    // Stateless custom graph: system prompt is re-sent every turn (not just bootstrap).
    expect(messages[0]?.[0]).toBe("system");
    const replayed = messages.filter((e) => e[0] !== "system").map((e) => e[1]);
    // Prior turns replayed, then the triggering message exactly once as the final entry.
    expect(replayed).toEqual(["deploy the service", "Working on it.", "what is the status?"]);
    expect(tools.messages).toEqual(["ack"]);
  });

  it("with a checkpointer, seeds context once on bootstrap and never re-feeds it", async () => {
    const invokeCalls: Array<{ messages?: Array<[string, string]> }> = [];
    const graph = {
      async invoke(input: Record<string, unknown>) {
        invokeCalls.push(input as { messages?: Array<[string, string]> });
        return { messages: [["assistant", "ok"]] };
      },
    };

    const adapter = new LangGraphAdapter({ graph, checkpointer: {} });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeTools();
    const history = new HistoryProvider([{ id: "h1", sender_type: "User", content: "earlier turn" }]);
    const roomId = "room-ckpt";
    const send = (id: string, content: string, isSessionBootstrap: boolean) =>
      adapter.onMessage({ ...makeMessage(content), id }, tools, history, null, null, {
        isSessionBootstrap,
        roomId,
      });

    await send("m1", "first", true); // first bootstrap → seed system prompt + history
    await send("m2", "second", false); // follow-up → checkpoint persists; no replay
    await send("m3", "third", true); // re-bootstrap (reconnect) → must not re-seed

    const turn = (i: number) => invokeCalls[i]?.messages ?? [];
    const nonSystem = (i: number) => turn(i).filter((e) => e[0] !== "system").map((e) => e[1]);

    // Bootstrap seeds once: system prompt + replayed history + current message.
    expect(turn(0)[0]?.[0]).toBe("system");
    expect(nonSystem(0)).toEqual(["earlier turn", "first"]);
    // Follow-up and re-bootstrap both rely on persisted state: no system prompt, no replayed history.
    expect(turn(1).some((e) => e[0] === "system")).toBe(false);
    expect(nonSystem(1)).toEqual(["second"]);
    expect(turn(2).some((e) => e[0] === "system")).toBe(false);
    expect(nonSystem(2)).toEqual(["third"]);
  });

  it("treats a disabled checkpointer (false) as stateless and replays history", async () => {
    const invokeCalls: Array<{ messages?: Array<[string, string]> }> = [];
    const graph = {
      async invoke(input: Record<string, unknown>) {
        invokeCalls.push(input as { messages?: Array<[string, string]> });
        return { messages: [["assistant", "ok"]] };
      },
    };

    const adapter = new LangGraphAdapter({ graph, checkpointer: false });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeTools();
    // checkpointer:false disables persistence, so follow-ups must still replay room history.
    await adapter.onMessage(
      { ...makeMessage("now"), id: "m2" },
      tools,
      new HistoryProvider([{ id: "m1", sender_type: "User", content: "earlier turn" }]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-disabled-ckpt" },
    );

    const replayed = (invokeCalls[0]?.messages ?? []).filter((e) => e[0] !== "system");
    expect(replayed.map((e) => e[1])).toEqual(["earlier turn", "now"]);
  });

  it("counts only prior turns against maxHistoryMessages, excluding the current message", async () => {
    const invokeCalls: Array<{ messages?: Array<[string, string]> }> = [];
    const graph = {
      async invoke(input: Record<string, unknown>) {
        invokeCalls.push(input as { messages?: Array<[string, string]> });
        return { messages: [["assistant", "ok"]] };
      },
    };

    const adapter = new LangGraphAdapter({ graph, maxHistoryMessages: 2 });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeTools();
    // Follow-up: raw history already includes the current message (id m3). With maxHistoryMessages=2,
    // the current message must not consume a history slot, so both prior turns survive truncation.
    await adapter.onMessage(
      { ...makeMessage("now"), id: "m3" },
      tools,
      new HistoryProvider([
        { id: "m1", sender_type: "User", content: "one" },
        { id: "m2", sender_type: "Agent", content: "two" },
        { id: "m3", sender_type: "User", content: "now" },
      ]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-truncate" },
    );

    const replayed = (invokeCalls[0]?.messages ?? []).filter((e) => e[0] !== "system");
    expect(replayed.map((e) => e[1])).toEqual(["one", "two", "now"]);
  });

  it("extracts a reply from a custom graph whose chain name is not LangGraph/agent", async () => {
    const graph = {
      streamEvents() {
        return streamFrom([
          { event: "on_chain_end", name: "RunnableLambda", data: { output: "__end__" } },
          {
            event: "on_chain_end",
            name: "my_graph",
            data: { output: { messages: [["assistant", "custom graph reply"]] } },
          },
        ]);
      },
    };

    const adapter = new LangGraphAdapter({ graph, emitExecutionEvents: true });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-custom-chain" },
    );

    expect(tools.messages).toEqual(["custom graph reply"]);
  });

  it("reports tool stream events when enabled and extracts final text from stream", async () => {
    const graph = {
      streamEvents() {
        return streamFrom([
          { event: "on_tool_start", name: "thenvoi_send_message" },
          { event: "on_tool_end", name: "thenvoi_send_message" },
          {
            event: "on_chain_end",
            name: "RunnableLambda",
            data: { output: "__end__" },
          },
          {
            event: "on_chain_end",
            name: "LangGraph",
            data: {
              output: {
                messages: [["assistant", "streamed reply"]],
              },
            },
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

  it("re-injects the system prompt after room cleanup (checkpointed graph)", async () => {
    const invokeCalls: Array<{ messages?: Array<[string, string]> }> = [];
    const graph = {
      async invoke(input: Record<string, unknown>) {
        invokeCalls.push(input as { messages?: Array<[string, string]> });
        return { messages: [["assistant", "ok"]] };
      },
    };

    // A checkpointer makes the bootstrap guard meaningful: the prompt is seeded once per room and
    // not re-sent on a re-bootstrap, unless onCleanup resets the guard. (A stateless graph would
    // re-send every turn, so the cleanup behavior would be untestable.)
    const adapter = new LangGraphAdapter({ graph, checkpointer: {} });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeTools();
    const send = () =>
      adapter.onMessage(makeMessage("hi", "room-3"), tools, new HistoryProvider([]), null, null, {
        isSessionBootstrap: true,
        roomId: "room-3",
      });

    await send(); // first bootstrap → seed system prompt
    await send(); // re-bootstrap, no cleanup → not re-seeded
    await adapter.onCleanup("room-3");
    await send(); // bootstrap after cleanup → re-seeded

    const hasSystem = (i: number) => (invokeCalls[i]?.messages ?? []).some((e) => e[0] === "system");
    expect(hasSystem(0)).toBe(true);
    expect(hasSystem(1)).toBe(false);
    expect(hasSystem(2)).toBe(true);
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
            name: "LangGraph",
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

  it("ignores LangGraph routing markers and parses LangChain assistant messages", async () => {
    const aiMessage = {
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { content: "Hello there!" },
    };

    const graph = {
      streamEvents() {
        return streamFrom([
          {
            event: "on_chain_end",
            name: "RunnableLambda",
            data: { output: "__end__" },
          },
          {
            event: "on_chain_end",
            name: "LangGraph",
            data: { output: { messages: [aiMessage] } },
          },
        ]);
      },
    };

    const adapter = new LangGraphAdapter({ graph, emitExecutionEvents: true });
    await adapter.onStarted("LangGraph Agent", "Graph-backed assistant");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-lc" },
    );

    expect(tools.messages).toEqual(["Hello there!"]);
  });
});
