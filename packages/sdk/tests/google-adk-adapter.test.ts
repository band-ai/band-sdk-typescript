import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GoogleADKAdapter } from "../src/adapters";
import { GoogleADKHistoryConverter } from "../src/converters";
import { MEMORY_SECTION } from "../src/runtime/prompts";
import { SEND_MESSAGE_TOOL_NAME } from "../src/runtime/tools/schemas";
import type { AgentToolsProtocol } from "../src/core";
import { FakeTools, makeMessage, expectTurnFailed } from "./testUtils";
import { describeDeliveryContract } from "./deliveryContract";
import { createDeferred } from "../src/core/deferred";

class GoogleAdkTestTools extends FakeTools {
  public readonly executedCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

  public override getOpenAIToolSchemas(): Array<Record<string, unknown>> {
    return [{
      type: "function",
      function: {
        name: "thenvoi_lookup_weather",
        description: "Lookup the weather",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
          additionalProperties: false,
        },
      },
    }];
  }

  public override async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.executedCalls.push({ toolName, args });
    return { temperature: "12C", city: args.city };
  }
}

interface GoogleAdkCapture {
  createAgentCalls: Array<Record<string, unknown>>;
  createRunnerCalls: Array<{ appName: string }>;
  createSessionCalls: Array<{ appName: string; userId: string; sessionId: string }>;
}


class SendMessageTools extends GoogleAdkTestTools {
  public failSend = false;
  public failDeliveredText: string | null = null;

  public override getOpenAIToolSchemas(): Array<Record<string, unknown>> {
    return [{
      type: "function",
      function: {
        name: SEND_MESSAGE_TOOL_NAME,
        description: "Send a message",
        parameters: { type: "object", properties: { content: {} }, required: ["content"] },
      },
    }];
  }

  public override async sendMessage(...[content, mentions]: Parameters<FakeTools["sendMessage"]>): Promise<Record<string, unknown>> {
    if (this.failDeliveredText !== null && content === this.failDeliveredText) {
      throw new Error("send failed");
    }
    return super.sendMessage(content, mentions);
  }

  public override async executeToolCall(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.executedCalls.push({ toolName, args });
    if (toolName === SEND_MESSAGE_TOOL_NAME && this.failSend) {
      return { ok: false, message: "send failed" };
    }
    return { ok: true };
  }
}

function sendToolOf(agent: Record<string, unknown>): (input: unknown) => Promise<unknown> {
  const tool = (agent.tools as Array<Record<string, unknown>>).find((candidate) => candidate.name === SEND_MESSAGE_TOOL_NAME);
  if (!tool || typeof tool.execute !== "function") {
    throw new Error("send tool was not registered");
  }
  return tool.execute as (input: unknown) => Promise<unknown>;
}

function createFakeGoogleAdkSdk(
  run: (agent: Record<string, unknown>, request: { userId: string; sessionId: string; newMessage: { role: "user"; parts: Array<{ text: string }> } }) => AsyncIterable<unknown>,
  capture?: GoogleAdkCapture,
): () => Promise<any> {
  return async () => ({
    createModel: (params: { model: string; apiKey: string }) => ({ gemini: params }),
    createAgent: (params: Record<string, unknown>) => {
      capture?.createAgentCalls?.push(params);
      return params;
    },
    createFunctionTool: (params: Record<string, unknown>) => params,
    createRunner: (params: { agent: Record<string, unknown>; appName: string }) => {
      capture?.createRunnerCalls?.push({ appName: params.appName });
      return {
        sessionService: {
          createSession: async (sessionParams: { appName: string; userId: string; sessionId: string }) => {
            capture?.createSessionCalls?.push(sessionParams);
            return { ok: true };
          },
        },
        runAsync: (request: { userId: string; sessionId: string; newMessage: { role: "user"; parts: Array<{ text: string }> } }) => run(params.agent, request),
      };
    },
    isFinalResponse: (event: Record<string, unknown>) => event.final === true,
    getFunctionCalls: (event: Record<string, unknown>) => Array.isArray(event.functionCalls) ? event.functionCalls : [],
    getFunctionResponses: (event: Record<string, unknown>) => Array.isArray(event.functionResponses) ? event.functionResponses : [],
    stringifyContent: (event: Record<string, unknown>) => String(event.text ?? ""),
  });
}

