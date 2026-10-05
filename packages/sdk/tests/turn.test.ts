import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bandToolEffects, noReplyTool } from "@band-ai/band-sdk-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import * as adapters from "../src/adapters";
import { acpToolCallName, recordBandToolCalls } from "../src/adapters/acp/toolCalls";
import type { CollectedChunk } from "../src/adapters/acp/types";
import { replyToSender } from "../src/adapters/shared/replyToSender";
import type { AgentToolsRestApi } from "../src/client/rest/types";
import type { AdapterToolsProtocol } from "../src/contracts/protocols";
import {
  ALL_TOOL_NAMES,
  NO_REPLY_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  TOOL_MODELS,
  resolveBandToolName,
} from "../src/contracts/toolSchemas";
import { SYNTHETIC_CONTACT_EVENTS_SENDER_ID, SYNTHETIC_SENDER_TYPE } from "../src/contracts/protocols";
import { deliverReply } from "../src/core/deliveryFailedError";
import { agentFailure } from "../src/core/providerFailure";
import { SimpleAdapter } from "../src/core/simpleAdapter";
import { relayReply, reportUnsettledTurn, trackTurn, Turn, type TurnTools } from "../src/core/turn";
import { buildSingleContextRegistrations, resolveSingleRoomTools } from "../src/mcp/registrations";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { buildCustomToolIndex, CustomToolDefinitionError, executeCustomTool, type CustomToolDef } from "../src/runtime/tools/customTools";
import { FakeRestApi, FakeTools, makeLoggerSpy, makeMessage, makeRoster, MISSING_REPLY, reportedFailures } from "./testUtils";
import { TURN_OUTCOME_ADAPTERS, TURN_OUTCOME_EXEMPT, turnInput } from "./turnOutcomeContract";

const JANE = [{ id: "u1" }];

/** Real `AgentTools` over `FakeRestApi`, with `rest` overriding (or adding) REST calls. */
function agentTools(rest: Partial<AgentToolsRestApi> = {}): AdapterToolsProtocol {
  return new AgentTools({
    roomId: "room-1",
    rest: Object.assign(new FakeRestApi(), rest),
    roster: makeRoster([{ id: "u1", handle: "@jane", name: "Jane", type: "User" }]),
  }).getAdapterTools();
}

const MEMORY = { id: "m1", content: "c", system: "long_term", type: "semantic", segment: "agent", thought: "why" };
const storesMemory = { storeMemory: async () => MEMORY } as unknown as Partial<AgentToolsRestApi>;

describe("band_no_reply and the tool table", () => {
  it("covers every TS tool with core's effect table", () => {
    const effects = bandToolEffects();
    expect([...ALL_TOOL_NAMES].filter((name) => !Object.hasOwn(effects, name))).toEqual([]);
  });

  it("builds band_no_reply from core's definition", () => {
    const spec = noReplyTool();
    const [reason] = spec.parameters;
    const model = TOOL_MODELS[NO_REPLY_TOOL_NAME];

    expect(spec.name).toBe(NO_REPLY_TOOL_NAME);
    expect(model.description).toBe(spec.description);
    expect(model.properties).toEqual({ [reason!.name]: { type: "string", description: reason!.description } });
    expect(reason!.required).toBe(false);
    expect(model.required).toEqual([]);
  });

  it("answers band_no_reply without posting anything", async () => {
    const createChatMessage = vi.fn(async () => ({}));
    const result = await agentTools({ createChatMessage }).executeToolCall(NO_REPLY_TOOL_NAME, { reason: "FYI" });

    expect(result).toEqual({ status: "ok" });
    expect(createChatMessage).not.toHaveBeenCalled();
  });
});

