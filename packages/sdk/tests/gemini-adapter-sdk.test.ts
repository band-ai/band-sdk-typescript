import { describe, expect, it } from "vitest";

import type { HistoryProvider } from "../src/runtime";
import { GeminiAdapter } from "../src/index";
import { GeminiToolCallingModel } from "../src/adapters";
import { FakeTools, makeMessage } from "./testUtils";

class GeminiTestTools extends FakeTools {
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
          name: "thenvoi_lookup_peers",
          description: "Lookup peers",
          parameters: {
            type: "object",
            properties: {
              page: { type: "integer" },
            },
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
    return { peers: [] };
  }
}

const history = {
  raw: [],
  convert: () => [],
  length: 0,
} as unknown as HistoryProvider;

describe("GeminiAdapter", () => {
  it("uses official SDK-style generateContent flow with function call loop", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      {
        functionCalls: [
          {
            id: "gcall_1",
            name: "thenvoi_lookup_peers",
            args: { page: 1 },
          },
        ],
      },
      {
        text: "Gemini final response",
      },
    ];

    const model = new GeminiToolCallingModel({
      model: "gemini-3-flash-preview",
      clientFactory: async () => ({
        models: {
          generateContent: async (params: Record<string, unknown>) => {
            requests.push(params);
            const next = responses.shift();
            if (!next) {
              throw new Error("No mock Gemini response available");
            }
            return next;
          },
        },
      }),
      partFactory: {
        createPartFromFunctionCall: (name, args) => ({
          functionCall: {
            name,
            args,
          },
        }),
        createPartFromFunctionResponse: (id, name, response) => ({
          functionResponse: {
            id,
            name,
            response,
          },
        }),
      },
    });

    const adapter = new GeminiAdapter({ model });
    const tools = new GeminiTestTools();

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
    expect(tools.messages).toEqual(["Gemini final response"]);
    expect(requests).toHaveLength(2);

    expect(requests[0]).toMatchObject({
      model: "gemini-3-flash-preview",
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: "thenvoi_lookup_peers",
              },
            ],
          },
        ],
      },
    });

    const secondContents = requests[1]?.contents as Array<Record<string, unknown>>;
    expect(
      secondContents.some(
        (entry) =>
          entry.role === "model" &&
          Array.isArray(entry.parts) &&
          JSON.stringify(entry.parts).includes("\"functionCall\""),
      ),
    ).toBe(true);
    expect(
      secondContents.some(
        (entry) =>
          entry.role === "user" &&
          Array.isArray(entry.parts) &&
          JSON.stringify(entry.parts).includes("\"functionResponse\""),
      ),
    ).toBe(true);
  });
});
