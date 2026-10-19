import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { Annotation, StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { RunnableLambda } from "@langchain/core/runnables";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { AIMessage } from "@langchain/core/messages";
import { AnthropicAdapter, GeminiAdapter, OpenAIAdapter, VercelAISDKAdapter } from "../src/adapters";
import { LangGraphAdapter } from "../src/adapters/langgraph";
import { GoogleADKAdapter } from "../src/adapters/google-adk";
import type { FrameworkAdapter } from "../src/contracts/protocols";
import type { CustomToolDef } from "../src/runtime/tools/customTools";
import { createDeferred, type Deferred } from "../src/core/deferred";
import { BandPlatform, person } from "./flows/support/bandPlatform";
import { recordRuntimeActivity } from "./support/activityReports";
import { SlowFailureRest } from "./support/slowFailureRest";
import { createFakeGoogleAdkSdk, createRealEventGoogleAdkSdk } from "./helpers/fakeGoogleAdkSdk";

const NAME = "lookup_weather";
const MARKER = "private-argument-sentinel";
const RESULT = "12C";
const ANSWER = "The weather is 12C.";
const ROOT_START = { event: "on_chain_start", name: "graph", run_id: "root" };

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
  { name: "Google ADK local", create: (tool, narration) => new GoogleADKAdapter({
    additionalTools: [tool], enableExecutionReporting: narration,
    sdkFactory: createFakeGoogleAdkSdk(async function* (agent) {
      const local = (agent.tools as Array<{ name: string; execute: (args: unknown) => Promise<unknown> }>).find(({ name }) => name === NAME)!;
      yield { functionCalls: [{ id: "local", name: NAME, args: { query: MARKER } }] };
      expect(await local.execute({ query: MARKER })).toBe(RESULT);
      yield { functionResponses: [{ id: "local", name: NAME, response: { result: RESULT } }] };
      yield { final: true, text: ANSWER };
    }),
  }) },
  { name: "LangGraph local", create: (tool, narration) => new LangGraphAdapter({
    customTools: [tool], emitExecutionEvents: narration,
    graphFactory: (tools) => ({ async *streamEvents() {
      const local = (tools as Array<{ name: string; invoke: (args: unknown) => Promise<unknown> }>).find(({ name }) => name === NAME)!;
      yield ROOT_START;
      yield { event: "on_tool_start", name: NAME, run_id: "local", data: { input: { query: MARKER } } };
      expect(await local.invoke({ query: MARKER })).toBe(RESULT);
      yield { event: "on_tool_end", name: NAME, run_id: "local", data: { output: RESULT } };
      yield { event: "on_chain_end", run_id: "root", name: "graph", data: { output: { messages: [["assistant", ANSWER]] } } };
    } }),
  }) },
];

/** A held custom-tool turn in a room with working state on or off; narration is the inverse of working state. */
async function heldWeatherTurn(create: (tool: CustomToolDef, narration: boolean) => FrameworkAdapter, workingState: boolean) {
  const entered = createDeferred();
  const release = createDeferred();
  onTestFinished(() => release.resolve());
  const reports = recordRuntimeActivity();
  const tool: CustomToolDef = { name: NAME, description: "Weather lookup", schema: z.object({ query: z.string() }),
    handler: async ({ query }) => { entered.resolve(); await release.promise; expect(query).toBe(MARKER); return RESULT; },
  };
  const platform = await BandPlatform.start(create(tool, !workingState), [person("owner")], undefined, { enableWorkingState: workingState });
  onTestFinished(() => platform[Symbol.asyncDispose]());
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
  };
}

