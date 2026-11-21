import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { HistoryProvider } from "../src/runtime";
import { VercelAISDKAdapter } from "../src/index";
import { FAILURE_CODE_TIMEOUT } from "../src/core/providerFailure";
import { FakeTools, SHORT_TURN_TIMEOUT_MS, expectTurnFailed, findFailureEvent, hangUntilAborted, makeMessage } from "./testUtils";

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
          name: "band_get_participants",
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
          toolName: "band_get_participants",
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
      name: "band_get_participants",
      input: {},
    }]);
    expect(tools.messages).toEqual(["Vercel AI SDK final response"]);
    expect(requests).toHaveLength(2);

    expect(requests[0]).toMatchObject({
      system: "You are a strict test agent.",
    });
    expect(requests[0]?.tools).toMatchObject({
      band_get_participants: {
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
        content: "[User]: hello",
      },
      {
        role: "user",
        content: expect.stringMatching(/^\[System\]: Current turn identity:/),
      },
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "band_get_participants",
          input: {},
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "band_get_participants",
          output: { type: "json", value: { ok: true } },
        }],
      },
    ]);
  });

  it("skips a malformed tool call, and sends a result that is not JSON as text", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      { toolCalls: [{ toolName: "no_id" }, "not an object", { toolCallId: "call_1", toolName: "band_get_participants", input: "garbled" }] },
      { text: "done" },
    ];
    const adapter = new VercelAISDKAdapter({
      model: { id: "test-model" },
      generateText: async (params) => {
        requests.push(params);
        return responses.shift() ?? {};
      },
      toolFactory: (definition) => definition,
    });
    const tools = new VercelAISDKTestTools();
    tools.executeToolCall = async (name, input) => {
      tools.executed.push({ name, input });
      return 10n;
    };

    await adapter.onMessage(makeMessage("hello"), tools, history, null, null, { isSessionBootstrap: true, roomId: "room-4" });

    expect(tools.executed).toEqual([{ name: "band_get_participants", input: {} }]);
    expect(requests[1]?.messages).toContainEqual({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_1", toolName: "band_get_participants", output: { type: "text", value: "10" } }],
    });
    expect(tools.messages).toEqual(["done"]);
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

  it("runs a tool turn on the real ai runtime, with notices as user text and JSON-schema tools", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => (calls++ === 0 ? {
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "band_get_participants", input: "{}" }],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      } : {
        content: [{ type: "text", text: "real runtime reply" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    const adapter = new VercelAISDKAdapter({ model });
    const tools = new VercelAISDKTestTools();

    await adapter.onMessage(makeMessage("hello"), tools, history, null, null, { isSessionBootstrap: true, roomId: "room-3" });

    expect(tools.executed).toEqual([{ name: "band_get_participants", input: {} }]);
    expect(tools.messages).toEqual(["real runtime reply"]);
    expect(model.doGenerateCalls).toHaveLength(2);
    // Only the leading instructions may be a system message: Anthropic rejects one mid-conversation.
    const roles = model.doGenerateCalls.map((call) => call.prompt.map((message) => message.role));
    for (const callRoles of roles) {
      expect(callRoles.slice(callRoles[0] === "system" ? 1 : 0)).not.toContain("system");
    }
  });

  it("routes a provider failure through sendFailure with provider: 'vercel-ai-sdk', then fails the turn", async () => {
    const adapter = new VercelAISDKAdapter({
      model: { id: "test-model" },
      generateText: async () => {
        throw new Error("Vercel AI SDK exploded");
      },
      toolFactory: (definition) => definition,
    });
    const tools = new VercelAISDKTestTools();

    await expectTurnFailed(
      adapter.onMessage(makeMessage("hello"), tools, history, null, null, {
        isSessionBootstrap: true,
        roomId: "room-3",
      }),
    );

    expect(tools.messages).toEqual([]);
    expect(tools.events).toHaveLength(1);
    expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
      provider: "vercel-ai-sdk",
      message: "Vercel AI SDK exploded",
    });
  });

  it("aborts the provider request when the turn times out", async () => {
    const hung = hangUntilAborted();
    const adapter = new VercelAISDKAdapter({
      model: { id: "test-model" },
      generateText: (params) => hung.request(params.abortSignal as AbortSignal | undefined),
      toolFactory: (definition) => definition,
      turnTimeoutMs: SHORT_TURN_TIMEOUT_MS,
    });
    const tools = new VercelAISDKTestTools();

    await expectTurnFailed(
      adapter.onMessage(makeMessage("hello"), tools, history, null, null, { isSessionBootstrap: true, roomId: "room-3" }),
    );

    expect(hung.signal?.aborted).toBe(true);
    expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({ provider: "vercel-ai-sdk", code: FAILURE_CODE_TIMEOUT });
  });
});
