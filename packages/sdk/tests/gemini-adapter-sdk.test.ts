import { createPartFromFunctionCall, createPartFromFunctionResponse } from "@google/genai";
import { describe, expect, it } from "vitest";

import type { HistoryProvider } from "../src/runtime";
import { GeminiAdapter } from "../src/index";
import { GeminiToolCallingModel, DEFAULT_GEMINI_MODEL } from "../src/adapters";
import { FAILURE_CODE_TIMEOUT } from "../src/core/providerFailure";
import type { GeminiGenerateResponseLike } from "../src/adapters/gemini/model";
import { geminiCall, geminiResponse } from "./support/geminiResponses";
import { FakeTools, SHORT_TURN_TIMEOUT_MS, expectTurnFailed, findFailureEvent, hangUntilAborted, makeMessage } from "./testUtils";

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
          name: "band_lookup_peers",
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

type GeminiRequest = { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };

function recordingGeminiModel(responses: GeminiGenerateResponseLike[]) {
  const requests: GeminiRequest[] = [];
  const model = new GeminiToolCallingModel({
    model: DEFAULT_GEMINI_MODEL,
    clientFactory: async () => ({
      models: {
        generateContent: async (params) => {
          requests.push(structuredClone(params) as GeminiRequest);
          return responses.shift()!;
        },
      },
    }),
    partFactory: { createPartFromFunctionCall, createPartFromFunctionResponse },
  });
  return { model, requests };
}

function responseIds(entry: GeminiRequest["contents"][number] | undefined): unknown[] | undefined {
  return entry?.parts.map((part) => (part.functionResponse as { id?: string }).id);
}

async function runTurn(model: GeminiToolCallingModel, tools: GeminiTestTools): Promise<void> {
  await new GeminiAdapter({ model }).onMessage(makeMessage("hello"), tools, history, null, null, {
    isSessionBootstrap: true,
    roomId: "room-1",
  });
}