describe.each(families)("$name scoped custom execution", ({ create }) => {
  it("reports scoped activity instead of narrating the tool", async () => {
    const turn = await heldWeatherTurn(create, true);
    await turn.reports.next((entry) => entry.activity?.kind === "tool_call" && entry.activity.name === NAME);
    await turn.finish();
    expect(turn.reports.entries.map(({ working, activity }) => working ? activity : false)).toEqual([
      { kind: "reasoning" }, { kind: "tool_call", name: NAME }, { kind: "reasoning" }, false,
    ]);
    expect([...turn.room.events("tool_call"), ...turn.room.events("tool_result")]).toEqual([]);
    expect(JSON.stringify(turn.reports.entries)).not.toContain(MARKER);
  });

  it("narrates the tool and reports nothing with working state off", async () => {
    const turn = await heldWeatherTurn(create, false);
    expect(turn.reports.entries).toEqual([]);
    await turn.finish();
    expect(turn.reports.entries).toEqual([]);
    expect(turn.room.events("tool_call")).toHaveLength(1);
    expect(turn.room.events("tool_result")).toHaveLength(1);
  });
});

describe("streamed native tool activity", () => {
  it.each(["native_get_participants", "band_get_participants"])("observes caller-owned static LangGraph tool %s", async (name) => {
    const entered = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    let calls = 0;
    const nativeTool = tool(async ({ query }: { query: string }) => {
      expect(query).toBe(MARKER);
      calls++;
      entered.resolve();
      await release.promise;
      return RESULT;
    }, { name, description: "Graph-owned participant lookup", schema: z.object({ query: z.string() }) });
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("request", () => ({ messages: [new AIMessage({
        content: "", tool_calls: [{ id: "call-real", name, args: { query: MARKER } }],
      })] }))
      .addNode("tools", new ToolNode([nativeTool]))
      .addNode("answer", (state) => {
        expect(state.messages.at(-1)?.content).toBe(RESULT);
        return { messages: [new AIMessage(ANSWER)] };
      })
      .addEdge(START, "request").addEdge("request", "tools")
      .addEdge("tools", "answer").addEdge("answer", END).compile();
    const reports = recordRuntimeActivity();
    const adapter = new LangGraphAdapter({ graph, emitExecutionEvents: true });
    await using session = await BandPlatform.join(adapter, [person("owner")]);
    const message = await session.room.say("owner", "lookup participants");
    await entered.promise;
    await reports.next((entry) => entry.activity?.kind === "tool_call" && entry.activity.name === name);
    release.resolve();
    expect(await session.room.outcome(message)).toBe("processed");
    expect(calls).toBe(1);
    expect(session.room.messages.map(({ content }) => content)).toEqual([ANSWER]);
    expect(session.room.events("tool_result").some((event) => JSON.parse(event.content).output === RESULT)).toBe(true);
    expect(reports.entries.map(({ working, activity }) => working ? activity : false)).toEqual([
      { kind: "reasoning" }, { kind: "tool_call", name }, { kind: "reasoning" }, false,
    ]);
    expect(JSON.stringify(reports.entries)).not.toContain(MARKER);
  });

  it.each(["on_tool_end", "on_tool_error"])("LangGraph observes starts and %s before narration gating", async (terminal) => {
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const reports = recordRuntimeActivity();
    const adapter = new LangGraphAdapter({ emitExecutionEvents: false, graph: {
      async *streamEvents() {
        yield ROOT_START;
        yield { event: "on_tool_start", name: "native_lookup", run_id: "native", data: { input: { query: MARKER } } };
        await release.promise;
        yield { event: terminal, name: "native_lookup", run_id: "native", data: { output: RESULT } };
        yield { event: "on_chain_end", run_id: "root", name: "graph", data: { output: { messages: [["assistant", ANSWER]] } } };
      },
      async invoke() { throw new Error("stream-capable graph must not be invoked a second time"); },
    } });
    await using session = await BandPlatform.join(adapter, [person("owner")]);
    const message = await session.room.say("owner", "weather?");
    await reports.next((entry) => entry.activity?.kind === "tool_call");
    release.resolve();
    expect(await session.room.outcome(message)).toBe("processed");
    expect(session.room.messages.map(({ content }) => content)).toEqual([ANSWER]);
    expect(reports.entries.map(({ working, activity }) => working ? activity : false)).toEqual([
      { kind: "reasoning" }, { kind: "tool_call", name: "native_lookup" }, { kind: "reasoning" }, false,
    ]);
    expect([...session.room.events("tool_call"), ...session.room.events("tool_result")]).toEqual([]);
    expect(JSON.stringify(reports.entries)).not.toContain(MARKER);
  });
});

