import { describe, expect, it } from "vitest";

import type { HistoryProvider } from "../src/runtime";
import { AnthropicAdapter } from "../src/index";
import { FakeTools, makeMessage } from "./testUtils";

class AnthropicTestTools extends FakeTools {
  public readonly executed: Array<{ name: string; input: Record<string, unknown> }> = [];

  public override getToolSchemas(
    format: "openai" | "anthropic",
    _options?: { includeMemory?: boolean },
  ): Array<Record<string, unknown>> {
    if (format !== "anthropic") {
      return [];
    }

    return [
      {
        name: "thenvoi_lookup_peers",
        description: "Lookup peers",
        input_schema: {
          type: "object",
          properties: {
            page: { type: "integer" },
          },
          required: [],
        },
      },
    ];
  }

  public override async executeToolCall(
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    this.executed.push({ name, input });
    return { peers: [] };
  }
}

const history = {
  raw: [],
  convert: () => [],
  length: 0,
} as unknown as HistoryProvider;

describe("AnthropicAdapter", () => {
  it("uses official SDK-style client factory and completes tool loop", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "thenvoi_lookup_peers",
            input: { page: 1 },
          },
        ],
      },
      {
        content: [
          {
            type: "text",
            text: "Anthropic final response",
          },
        ],
      },
    ];

    const client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          requests.push(params);
          const next = responses.shift();
          if (!next) {
            throw new Error("No mock Anthropic response available");
          }
          return next;
        },
      },
    };

    const adapter = new AnthropicAdapter({
      anthropicModel: "claude-sonnet-4-6",
      clientFactory: async () => client,
    });
    const tools = new AnthropicTestTools();

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

    expect(tools.executed).toEqual([
      {
        name: "thenvoi_lookup_peers",
        input: { page: 1 },
      },
    ]);
    expect(tools.messages).toEqual(["Anthropic final response"]);
    expect(requests).toHaveLength(2);

    expect(requests[0]).toMatchObject({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
    });

    const secondMessages = requests[1]?.messages as Array<Record<string, unknown>>;
    const assistantBlock = secondMessages.find((entry) => entry.role === "assistant");
    const userBlock = secondMessages.find((entry) => entry.role === "user" && Array.isArray(entry.content));

    expect(assistantBlock).toBeDefined();
    expect(userBlock).toBeDefined();
    expect(assistantBlock?.content).toEqual([
      {
        type: "tool_use",
        id: "toolu_1",
        name: "thenvoi_lookup_peers",
        input: { page: 1 },
      },
    ]);
    expect(userBlock?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "{\"peers\":[]}",
        is_error: false,
      },
    ]);
  });
});
