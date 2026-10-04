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
  TOOL_METHODS,
  TOOL_MODELS,
  resolveBandToolName,
  type ToolName,
} from "../src/contracts/toolSchemas";
import { deliverReply } from "../src/core/deliveryFailedError";
import { agentFailure } from "../src/core/providerFailure";
import { SimpleAdapter } from "../src/core/simpleAdapter";
import { relayReply, trackTurn, Turn } from "../src/core/turn";
import { buildSingleContextRegistrations, resolveSingleRoomTools } from "../src/mcp/registrations";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { executeCustomTool, type CustomToolDef } from "../src/runtime/tools/customTools";
import { FakeRestApi, FakeTools, makeRoster } from "./testUtils";
import { TURN_OUTCOME_ADAPTERS, TURN_OUTCOME_EXEMPT } from "./turnOutcomeContract";

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

  // One valid call per tool, so its handler runs.
  const VALID_ARGS: Record<ToolName, Record<string, unknown>> = {
    band_send_message: { content: "hi", mentions: JANE },
    band_send_event: { content: "t", message_type: "thought" },
    band_no_reply: {},
    band_add_participant: { name: "Weather Agent" },
    band_remove_participant: { name: "Weather Agent" },
    band_lookup_peers: {},
    band_get_participants: {},
    band_create_chatroom: {},
    band_list_contacts: {},
    band_add_contact: { handle: "@jane" },
    band_remove_contact: { handle: "@jane" },
    band_list_contact_requests: {},
    band_respond_contact_request: { action: "approve", request_id: "r1" },
    band_list_memories: {},
    band_store_memory: { content: "c", system: "long_term", type: "semantic", segment: "agent", thought: "why" },
    band_get_memory: { memory_id: "m1" },
    band_supersede_memory: { memory_id: "m1" },
    band_archive_memory: { memory_id: "m1" },
  };

  it.each(Object.entries(TOOL_METHODS).filter(([, method]) => method !== null))(
    "%s dispatches to the %s method it records on",
    async (toolName, method) => {
      const tools = new AgentTools({ roomId: "room-1", rest: new FakeRestApi() });
      const spy = vi.spyOn(tools, method!).mockResolvedValue({ ok: true } as never);

      await tools.executeToolCall(toolName, VALID_ARGS[toolName as ToolName]);

      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

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

  it("skips blank text", async () => {
    const tools = trackTurn(new FakeTools());

    expect(await relayReply(tools, "  ", JANE)).toBe(false);
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
});

describe("single-room MCP tools", () => {
  it("reach the turn in flight, not the turn the connection started with", async () => {
    let current = trackTurn(new FakeTools());
    const first = current;
    const [send] = buildSingleContextRegistrations(resolveSingleRoomTools(() => current))
      .filter((registration) => registration.name === SEND_MESSAGE_TOOL_NAME);
    current = trackTurn(new FakeTools());

    await send!.execute({ content: "Hi", mentions: JANE });

    expect(current.turn.replied).toBe(true);
    expect(first.turn.replied).toBe(false);
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
    expect(resolveBandToolName(acpToolCallName(toolCall({ raw_input: rawInput })))).toBe(SEND_MESSAGE_TOOL_NAME);
  });

  it("falls back to the title when raw_input is not an MCP invocation", () => {
    expect(acpToolCallName(toolCall({ raw_input: { path: "notes.md" } }, "band-band_send_message"))).toBe("band-band_send_message");
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

  // A flow test drives the room end to end instead, scripting every row through a `Record<TurnScript, …>`.
  const RUNS_CONTRACT = /describeTurnOutcomeContract\(|Record<TurnScript,/;

  it("runs the contract in every registered test file", () => {
    for (const file of new Set(Object.values(TURN_OUTCOME_ADAPTERS))) {
      expect(readFileSync(join(__dirname, file), "utf8"), file).toMatch(RUNS_CONTRACT);
    }
  });

  it("judges exactly the registered adapters", () => {
    for (const [name, adapter] of simpleAdapters) {
      expect(judgesTurns(adapter), name).toBe(!TURN_OUTCOME_EXEMPT.has(name));
    }
  });
});
