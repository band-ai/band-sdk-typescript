import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LangGraphAdapter } from "../src/adapters/langgraph";
import { parseToolCall, parseToolResult } from "../src/converters/shared";
import { HistoryProvider } from "../src/runtime/types";
import { FakeTools, makeMessage } from "./testUtils";

const ARGS = { key: "alpha" };
const SCHEMAS = {
  json: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  zod: z.object({ key: z.string() }),
};

describe.each(Object.entries(SCHEMAS))("LangGraph %s tool events", (_format, schema) => {
  it.each([false, true])("preserves arguments, correlates results, and reports failure=%s", async (failed) => {
    const output = { ok: !failed, code: "opaque-result" };
    const execute = vi.fn(async () => JSON.stringify(output));
    const lookup = tool(execute, { name: "lookup", description: "Look up a code", schema });
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("tools", new ToolNode([lookup]))
      .addEdge(START, "tools")
      .addEdge("tools", END)
      .compile();
    const adapter = new LangGraphAdapter({
      graph: {
        streamEvents: () => graph.streamEvents(
          { messages: [new AIMessage({ content: "", tool_calls: [{ id: "provider-call", name: "lookup", args: ARGS, type: "tool_call" }] })] },
          { version: "v2" },
        ),
      },
    });
    await adapter.onStarted("Lookup Agent", "Looks up codes");
    const tools = new FakeTools();

    await adapter.onMessage(makeMessage("look up alpha"), tools, new HistoryProvider([]), null, null, {
      roomId: "room-events", isSessionBootstrap: false,
    });

    expect(execute).toHaveBeenCalledOnce();
    const call = parseToolCall(tools.events.find((event) => event.messageType === "tool_call")!.content);
    const result = parseToolResult(tools.events.find((event) => event.messageType === "tool_result")!.content);
    expect(call).toEqual({ name: "lookup", args: ARGS, toolCallId: expect.any(String) });
    expect(result).toEqual({ name: "lookup", toolCallId: call!.toolCallId, output: JSON.stringify(output), isError: failed });
  });
});