describe("GeminiAdapter", () => {
  it("uses official SDK-style generateContent flow with function call loop", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      geminiResponse(geminiCall("band_lookup_peers", { page: 1 }, { id: "gcall_1" })),
      geminiResponse({ text: "Gemini final response" }),
    ];

    const model = new GeminiToolCallingModel({
      model: DEFAULT_GEMINI_MODEL,
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
        name: "band_lookup_peers",
        input: { page: 1 },
      },
    ]);
    expect(tools.messages).toEqual(["Gemini final response"]);
    expect(requests).toHaveLength(2);

    expect(requests[0]).toMatchObject({
      model: DEFAULT_GEMINI_MODEL,
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: "band_lookup_peers",
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

  it("replays the model turn as received, signatures included, with each call's id matching its response", async () => {
    // Gemini signs only the first of parallel calls; a text part may carry a signature too, and ids may be absent.
    const note = { text: "Checking both pages.", thoughtSignature: "sig-text" };
    const signed = geminiCall("band_lookup_peers", { page: 1 }, { id: "c1", thoughtSignature: "sig-c1" });
    const unsigned = geminiCall("band_lookup_peers", { page: 2 });
    const { model, requests } = recordingGeminiModel([geminiResponse(note, signed, unsigned), geminiResponse({ text: "done" })]);
    const tools = new GeminiTestTools();

    await runTurn(model, tools);

    expect(tools.executed.map(({ input }) => input)).toEqual([{ page: 1 }, { page: 2 }]);
    expect(tools.messages).toEqual(["done"]);
    const contents = requests[1]?.contents ?? [];
    const modelTurn = contents.find(({ role }) => role === "model");
    expect(modelTurn?.parts).toEqual([
      note,
      signed,
      { functionCall: { name: "band_lookup_peers", args: { page: 2 }, id: "gemini_call_2" } },
    ]);
    expect(responseIds(contents.at(-1))).toEqual(["c1", "gemini_call_2"]);
  });

  it("replays each tool round with its own model turn and signature", async () => {
    const first = geminiCall("band_lookup_peers", { page: 1 }, { id: "c1", thoughtSignature: "sig-1" });
    const second = geminiCall("band_lookup_peers", { page: 2 }, { id: "c2", thoughtSignature: "sig-2" });
    const { model, requests } = recordingGeminiModel([
      geminiResponse(first),
      geminiResponse(second),
      geminiResponse({ text: "done" }),
    ]);
    const tools = new GeminiTestTools();

    await runTurn(model, tools);

    expect(tools.messages).toEqual(["done"]);
    expect(requests).toHaveLength(3);
    const [firstCall, firstResult, secondCall, secondResult] = requests[2]?.contents.slice(-4) ?? [];
    expect(firstCall).toEqual({ role: "model", parts: [first] });
    expect(responseIds(firstResult)).toEqual(["c1"]);
    expect(secondCall).toEqual({ role: "model", parts: [second] });
    expect(responseIds(secondResult)).toEqual(["c2"]);
  });

  it("leaves a nameless function call out of the replay and gives it no response", async () => {
    const named = geminiCall("band_lookup_peers", { page: 1 }, { id: "c1" });
    const { model, requests } = recordingGeminiModel([
      geminiResponse({ functionCall: { args: { page: 9 } } }, named),
      geminiResponse({ text: "done" }),
    ]);
    const tools = new GeminiTestTools();

    await runTurn(model, tools);

    expect(tools.executed).toEqual([{ name: "band_lookup_peers", input: { page: 1 } }]);
    const contents = requests[1]?.contents ?? [];
    expect(contents.find(({ role }) => role === "model")?.parts).toEqual([named]);
    expect(responseIds(contents.at(-1))).toEqual(["c1"]);
  });

  it("still reads calls from a custom client that returns only functionCalls", async () => {
    const responses = [
      { functionCalls: [{ id: "c1", name: "band_lookup_peers", args: { page: 1 } }] },
      { text: "done" },
    ];
    const model = new GeminiToolCallingModel({
      model: DEFAULT_GEMINI_MODEL,
      clientFactory: async () => ({ models: { generateContent: async () => responses.shift()! } }),
      partFactory: { createPartFromFunctionCall, createPartFromFunctionResponse },
    });
    const tools = new GeminiTestTools();

    await new GeminiAdapter({ model }).onMessage(makeMessage("hello"), tools, history, null, null, {
      isSessionBootstrap: true,
      roomId: "room-1",
    });

    expect(tools.executed).toEqual([{ name: "band_lookup_peers", input: { page: 1 } }]);
    expect(tools.messages).toEqual(["done"]);
  });

  it("routes a provider failure through sendFailure with provider: 'gemini', then fails the turn", async () => {
    const model = new GeminiToolCallingModel({
      model: DEFAULT_GEMINI_MODEL,
      clientFactory: async () => ({
        models: {
          generateContent: async () => {
            throw new Error("Gemini API exploded");
          },
        },
      }),
      partFactory: {
        createPartFromFunctionCall: (name, args) => ({ functionCall: { name, args } }),
        createPartFromFunctionResponse: (id, name, response) => ({ functionResponse: { id, name, response } }),
      },
    });

    const adapter = new GeminiAdapter({ model });
    const tools = new GeminiTestTools();

    await expectTurnFailed(
      adapter.onMessage(makeMessage("hello"), tools, history, null, null, {
        isSessionBootstrap: true,
        roomId: "room-1",
      }),
    );

    expect(tools.messages).toEqual([]);
    expect(tools.events).toHaveLength(1);
    expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
      provider: "gemini",
      message: "Gemini API exploded",
    });
  });

  it("aborts the provider request when the turn times out", async () => {
    const hung = hangUntilAborted();
    const model = new GeminiToolCallingModel({
      model: DEFAULT_GEMINI_MODEL,
      clientFactory: async () => ({
        models: {
          generateContent: (params: Record<string, unknown>) =>
            hung.request((params.config as { abortSignal?: AbortSignal }).abortSignal),
        },
      }),
      partFactory: {
        createPartFromFunctionCall: (name, args) => ({ functionCall: { name, args } }),
        createPartFromFunctionResponse: (id, name, response) => ({ functionResponse: { id, name, response } }),
      },
    });
    const adapter = new GeminiAdapter({ model, turnTimeoutMs: SHORT_TURN_TIMEOUT_MS });
    const tools = new GeminiTestTools();

    await expectTurnFailed(
      adapter.onMessage(makeMessage("hello"), tools, history, null, null, { isSessionBootstrap: true, roomId: "room-1" }),
    );

    expect(hung.signal?.aborted).toBe(true);
    expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({ provider: "gemini", code: FAILURE_CODE_TIMEOUT });
  });

  it("sends DEFAULT_GEMINI_MODEL when model and geminiModel are omitted", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const adapter = new GeminiAdapter({
      clientFactory: async () => ({
        models: {
          generateContent: async (params: Record<string, unknown>) => {
            requests.push(params);
            return { text: "ok" };
          },
        },
      }),
    });
    const tools = new GeminiTestTools();

    await adapter.onMessage(makeMessage("hello"), tools, history, null, null, {
      isSessionBootstrap: true,
      roomId: "room-1",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: DEFAULT_GEMINI_MODEL });
  });
});