const NATIVE = "native_lookup";
/** A heartbeat republishes the current activity, which is how a test reads the slot without waiting on a timer of its own. */
const KEEPALIVE = { workingKeepAliveSeconds: 0.02, workingRequestTimeoutSeconds: 0.01 };
const activitySequence = (reports: ReturnType<typeof recordRuntimeActivity>) => reports.entries.map(({ working, activity }) => working ? activity : false);

interface NativeEvents { start: unknown[]; unrelatedEnd: unknown; end: unknown; answer: unknown[] }
interface NativeGates { processed: Deferred; release: Deferred; fail: boolean }

/** A provider turn that starts native work, passes an unrelated end, holds, then finishes or fails. */
async function* nativeTurn(events: NativeEvents, gates: NativeGates) {
  yield* events.start;
  yield events.unrelatedEnd;
  gates.processed.resolve();
  await gates.release.promise;
  if (gates.fail) throw new Error("provider connection reset");
  yield events.end;
  yield* events.answer;
}

const nativeFamilies: Array<{ name: string; create: (events: NativeEvents, gates: NativeGates) => FrameworkAdapter }> = [
  { name: "Google ADK", create: (events, gates) => new GoogleADKAdapter({ enableExecutionReporting: false,
    sdkFactory: createRealEventGoogleAdkSdk(() => nativeTurn(events, gates)) }) },
  { name: "LangGraph", create: (events, gates) => new LangGraphAdapter({ emitExecutionEvents: false,
    graph: { streamEvents: () => nativeTurn(events, gates) } }) },
];

const adkEvent = (part: unknown) => ({ actions: {}, content: { parts: [part] } });
const nativeEvents: Record<string, NativeEvents> = {
  "Google ADK": {
    start: [adkEvent({ functionCall: { id: "native", name: NATIVE, args: { query: MARKER } } })],
    unrelatedEnd: adkEvent({ functionResponse: { id: "unrelated", name: "old_lookup", response: {} } }),
    end: adkEvent({ functionResponse: { id: "native", name: NATIVE, response: { result: RESULT } } }),
    answer: [adkEvent({ text: ANSWER })],
  },
  LangGraph: {
    start: [ROOT_START, { event: "on_tool_start", name: NATIVE, run_id: "native", data: { input: { query: MARKER } } }],
    unrelatedEnd: { event: "on_tool_end", name: "other_tool", run_id: "unrelated", data: { output: RESULT } },
    end: { event: "on_tool_end", name: NATIVE, run_id: "native", data: { output: RESULT } },
    answer: [{ event: "on_chain_end", run_id: "root", name: "graph", data: { output: { messages: [["assistant", ANSWER]] } } }],
  },
};

describe.each(nativeFamilies)("$name native activity across a turn", ({ name, create }) => {
  const events = nativeEvents[name]!;
  const gates = (fail: boolean): NativeGates => {
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    return { processed: createDeferred(), release, fail };
  };

  it("keeps a native tool active when an unrelated call ends, and ends it with its own response", async () => {
    const held = gates(false);
    const reports = recordRuntimeActivity();
    const platform = await BandPlatform.start(create(events, held), [person("owner")], undefined, { enableWorkingState: true, ...KEEPALIVE });
    onTestFinished(() => platform[Symbol.asyncDispose]());
    const room = await platform.room("room-1");
    const message = await room.say("owner", "weather?");
    await held.processed.promise;
    const heartbeat = await reports.next(() => true, reports.entries.length);
    expect(heartbeat.activity).toEqual({ kind: "tool_call", name: NATIVE });
    held.release.resolve();
    expect(await room.outcome(message)).toBe("processed");
    expect(room.messages.map(({ content }) => content)).toEqual([ANSWER]);
    expect(activitySequence(reports).at(-2)).toEqual({ kind: "reasoning" });
  });

  it("ends a native tool the provider never finished before the failure is reported", async () => {
    const held = gates(true);
    const reports = recordRuntimeActivity();
    const rest = new SlowFailureRest([person("owner")]);
    onTestFinished(() => rest.gate.resolve());
    const platform = await BandPlatform.start(create(events, held), [person("owner")], rest, { enableWorkingState: true, ...KEEPALIVE });
    onTestFinished(() => platform[Symbol.asyncDispose]());
    const room = await platform.room("room-1");
    const message = await room.say("owner", "weather?");
    await held.processed.promise;
    held.release.resolve();
    await rest.failurePosting.promise;
    const heartbeat = await reports.next(() => true, reports.entries.length);
    expect(heartbeat.activity).toEqual({ kind: "reasoning" });
    rest.gate.resolve();
    expect(await room.outcome(message)).toBe("failed");
  });
});