describe("trackTurn", () => {
  it.each<[string, (tools: AdapterToolsProtocol) => Promise<unknown>]>([
    ["a model tool call", (tools) => tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "Hi", mentions: JANE })],
    ["a direct sendMessage", (tools) => tools.sendMessage("Hi", JANE)],
    ["deliverReply", (tools) => deliverReply(tools, "Hi", JANE)],
  ])("records a reply made through %s", async (_path, reply) => {
    const tools = trackTurn(agentTools());
    await reply(tools);

    expect(tools.turn.replied).toBe(true);
    expect(tools.turn.verdict()).toBe("complete");
  });

  it("records a direct storeMemory as an act", async () => {
    const tools = trackTurn(agentTools(storesMemory));
    await tools.storeMemory!({ content: "c", thought: "why", system: "long_term", type: "semantic", segment: "agent" });

    expect(tools.turn.verdict()).toBe("complete");
    expect(tools.turn.replied).toBe(false);
  });

  it("records a decline through band_no_reply", async () => {
    const tools = trackTurn(agentTools());
    await tools.executeToolCall(NO_REPLY_TOOL_NAME, {});

    expect(tools.turn.replied).toBe(true);
    expect(tools.turn.verdict()).toBe("complete");
  });

  it.each<[string, Partial<AgentToolsRestApi>, (tools: AdapterToolsProtocol) => Promise<unknown>]>([
    ["an invalid tool call", {}, (tools) => tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "Hi" })],
    ["a send the platform answers { ok: false }", { createChatMessage: async () => ({ ok: false }) }, (tools) => tools.sendMessage("Hi", JANE)],
    ["a blank send", {}, (tools) => tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "  ", mentions: JANE })],
    ["a notice", {}, (tools) => tools.sendNotice("Busy, try again", JANE)],
    ["replyToSender", {}, (tools) => replyToSender(tools, "Busy, try again", "u1")],
  ])("records nothing for %s", async (_path, rest, call) => {
    const tools = trackTurn(agentTools(rest));
    await call(tools);

    expect(tools.turn.verdict()).toBe("missing_reply");
  });

  it("records nothing for a send that rejects", async () => {
    const tools = trackTurn(agentTools({ createChatMessage: async () => { throw new Error("down"); } }));
    await expect(tools.sendMessage("Hi", JANE)).rejects.toThrow("down");

    expect(tools.turn.verdict()).toBe("missing_reply");
  });

  it("leaves a turn that only narrated through sendEvent unanswered", async () => {
    const tools = trackTurn(agentTools());
    await tools.sendEvent("Looking into it", "thought");

    expect(tools.turn.verdict()).toBe("missing_reply");
  });

  it("notes a failure reported only once its post landed", async () => {
    const failing = trackTurn(agentTools({ createChatEvent: async () => { throw new Error("down"); } }));
    await failing.sendFailure(agentFailure("custom", "boom"));
    expect(failing.turn.verdict()).toBe("missing_reply");

    const posted = trackTurn(agentTools());
    await posted.sendFailure(agentFailure("custom", "boom"));
    expect(posted.turn.verdict()).toBe("complete");
  });

  it("gives each turn its own ledger", async () => {
    const shared = agentTools();
    const first = trackTurn(shared);
    const second = trackTurn(shared);
    await first.sendMessage("Hi", JANE);

    expect(second.turn.verdict()).toBe("missing_reply");
  });
});

/** Detaches every turn, as OpenCode and Cursor do when they park one on a decision. */
class Parking extends SimpleAdapter<unknown> {
  protected readonly provider = "parking";
  public parked: TurnTools | undefined;

  public async onMessage(_message: unknown, tools: TurnTools): Promise<void> {
    tools.turn.detach();
    this.parked = tools;
  }
}

describe("detached turns", () => {
  async function reportAtRealEnd(message = makeMessage("Hello")): Promise<FakeTools> {
    const tools = new FakeTools();
    const adapter = new Parking();
    await adapter.onEvent(turnInput(tools, message));
    await reportUnsettledTurn(adapter.parked!, makeLoggerSpy(), { roomId: message.roomId });
    return tools;
  }

  it("reports a judged turn that ends without a reply once, at its real end", async () => {
    expect(reportedFailures((await reportAtRealEnd()).events)).toEqual([MISSING_REPLY]);
  });

  it("never reports a synthetic turn, which onEvent would not have judged", async () => {
    const synthetic = { ...makeMessage("contact event"), senderType: SYNTHETIC_SENDER_TYPE, senderId: SYNTHETIC_CONTACT_EVENTS_SENDER_ID };
    expect(reportedFailures((await reportAtRealEnd(synthetic)).events)).toEqual([]);
  });
});