describe("GoogleADKAdapter", () => {
  describeDeliveryContract([{
    path: "final assistant text",
    turn: async (tools) => {
      const adapter = new GoogleADKAdapter({
        sdkFactory: createFakeGoogleAdkSdk(async function* () {
          yield { final: true, text: "It is 12C in Vancouver." };
        }),
      });
      await adapter.onMessage(
        makeMessage("weather?"),
        tools,
        [],
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-delivery" },
      );
    },
  }]);

  it("bridges platform tools and reports final assistant text", async () => {
    const tools = new GoogleAdkTestTools();
    const seenPrompts: string[] = [];

    const adapter = new GoogleADKAdapter({
      enableExecutionReporting: true,
      sdkFactory: createFakeGoogleAdkSdk(async function* (
        agent,
        request,
      ) {
        seenPrompts.push(request.newMessage.parts[0]?.text ?? "");
        const tool = (agent.tools as Array<Record<string, unknown>>).find(
          (candidate) => candidate.name === "thenvoi_lookup_weather",
        );
        const output = await (tool?.execute as (input: unknown) => Promise<unknown>)({
          city: "Vancouver",
        });

        yield {
          functionCalls: [{ id: "call-1", name: "thenvoi_lookup_weather", args: { city: "Vancouver" } }],
          functionResponses: [{ id: "call-1", name: "thenvoi_lookup_weather", response: output }],
        };
        yield { final: true, text: "It is 12C in Vancouver." };
      }),
    });

    await adapter.onStarted("Weather Agent", "Answers weather questions");
    await adapter.onMessage(
      makeMessage("What's the weather?"),
      tools,
      [{
        role: "user",
        content: "[Jane]: Earlier context",
      }],
      "Participants changed",
      "Contacts changed",
      { isSessionBootstrap: true, roomId: "room-1" },
    );

    expect(tools.executedCalls).toEqual([
      { toolName: "thenvoi_lookup_weather", args: { city: "Vancouver" } },
    ]);
    expect(tools.messages).toEqual(["It is 12C in Vancouver."]);
    expect(tools.events).toEqual([
      {
        content: JSON.stringify({
          name: "thenvoi_lookup_weather",
          args: { city: "Vancouver" },
          tool_call_id: "call-1",
        }),
        messageType: "tool_call",
        metadata: undefined,
      },
      {
        content: JSON.stringify({
          name: "thenvoi_lookup_weather",
          output: "{\n  \"temperature\": \"12C\",\n  \"city\": \"Vancouver\"\n}",
          tool_call_id: "call-1",
        }),
        messageType: "tool_result",
        metadata: undefined,
      },
    ]);
    expect(seenPrompts[0]).toContain("[Previous conversation context]");
    expect(seenPrompts[0]).toContain("Participants changed");
    expect(seenPrompts[0]).toContain("Contacts changed");
  });

  it("carries a reply it posted through the send tool into the next turn's context", async () => {
    const seenPrompts: string[] = [];
    const adapter = new GoogleADKAdapter({
      sdkFactory: createFakeGoogleAdkSdk(async function* (agent, request) {
        seenPrompts.push(request.newMessage.parts[0]?.text ?? "");
        if (seenPrompts.length === 1) {
          await sendToolOf(agent)({ content: "pineapple" });
        }
        yield { final: true, text: "" };
      }),
    });
    const tools = new SendMessageTools();

    await adapter.onMessage(makeMessage("Reply with: pineapple"), tools, [], null, null, { isSessionBootstrap: true, roomId: "room-1" });
    await adapter.onMessage(makeMessage("Reply with: mango"), tools, [], null, null, { isSessionBootstrap: false, roomId: "room-1" });

    expect(seenPrompts[1]).toContain("[User]: Reply with: pineapple\npineapple");
  });

  it.each([
    { failSend: false, delivered: [] },
    { failSend: true, delivered: ["I posted it."] },
  ])("treats a send-tool post as the reply, its final text as a fallback (send failed: $failSend)", async ({ failSend, delivered }) => {
    const adapter = new GoogleADKAdapter({
      sdkFactory: createFakeGoogleAdkSdk(async function* (agent) {
        await sendToolOf(agent)({ content: "pineapple" });
        yield { final: true, text: "I posted it." };
      }),
    });
    const tools = new SendMessageTools();
    tools.failSend = failSend;

    await adapter.onMessage(makeMessage("Reply with: pineapple"), tools, [], null, null, { isSessionBootstrap: true, roomId: "room-1" });

    expect(tools.messages).toEqual(delivered);
  });

  it("does not remember a send that failed", async () => {
    const seenPrompts: string[] = [];
    const tools = new SendMessageTools();
    tools.failSend = true;
    const adapter = new GoogleADKAdapter({
      sdkFactory: createFakeGoogleAdkSdk(async function* (agent, request) {
        seenPrompts.push(request.newMessage.parts[0]?.text ?? "");
        if (seenPrompts.length === 1) {
          await sendToolOf(agent)({ content: "pineapple" });
        }
        yield { final: true, text: "" };
      }),
    });

    await adapter.onMessage(makeMessage("Reply with: pineapple"), tools, [], null, null, { isSessionBootstrap: true, roomId: "room-1" });
    await adapter.onMessage(makeMessage("Reply with: mango"), tools, [], null, null, { isSessionBootstrap: false, roomId: "room-1" });

    expect(seenPrompts[1]).toContain("[User]: Reply with: pineapple");
    expect(seenPrompts[1]).not.toContain("\npineapple");
  });

  it("keeps a send that landed when the runner then throws", async () => {
    const seenPrompts: string[] = [];
    const adapter = new GoogleADKAdapter({
      sdkFactory: createFakeGoogleAdkSdk(async function* (agent, request) {
        seenPrompts.push(request.newMessage.parts[0]?.text ?? "");
        if (seenPrompts.length === 1) {
          await sendToolOf(agent)({ content: "pineapple" });
          throw new Error("provider blew up");
        }
        yield { final: true, text: "" };
      }),
    });
    const tools = new SendMessageTools();

    await expect(adapter.onMessage(makeMessage("Reply with: pineapple"), tools, [], null, null, { isSessionBootstrap: true, roomId: "room-1" })).rejects.toThrow();
    await adapter.onMessage(makeMessage("Reply with: mango"), tools, [], null, null, { isSessionBootstrap: false, roomId: "room-1" });

    expect(seenPrompts[1]).toContain("[User]: Reply with: pineapple\npineapple");
  });

  it("does not remember final text that was not delivered", async () => {
    const seenPrompts: string[] = [];
    const adapter = new GoogleADKAdapter({
      sdkFactory: createFakeGoogleAdkSdk(async function* (_agent, request) {
        seenPrompts.push(request.newMessage.parts[0]?.text ?? "");
        yield { final: true, text: seenPrompts.length === 1 ? "all done" : "" };
      }),
    });
    const tools = new SendMessageTools();
    tools.failDeliveredText = "all done";

    await expect(adapter.onMessage(makeMessage("please finish"), tools, [], null, null, { isSessionBootstrap: true, roomId: "room-1" })).rejects.toThrow();
    await adapter.onMessage(makeMessage("next question"), tools, [], null, null, { isSessionBootstrap: false, roomId: "room-1" });

    expect(seenPrompts[1]).toContain("[User]: please finish");
    expect(seenPrompts[1]).not.toContain("all done");
  });

  it("runs a new session's turn while a parked turn from before cleanup is still in flight, and drops that transcript", async () => {
    const parked = createDeferred();
    const firstStarted = createDeferred();
    const seenPrompts: string[] = [];
    const adapter = new GoogleADKAdapter({
      sdkFactory: createFakeGoogleAdkSdk(async function* (_agent, request) {
        seenPrompts.push(request.newMessage.parts[0]?.text ?? "");
        if (seenPrompts.length === 1) {
          firstStarted.resolve();
          await parked.promise;
          yield { final: true, text: "pineapple" };
          return;
        }
        yield { final: true, text: "mango" };
      }),
    });
    const tools = new SendMessageTools();
    const first = adapter.onMessage(makeMessage("stale question"), tools, [], null, null, { isSessionBootstrap: true, roomId: "room-1" });
    await firstStarted.promise;
    await adapter.onCleanup("room-1");

    await adapter.onMessage(makeMessage("next question"), tools, [], null, null, { isSessionBootstrap: true, roomId: "room-1" });
    parked.resolve();
    await first;
    await adapter.onMessage(makeMessage("last question"), tools, [], null, null, { isSessionBootstrap: false, roomId: "room-1" });

    expect(seenPrompts.at(-1)).toContain("[User]: next question\nmango");
    expect(seenPrompts.at(-1)).not.toContain("stale question");
    expect(seenPrompts.at(-1)).not.toContain("pineapple");
  });

  it("remembers the string a non-string send argument was posted as", async () => {
    const seenPrompts: string[] = [];
    const adapter = new GoogleADKAdapter({
      sdkFactory: createFakeGoogleAdkSdk(async function* (agent, request) {
        seenPrompts.push(request.newMessage.parts[0]?.text ?? "");
        if (seenPrompts.length === 1) {
          await sendToolOf(agent)({ content: 42 });
        }
        yield { final: true, text: "" };
      }),
    });
    const tools = new SendMessageTools();

    await adapter.onMessage(makeMessage("send a number"), tools, [], null, null, { isSessionBootstrap: true, roomId: "room-1" });
    await adapter.onMessage(makeMessage("next question"), tools, [], null, null, { isSessionBootstrap: false, roomId: "room-1" });

    expect(seenPrompts[1]).toContain("[User]: send a number\n42");
  });

  it("logs a warning instead of silently swallowing a failed tool-call/tool-result event send", async () => {
    class FailingSendEventTools extends GoogleAdkTestTools {
      public override async sendEvent(): Promise<Record<string, unknown>> {
        return { ok: false, status: "failed" };
      }
    }

    const tools = new FailingSendEventTools();
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];

    const adapter = new GoogleADKAdapter({
      enableExecutionReporting: true,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message, context) => warnings.push([message, context]),
        error: () => {},
      },
      sdkFactory: createFakeGoogleAdkSdk(async function* () {
        yield {
          functionCalls: [{ id: "call-1", name: "thenvoi_lookup_weather", args: { city: "Vancouver" } }],
          functionResponses: [{ id: "call-1", name: "thenvoi_lookup_weather", response: "12C" }],
        };
        yield { final: true, text: "It is 12C in Vancouver." };
      }),
    });

    await adapter.onStarted("Weather Agent", "Answers weather questions");
    await adapter.onMessage(
      makeMessage("What's the weather?"),
      tools,
      [],
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-1" },
    );

    expect(tools.messages).toEqual(["It is 12C in Vancouver."]);
    expect(warnings).toEqual([
      ["Google ADK tool_call event send failed", { toolCallId: "call-1" }],
      ["Google ADK tool_result event send failed", { toolCallId: "call-1" }],
    ]);
  });

  it("still delivers the final response when a failed send's logger itself throws", async () => {
    class FailingSendEventTools extends GoogleAdkTestTools {
      public override async sendEvent(): Promise<Record<string, unknown>> {
        return { ok: false, status: "failed" };
      }
    }

    const tools = new FailingSendEventTools();

    const adapter = new GoogleADKAdapter({
      enableExecutionReporting: true,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {
          throw new Error("logger is broken");
        },
        error: () => {},
      },
      sdkFactory: createFakeGoogleAdkSdk(async function* () {
        yield {
          functionCalls: [{ id: "call-1", name: "thenvoi_lookup_weather", args: { city: "Vancouver" } }],
          functionResponses: [{ id: "call-1", name: "thenvoi_lookup_weather", response: "12C" }],
        };
        yield { final: true, text: "It is 12C in Vancouver." };
      }),
    });

    await adapter.onStarted("Weather Agent", "Answers weather questions");
    await adapter.onMessage(
      makeMessage("What's the weather?"),
      tools,
      [],
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-1" },
    );

    expect(tools.messages).toEqual(["It is 12C in Vancouver."]);
  });

  it("bridges custom tools through ADK function tools", async () => {
    const tools = new GoogleAdkTestTools();

    const adapter = new GoogleADKAdapter({
      additionalTools: [{
        name: "lookup_weather",
        description: "Lookup weather",
        schema: z.object({ city: z.string() }),
        handler: async ({ city }) => `custom:${String(city)}`,
      }],
      sdkFactory: createFakeGoogleAdkSdk(async function* (
        agent,
      ) {
        const tool = (agent.tools as Array<Record<string, unknown>>).find(
          (candidate) => candidate.name === "lookup_weather",
        );
        const output = await (tool?.execute as (input: unknown) => Promise<unknown>)({
          city: "Toronto",
        });
        yield { final: true, text: String(output) };
      }),
    });

    await adapter.onStarted("Weather Agent", "Answers weather questions");
    await adapter.onMessage(
      makeMessage("Need weather", "room-2"),
      tools,
      new GoogleADKHistoryConverter().convert([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-2" },
    );

    expect(tools.messages).toEqual(["custom:Toronto"]);
    expect(tools.executedCalls).toEqual([]);
  });

  it("passes appName \"band\" to createRunner and createSession", async () => {
    const tools = new GoogleAdkTestTools();
    const capture: GoogleAdkCapture = {
      createAgentCalls: [],
      createRunnerCalls: [],
      createSessionCalls: [],
    };

    const adapter = new GoogleADKAdapter({
      sdkFactory: createFakeGoogleAdkSdk(async function* () {
        yield { final: true, text: "done" };
      }, capture),
    });

    await adapter.onStarted("Weather Agent", "Answers weather questions");
    await adapter.onMessage(
      makeMessage("What's the weather?", "room-app"),
      tools,
      new GoogleADKHistoryConverter().convert([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-app" },
    );

    expect(capture.createRunnerCalls).toEqual([{ appName: "band" }]);
    expect(capture.createSessionCalls).toHaveLength(1);
    expect(capture.createSessionCalls[0]?.appName).toBe("band");
  });

  describe("memory guidance in a raw system prompt", () => {
    const RAW_PROMPT = "You are a terse assistant.";

    /** The instruction the ADK agent is created with, for a raw `systemPrompt`. */
    async function instructionFor(enableMemoryTools: boolean): Promise<unknown> {
      const capture: GoogleAdkCapture = { createAgentCalls: [], createRunnerCalls: [], createSessionCalls: [] };
      const adapter = new GoogleADKAdapter({
        systemPrompt: RAW_PROMPT,
        enableMemoryTools,
        sdkFactory: createFakeGoogleAdkSdk(async function* () {
          yield { final: true, text: "done" };
        }, capture),
      });
      await adapter.onStarted("Memory Agent", "Remembers things");
      await adapter.onMessage(
        makeMessage("remember this", "room-memory"),
        new GoogleAdkTestTools(),
        new GoogleADKHistoryConverter().convert([]),
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-memory" },
      );
      return capture.createAgentCalls[0]?.instruction;
    }

    it("adds the guidance when memory tools are exposed", async () => {
      const instruction = await instructionFor(true);
      expect(instruction).toContain(RAW_PROMPT);
      expect(instruction).toContain(MEMORY_SECTION);
    });

    it("leaves the prompt as given when they are not", async () => {
      expect(await instructionFor(false)).toBe(RAW_PROMPT);
    });
  });

  it("names the default agent \"band_agent\" when agentName is unset", async () => {
    const tools = new GoogleAdkTestTools();
    const capture: GoogleAdkCapture = { createAgentCalls: [], createRunnerCalls: [], createSessionCalls: [] };

    const adapter = new GoogleADKAdapter({
      sdkFactory: createFakeGoogleAdkSdk(async function* () {
        yield { final: true, text: "done" };
      }, capture),
    });

    await adapter.onStarted("", "Answers weather questions");
    await adapter.onMessage(
      makeMessage("What's the weather?", "room-default"),
      tools,
      new GoogleADKHistoryConverter().convert([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-default" },
    );

    expect(capture.createAgentCalls).toHaveLength(1);
    expect(capture.createAgentCalls[0]?.name).toBe("band_agent");
  });

  it.each([
    { name: "binds the model to an explicit apiKey", apiKey: "explicit-key", model: { gemini: { model: "gemini-2.5-flash", apiKey: "explicit-key" } } },
    { name: "leaves key lookup to ADK when apiKey is unset", apiKey: undefined, model: "gemini-2.5-flash" },
  ])("$name", async ({ apiKey, model }) => {
    const capture: GoogleAdkCapture = { createAgentCalls: [], createRunnerCalls: [], createSessionCalls: [] };
    const adapter = new GoogleADKAdapter({
      apiKey,
      sdkFactory: createFakeGoogleAdkSdk(async function* () {
        yield { final: true, text: "done" };
      }, capture),
    });

    await adapter.onMessage(
      makeMessage("hello", "room-key"),
      new GoogleAdkTestTools(),
      new GoogleADKHistoryConverter().convert([]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-key" },
    );

    expect(capture.createAgentCalls[0]?.model).toEqual(model);
  });

  it("reports a plain thrown Error from the run loop as a generic sendFailure fallback, then fails the turn", async () => {
    const tools = new GoogleAdkTestTools();

    const adapter = new GoogleADKAdapter({
      sdkFactory: createFakeGoogleAdkSdk(async function* () {
        throw new Error("model exploded");
        yield { final: true, text: "unreachable" };
      }),
    });

    await adapter.onStarted("Weather Agent", "Answers weather questions");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("What's the weather?"),
        tools,
        [],
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-1" },
      ),
    );

    expect(tools.messages).toEqual([]);
    expect(tools.events).toEqual([
      {
        content: "model exploded",
        messageType: "error",
        metadata: {
          failure: { provider: "google-adk", code: null, message: "model exploded", detail: null },
        },
      },
    ]);
  });

  it("reports a failure in the previously-uncaught sdk/runner/session setup path, then fails the turn", async () => {
    const tools = new GoogleAdkTestTools();

    const adapter = new GoogleADKAdapter({
      sdkFactory: async () => ({
        createModel: (params: { model: string; apiKey: string }) => params,
        createAgent: (params: Record<string, unknown>) => params,
        createFunctionTool: (params: Record<string, unknown>) => params,
        createRunner: () => ({
          sessionService: {
            createSession: async () => {
              throw new Error("session service unavailable");
            },
          },
          runAsync: () => {
            throw new Error("should not be reached");
          },
        }),
        isFinalResponse: () => false,
        getFunctionCalls: () => [],
        getFunctionResponses: () => [],
        stringifyContent: () => "",
      }),
    });

    await adapter.onStarted("Weather Agent", "Answers weather questions");
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("What's the weather?"),
        tools,
        [],
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-1" },
      ),
    );

    expect(tools.messages).toEqual([]);
    expect(tools.events).toEqual([
      {
        content: "session service unavailable",
        messageType: "error",
        metadata: {
          failure: { provider: "google-adk", code: null, message: "session service unavailable", detail: null },
        },
      },
    ]);
  });
});