describe("a local wrapper that rejects before running", () => {
  const localFamilies: Array<{ name: string; create: (tool: CustomToolDef, rejected: Deferred, hold: Deferred) => FrameworkAdapter }> = [
    { name: "Google ADK", create: (tool, rejected, hold) => new GoogleADKAdapter({ additionalTools: [tool], enableExecutionReporting: false,
      sdkFactory: createFakeGoogleAdkSdk(async function* (agent) {
        const local = (agent.tools as Array<{ name: string; execute: (args: unknown) => Promise<unknown> }>).find(({ name }) => name === NAME)!;
        yield { functionCalls: [{ id: "local", name: NAME, args: {} }] };
        await expect(local.execute({})).rejects.toThrow();
        rejected.resolve();
        await hold.promise;
      }) }) },
    { name: "LangGraph", create: (tool, rejected, hold) => new LangGraphAdapter({ customTools: [tool], emitExecutionEvents: false,
      graphFactory: (tools) => ({ async *streamEvents() {
        const local = (tools as Array<{ name: string; invoke: (args: unknown) => Promise<unknown> }>).find(({ name }) => name === NAME)!;
        yield ROOT_START;
        yield { event: "on_tool_start", name: NAME, run_id: "local", data: { input: {} } };
        await expect(local.invoke({})).rejects.toThrow();
        rejected.resolve();
        await hold.promise;
      } }) }) },
  ];

  it.each(localFamilies)("$name reports no native activity for it", async ({ create }) => {
    const rejected = createDeferred();
    const hold = createDeferred();
    const reports = recordRuntimeActivity();
    const tool: CustomToolDef = { name: NAME, description: "Weather lookup", schema: z.object({ query: z.string() }), handler: async () => RESULT };
    const platform = await BandPlatform.start(create(tool, rejected, hold), [person("owner")], undefined, { enableWorkingState: true, ...KEEPALIVE });
    onTestFinished(() => platform[Symbol.asyncDispose]());
    onTestFinished(() => hold.resolve());
    const room = await platform.room("room-1");
    await room.say("owner", "weather?");
    await rejected.promise;
    const heartbeat = await reports.next(() => true, reports.entries.length);
    expect(heartbeat.activity).toEqual({ kind: "reasoning" });
  });
});

describe("LangGraph reply from the stream", () => {
  it("posts what invoke would, not the output of a nested chain", async () => {
    const State = Annotation.Root({ ...MessagesAnnotation.spec, answer: Annotation<string>() });
    const router = RunnableLambda.from(async () => "billing");
    const graph = new StateGraph(State)
      .addNode("route", async (_state, config) => { await router.invoke("question", config); return {}; })
      .addNode("respond", () => ({ answer: "Your invoice is attached." }))
      .addEdge(START, "route").addEdge("route", "respond").addEdge("respond", END).compile();
    const adapter = new LangGraphAdapter({ graph, emitExecutionEvents: false });
    await using session = await BandPlatform.join(adapter, [person("owner")]);
    const message = await session.room.say("owner", "invoice?");
    expect(await session.room.outcome(message)).toBe("processed");
    expect(session.room.messages).toEqual([]);
  });
});