describe("relayReply", () => {
  it("relays the closing text of a turn that has not replied", async () => {
    const tools = trackTurn(new FakeTools());

    expect(await relayReply(tools, "Closing text", JANE)).toBe(true);
    expect(tools.messages).toEqual(["Closing text"]);
    expect(tools.turn.replied).toBe(true);
  });

  it.each([
    ["replied", SEND_MESSAGE_TOOL_NAME, { content: "Hi", mentions: JANE }],
    ["declined", NO_REPLY_TOOL_NAME, {}],
  ])("skips a turn that already %s", async (_how, toolName, args) => {
    const tools = trackTurn(new FakeTools());
    await tools.executeToolCall(toolName, args);

    expect(await relayReply(tools, "Closing text", JANE)).toBe(false);
    expect(tools.messages).toEqual([]);
  });

  // The platform's rule: a zero-width space alone is blank, though trim() keeps it.
  it.each([["whitespace", "  "], ["a zero-width space", "\u200B"]])("skips %s, which the platform refuses as blank", async (_case, text) => {
    const tools = trackTurn(new FakeTools());

    expect(await relayReply(tools, text, JANE)).toBe(false);
    expect(tools.turn.verdict()).toBe("missing_reply");
  });
});

describe("custom tool effect", () => {
  const tool = (effect?: CustomToolDef["effect"]): CustomToolDef => ({
    name: "lookup",
    schema: z.object({}),
    handler: () => "done",
    ...(effect ? { effect } : {}),
  });

  it("records the effect a custom tool declares", async () => {
    const turn = new Turn();
    await executeCustomTool(tool("act"), {}, turn);

    expect(turn.verdict()).toBe("complete");
  });

  it("records an undeclared custom tool as observe", async () => {
    const turn = new Turn();
    await executeCustomTool(tool(), {}, turn);

    expect(turn.verdict()).toBe("missing_reply");
  });

  it("records nothing for a custom tool that throws", async () => {
    const turn = new Turn();
    const failing: CustomToolDef = { ...tool("act"), handler: () => { throw new Error("boom"); } };
    await expect(executeCustomTool(failing, {}, turn)).rejects.toThrow("boom");

    expect(turn.verdict()).toBe("missing_reply");
  });

  // An untyped caller's typo: refused when indexed, and before the side effect when run.
  it("refuses an effect core doesn't know, before its handler runs", async () => {
    const handler = vi.fn(() => "filed");
    const misspelled = { ...tool(), handler, effect: "acts" } as unknown as CustomToolDef;

    expect(() => buildCustomToolIndex([misspelled])).toThrow(CustomToolDefinitionError);
    await expect(executeCustomTool(misspelled, {}, new Turn())).rejects.toThrow(CustomToolDefinitionError);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("single-room MCP tools", () => {
  it("reach the turn in flight, not the turn the connection started with", async () => {
    let current = trackTurn(new FakeTools());
    const first = current;
    const tools = resolveSingleRoomTools(() => current);
    const [send] = buildSingleContextRegistrations(tools)
      .filter((registration) => registration.name === SEND_MESSAGE_TOOL_NAME);
    current = trackTurn(new FakeTools());

    await send!.execute({ content: "Hi", mentions: JANE });

    expect(current.turn.replied).toBe(true);
    expect(first.turn.replied).toBe(false);
    // A consumer that checks or spreads the tools sees the turn's, not an empty forwarder.
    expect("turn" in tools).toBe(true);
    expect(Object.keys(tools)).toContain("turn");
  });
});

describe("out-of-process Band tool names", () => {
  it.each([
    ["band_send_message", "band_send_message"],
    ["band-band_send_message", "band_send_message"],
    ["create_agent_chat_message", "band_send_message"],
    ["band-create_agent_chat_message", "band_send_message"],
    ["band-band_no_reply", "band_no_reply"],
    ["other-band_send_message", undefined],
    ["Write notes.md", undefined],
  ])("%s resolves to %s", (name, expected) => {
    expect(resolveBandToolName(name)).toBe(expected);
  });

  const toolCall = (metadata: Record<string, unknown>, title = "Calling a tool"): CollectedChunk => ({
    chunkType: "tool_call",
    content: title,
    metadata: { tool_call_id: "call-1", status: "completed", ...metadata },
    streamed: false,
  });

  it.each([
    ["codex-acp", { server: "band", tool: "band_send_message", arguments: { content: "Hi" } }],
    ["Cursor", { providerIdentifier: "band", toolName: "band_send_message", args: { content: "Hi" } }],
  ])("reads %s's MCP invocation from raw_input", (_runtime, rawInput) => {
    expect(resolveBandToolName(acpToolCallName(rawInput, "Calling a tool"))).toBe(SEND_MESSAGE_TOOL_NAME);
  });

  it("falls back to the title when raw_input is not an MCP invocation", () => {
    expect(acpToolCallName({ path: "notes.md" }, "band-band_send_message")).toBe("band-band_send_message");
  });

  it("records a call that completes on its own tool_result", () => {
    const turn = new Turn();
    recordBandToolCalls([
      toolCall({ status: "pending" }, "band-band_send_message"),
      { chunkType: "tool_result", content: "ok", metadata: { tool_call_id: "call-1", status: "completed" }, streamed: false },
    ], turn);

    expect(turn.replied).toBe(true);
  });

  it("never correlates an id-less result with a call", () => {
    const turn = new Turn();
    recordBandToolCalls([
      toolCall({ tool_call_id: "", status: "pending" }, "band-band_send_message"),
      { chunkType: "tool_result", content: "ok", metadata: { tool_call_id: "", status: "completed" }, streamed: false },
    ], turn);

    expect(turn.verdict()).toBe("missing_reply");
  });

  it("records nothing for a failed call", () => {
    const turn = new Turn();
    recordBandToolCalls([toolCall({ status: "failed" }, "band-band_send_message")], turn);

    expect(turn.verdict()).toBe("missing_reply");
  });
});

describe("turn-outcome registry", () => {
  type AdapterClass = abstract new (...args: never[]) => SimpleAdapter<unknown, unknown>;
  const simpleAdapters = Object.entries<unknown>(adapters).filter(
    (entry): entry is [string, AdapterClass] => typeof entry[1] === "function" && entry[1].prototype instanceof SimpleAdapter,
  );
  // `judgesTurns` read on a bare instance: what the class decides before any option is set.
  const judgesTurns = (adapter: AdapterClass) => Reflect.get(adapter.prototype, "judgesTurns", Object.create(adapter.prototype) as object) as boolean;

  it("accounts for every SimpleAdapter the package exports, as judged or exempt", () => {
    const names = simpleAdapters.map(([name]) => name);

    expect(names.filter((name) => !Object.hasOwn(TURN_OUTCOME_ADAPTERS, name) && !TURN_OUTCOME_EXEMPT.has(name))).toEqual([]);
    expect(Object.keys(TURN_OUTCOME_ADAPTERS).filter((name) => !names.includes(name))).toEqual([]);
  });

  // A flow test drives the room end to end instead, its rows from `contractRows`.
  const RUNS_CONTRACT = /describeTurnOutcomeContract\(|contractRows[<(]/;

  it("runs the contract for every registered adapter: in a file that names it, or its parent's if it only configures that parent", () => {
    for (const [name, adapter] of simpleAdapters) {
      const file = TURN_OUTCOME_ADAPTERS[name];
      if (!file) {
        continue;
      }
      const source = readFileSync(join(__dirname, file), "utf8");
      expect(source, file).toMatch(RUNS_CONTRACT);
      if (!source.includes(name)) {
        const parent = Object.getPrototypeOf(adapter) as AdapterClass;
        expect(TURN_OUTCOME_ADAPTERS[parent.name], `${name} shares its parent's file`).toBe(file);
        expect(Object.hasOwn(adapter.prototype, "onMessage"), `${name} handles turns itself, so needs its own contract run`).toBe(false);
      }
    }
  });

  it("judges exactly the registered adapters", () => {
    for (const [name, adapter] of simpleAdapters) {
      expect(judgesTurns(adapter), name).toBe(!TURN_OUTCOME_EXEMPT.has(name));
    }
  });
});
