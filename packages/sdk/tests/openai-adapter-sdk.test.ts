import { describe, expect, it } from "vitest";

import type { HistoryProvider } from "../src/runtime";
import { OpenAIAdapter } from "../src/index";
import { FakeTools, makeMessage } from "./testUtils";

class OpenAITestTools extends FakeTools {
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

describe("OpenAIAdapter", () => {
  it("uses official SDK-style client factory and completes tool loop", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "thenvoi_get_participants",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: "OpenAI final response",
            },
          },
        ],
      },
    ];

    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            requests.push(params);
            const next = responses.shift();
            if (!next) {
              throw new Error("No mock OpenAI response available");
            }
            return next;
          },
        },
      },
    };

    const adapter = new OpenAIAdapter({
      openAIModel: "gpt-5.2",
      clientFactory: async () => client,
      systemPrompt: "You are a strict test agent.",
    });
    const tools = new OpenAITestTools();

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
        name: "thenvoi_get_participants",
        input: {},
      },
    ]);
    expect(tools.messages).toEqual(["OpenAI final response"]);
    expect(requests).toHaveLength(2);

    expect(requests[0]).toMatchObject({
      model: "gpt-5.2",
      tool_choice: "auto",
    });
    const firstMessages = requests[0]?.messages as Array<Record<string, unknown>>;
    expect(firstMessages[0]).toMatchObject({
      role: "system",
      content: "You are a strict test agent.",
    });

    const secondMessages = requests[1]?.messages as Array<Record<string, unknown>>;
    expect(secondMessages[0]).toMatchObject({
      role: "system",
      content: "You are a strict test agent.",
    });
    expect(
      secondMessages.some(
        (entry) =>
          entry.role === "assistant" &&
          Array.isArray(entry.tool_calls) &&
          entry.tool_calls.length === 1,
      ),
    ).toBe(true);
    expect(
      secondMessages.some(
        (entry) => entry.role === "tool" && entry.tool_call_id === "call_1",
      ),
    ).toBe(true);
  });

  it("returns structured parse errors for malformed tool arguments instead of executing tools", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call_bad",
                  type: "function",
                  function: {
                    name: "thenvoi_get_participants",
                    arguments: "{bad json",
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: "Handled malformed args",
            },
          },
        ],
      },
    ];

    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            requests.push(params);
            const next = responses.shift();
            if (!next) {
              throw new Error("No mock OpenAI response available");
            }
            return next;
          },
        },
      },
    };

    const adapter = new OpenAIAdapter({
      openAIModel: "gpt-5.2",
      clientFactory: async () => client,
    });
    const tools = new OpenAITestTools();

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

    expect(tools.executed).toEqual([]);
    expect(tools.messages).toEqual(["Handled malformed args"]);
    expect(requests).toHaveLength(2);

    const secondMessages = requests[1]?.messages as Array<Record<string, unknown>>;
    const toolMessage = secondMessages.find(
      (entry) => entry.role === "tool" && entry.tool_call_id === "call_bad",
    );
    expect(typeof toolMessage?.content).toBe("string");
    expect(toolMessage?.content).toContain("ToolCallArgumentsParseError");
  });
});
