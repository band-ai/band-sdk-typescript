import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GoogleADKAdapter } from "../src/adapters";
import { GoogleADKHistoryConverter } from "../src/converters";
import type { AgentToolsProtocol } from "../src/core";
import { FakeTools, makeMessage } from "./testUtils";

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

function createFakeGoogleAdkSdk(
  run: (agent: Record<string, unknown>, request: { userId: string; sessionId: string; newMessage: { role: "user"; parts: Array<{ text: string }> } }) => AsyncIterable<unknown>,
): () => Promise<any> {
  return async () => ({
    createAgent: (params: Record<string, unknown>) => params,
    createFunctionTool: (params: Record<string, unknown>) => params,
    createRunner: ({ agent }: { agent: Record<string, unknown> }) => ({
      sessionService: {
        createSession: async () => ({ ok: true }),
      },
      runAsync: (request: { userId: string; sessionId: string; newMessage: { role: "user"; parts: Array<{ text: string }> } }) => run(agent, request),
    }),
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
});
