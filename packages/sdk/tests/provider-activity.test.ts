import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { AnthropicAdapter, GeminiAdapter, OpenAIAdapter, VercelAISDKAdapter } from "../src/adapters";
import type { FrameworkAdapter } from "../src/contracts/protocols";
import type { CustomToolDef } from "../src/runtime/tools/customTools";
import { createDeferred } from "../src/core/deferred";
import { BandPlatform, person } from "./flows/support/bandPlatform";
import { recordRuntimeActivity } from "./support/activityReports";

const NAME = "lookup_weather";
const MARKER = "private-argument-sentinel";
const RESULT = "12C";
const ANSWER = "The weather is 12C.";

const families: Array<{ name: string; create: (tool: CustomToolDef, narration: boolean) => FrameworkAdapter }> = [
  { name: "Anthropic", create: (tool, narration) => {
    let round = 0;
    return new AnthropicAdapter({ customTools: [tool], enableExecutionReporting: narration,
      clientFactory: async () => ({ messages: { create: async (params) => {
        if (++round === 1) return { content: [{ type: "tool_use", id: "call", name: NAME, input: { query: MARKER } }] };
        expect(JSON.stringify(params)).toContain(RESULT);
        return { content: [{ type: "text", text: ANSWER }] };
      } } }),
    });
  } },
  { name: "OpenAI", create: (tool, narration) => {
    let round = 0;
    return new OpenAIAdapter({ customTools: [tool], enableExecutionReporting: narration,
      clientFactory: async () => ({ chat: { completions: { create: async (params) => {
        if (++round === 1) return { choices: [{ message: { tool_calls: [{ id: "call", type: "function", function: { name: NAME, arguments: JSON.stringify({ query: MARKER }) } }] } }] };
        expect(JSON.stringify(params)).toContain(RESULT);
        return { choices: [{ message: { content: ANSWER } }] };
      } } } }),
    });
  } },
  { name: "Gemini", create: (tool, narration) => {
    let round = 0;
    return new GeminiAdapter({ customTools: [tool], enableExecutionReporting: narration,
      clientFactory: async () => ({ models: { generateContent: async (params) => {
        if (++round === 1) return { functionCalls: [{ id: "call", name: NAME, args: { query: MARKER } }] };
        expect(JSON.stringify(params)).toContain(RESULT);
        return { text: ANSWER };
      } } }),
    });
  } },
  { name: "Vercel AI", create: (tool, narration) => {
    let round = 0;
    return new VercelAISDKAdapter({ model: { id: "fixture" }, customTools: [tool], enableExecutionReporting: narration,
      toolFactory: (definition) => definition,
      generateText: async (params) => {
        if (++round === 1) return { toolCalls: [{ toolCallId: "call", toolName: NAME, input: { query: MARKER } }] };
        expect(JSON.stringify(params)).toContain(RESULT);
        return { text: ANSWER };
      },
    });
  } },
];

/** A held custom-tool turn in a room with working state on or off; narration is the inverse of working state. */
async function heldWeatherTurn(create: (tool: CustomToolDef, narration: boolean) => FrameworkAdapter, workingState: boolean) {
  const entered = createDeferred();
  const release = createDeferred();
  onTestFinished(() => release.resolve());
  const reports = recordRuntimeActivity();
  const tool: CustomToolDef = { name: NAME, description: "Weather lookup", schema: z.object({ query: z.string() }),
    handler: async ({ query }) => { expect(query).toBe(MARKER); entered.resolve(); await release.promise; return RESULT; },
  };
  const platform = await BandPlatform.start(create(tool, !workingState), [person("owner")], undefined, { enableWorkingState: workingState });
  const room = await platform.room("room-1");
  const message = await room.say("owner", "weather?");
  await entered.promise;
  return {
    room, reports,
    async finish() {
      release.resolve();
      expect(await room.outcome(message)).toBe("processed");
      expect(room.messages.map(({ content }) => content)).toEqual([ANSWER]);
    },
    async [Symbol.asyncDispose]() { await platform[Symbol.asyncDispose](); },
  };
}

describe.each(families)("$name scoped custom execution", ({ create }) => {
  it("reports scoped activity instead of narrating the tool", async () => {
    await using turn = await heldWeatherTurn(create, true);
    await turn.reports.next((entry) => entry.activity?.kind === "tool_call" && entry.activity.name === NAME);
    await turn.finish();
    expect(turn.reports.entries.map(({ working, activity }) => working ? activity : false)).toEqual([
      { kind: "reasoning" }, { kind: "tool_call", name: NAME }, { kind: "reasoning" }, false,
    ]);
    expect([...turn.room.events("tool_call"), ...turn.room.events("tool_result")]).toEqual([]);
    expect(JSON.stringify(turn.reports.entries)).not.toContain(MARKER);
  });

  it("narrates the tool and reports nothing with working state off", async () => {
    await using turn = await heldWeatherTurn(create, false);
    expect(turn.reports.entries).toEqual([]);
    await turn.finish();
    expect(turn.reports.entries).toEqual([]);
    expect(turn.room.events("tool_call")).toHaveLength(1);
    expect(turn.room.events("tool_result")).toHaveLength(1);
  });
});
