import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GoogleADKAdapter } from "../src/adapters";
import { GoogleADKHistoryConverter } from "../src/converters";
import type { AgentToolsProtocol } from "../src/core";
import { expectNoVisibleReplySent, FakeTools, makeMessage } from "./testUtils";

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

function createFakeGoogleAdkSdk(
  run: (agent: Record<string, unknown>, request: { userId: string; sessionId: string; newMessage: { role: "user"; parts: Array<{ text: string }> } }) => AsyncIterable<unknown>,
  capture?: GoogleAdkCapture,
): () => Promise<any> {
  return async () => ({
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

  it("does not send an invisible-only final response", async () => {
    const tools = new GoogleAdkTestTools();

    const adapter = new GoogleADKAdapter({
      sdkFactory: createFakeGoogleAdkSdk(async function* () {
        yield { final: true, text: "​" };
      }),
    });

    await adapter.onStarted("Weather Agent", "Answers weather questions");
    await expect(
      adapter.onMessage(
        makeMessage("say nothing visible"),
        tools,
        [],
        null,
        null,
        { isSessionBootstrap: true, roomId: "room-invisible-reply" },
      ),
    ).resolves.toBeUndefined();

    expectNoVisibleReplySent(tools);
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
});
