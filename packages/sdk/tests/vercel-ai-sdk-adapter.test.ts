import { describe, expect, it } from "vitest";

import type { HistoryProvider } from "../src/runtime";
import { VercelAISDKAdapter } from "../src/index";
import { FakeTools, makeMessage } from "./testUtils";

class VercelAISDKTestTools extends FakeTools {
  public readonly executed: Array<{ name: string; input: Record<string, unknown> }> = [];

  public override getToolSchemas(
    format: "openai" | "anthropic",
    _options?: { includeMemory?: boolean },
  ): Array<Record<string, unknown>> {
    if (format !== "openai") {
      return [];
    }

    return [
      {
        type: "function",
        function: {
          name: "thenvoi_get_participants",
          description: "List participants",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      },
    ];
  }

  public override async executeToolCall(
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    this.executed.push({ name, input });
    return { ok: true };
  }
}

const history = {
  raw: [],
  convert: () => [],
  length: 0,
} as unknown as HistoryProvider;

describe("VercelAISDKAdapter", () => {
  it("uses Vercel AI SDK style tool definitions and completes the tool loop", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      {
        toolCalls: [{
          toolCallId: "call_1",
          toolName: "thenvoi_get_participants",
          input: {},
        }],
      },
      {
        text: "Vercel AI SDK final response",
      },
    ];

    const adapter = new VercelAISDKAdapter({
      model: { id: "test-model" },
      systemPrompt: "You are a strict test agent.",
      generateText: async (params) => {
        requests.push(params);
        const next = responses.shift();
        if (!next) {
          throw new Error("No mock Vercel AI SDK response available");
        }
        return next;
      },
      toolFactory: (definition) => definition,
    });
    const tools = new VercelAISDKTestTools();

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      history,
      null,
      null,
      {
        isSessionBootstrap: true,
        roomId: "room-1",
      },
    );

    expect(tools.executed).toEqual([{
      name: "thenvoi_get_participants",
      input: {},
    }]);
    expect(tools.messages).toEqual(["Vercel AI SDK final response"]);
    expect(requests).toHaveLength(2);

    expect(requests[0]).toMatchObject({
      system: "You are a strict test agent.",
    });
    expect(requests[0]?.tools).toMatchObject({
      thenvoi_get_participants: {
        description: "List participants",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    });

    expect(requests[1]?.messages).toEqual([
      {
        role: "user",
        content: "hello",
      },
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "thenvoi_get_participants",
          input: {},
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "thenvoi_get_participants",
          output: { type: "json", value: { ok: true } },
        }],
      },
    ]);
  });

  it("sends final text when used directly", async () => {
    const adapter = new VercelAISDKAdapter({
      model: { id: "test-model" },
      generateText: async () => ({ text: "alias works" }),
      toolFactory: (definition) => definition,
    });
    const tools = new VercelAISDKTestTools();

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      history,
      null,
      null,
      {
        isSessionBootstrap: true,
        roomId: "room-2",
      },
    );

    expect(tools.messages).toEqual(["alias works"]);
  });
});
