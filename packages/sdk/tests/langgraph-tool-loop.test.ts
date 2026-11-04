/**
 * The built-in graph's tool loop on the installed `@langchain/langgraph`: a
 * real `createReactAgent` runs the adapter's tools against a scripted chat
 * model, so LangGraph itself decides when the run ends.
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LangGraphAdapter, type LangGraphAdapterOptions } from "../src/adapters/langgraph";
import { NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import type { CustomToolDef } from "../src/runtime/tools/customTools";
import { failureMessages, recordingRoom, SENDER } from "./helpers/recordingRoom";
import { describeToolRoundContract, type ScriptedCall, type ScriptedStep } from "./toolRoundContract";
import { expectTurnFailed, makeMessage } from "./testUtils";
import { turnInput } from "./turnOutcomeContract";

/** One model answer: tool calls, possibly with side text, or text alone. */
type Answer = { calls: ScriptedCall[]; text?: string } | { text: string };

/** A chat model that answers its n-th request (from 1) with `script(n)`, recording what each request saw. */
class ScriptedChatModel extends BaseChatModel {
  public readonly inputs: string[][] = [];

  public constructor(private readonly script: (request: number) => Answer) {
    super({});
  }

  public get requests(): number {
    return this.inputs.length;
  }

  public _llmType(): string {
    return "scripted";
  }

  public override bindTools(): this {
    return this;
  }

  public async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.inputs.push(messages.map((message) => message.getType()));
    const answer = this.script(this.requests);
    const message = new AIMessage({
      content: answer.text ?? "",
      tool_calls: "calls" in answer
        ? answer.calls.map((call, index) => ({ id: `call-${this.requests}-${index}`, name: call.name, args: call.args }))
        : [],
    });
    return { generations: [{ text: answer.text ?? "", message }] };
  }
}

const decline: ScriptedCall = { name: NO_REPLY_TOOL_NAME, args: { reason: "FYI" } };
const send: ScriptedCall = { name: SEND_MESSAGE_TOOL_NAME, args: { content: "Noted.", mentions: [SENDER.handle] } };
const calls = (...scripted: ScriptedCall[]): Answer => ({ calls: scripted });
const done: Answer = { text: "done" };

async function runTurn(script: (request: number) => Answer, options: Omit<LangGraphAdapterOptions, "llm"> = {}) {
  const model = new ScriptedChatModel(script);
  const adapter = new LangGraphAdapter({ ...options, llm: model });
  await adapter.onStarted("helper", "assistant");
  const room = recordingRoom();
  const turn = adapter.onEvent(turnInput(room.tools, makeMessage("Remember: my dog is named Pixel.")));
  return { model, room, turn };
}

const contractRun = (options: Omit<LangGraphAdapterOptions, "llm">) =>
  async (script: (request: number) => ScriptedStep, customTools: CustomToolDef[]) => {
    const { model, room, turn } = await runTurn(script, { ...options, customTools });
    await turn;
    return { requests: model.requests, messages: room.messages.map((message) => message.content), failures: failureMessages(room.events) };
  };

describeToolRoundContract("LangGraphAdapter (built-in graph, streamed events)", contractRun({}));
describeToolRoundContract("LangGraphAdapter (built-in graph, invoke)", contractRun({ emitExecutionEvents: false }));

describe("LangGraph built-in tool loop", () => {
  it("reports every call of the round that declines before it ends", async () => {
    const { model, room, turn } = await runTurn(() => calls(send, decline));
    await turn;

    expect(model.requests).toBe(1);
    const reported = (type: string) => room.events
      .filter((event) => event.messageType === type)
      .map((event) => (JSON.parse(event.content) as { tool_call_id: string }).tool_call_id);
    expect(reported("tool_call")).toHaveLength(2);
    expect(new Set(reported("tool_result"))).toEqual(new Set(reported("tool_call")));
  });

  it("asks the model again when an additional tool beside the decline threw", async () => {
    const flaky = tool(async () => {
      throw new Error("lookup failed");
    }, { name: "lookup", description: "Look something up.", schema: z.object({}) });
    const lookup: ScriptedCall = { name: "lookup", args: {} };
    const { model, room, turn } = await runTurn(
      (request) => request === 1 ? calls(lookup, decline) : request === 2 ? calls(send) : done,
      { additionalTools: [flaky] },
    );
    await turn;

    expect(model.requests).toBe(3);
    expect(room.messages.map((message) => message.content)).toEqual(["Noted."]);
    expect(failureMessages(room.events)).toEqual([]);
  });

  it("never relays the side text of a round whose custom decline failed", async () => {
    const skip: CustomToolDef = { name: "skip_turn", schema: z.object({}), effect: "decline", handler: () => ({ ok: false, message: "refused" }) };
    const { model, room, turn } = await runTurn(
      (request) => request === 1 ? { calls: [{ name: "skip_turn", args: {} }], text: "I'll stay out of this one." } : calls(decline),
      { customTools: [skip] },
    );
    await turn;

    expect(model.requests).toBe(2);
    expect(room.messages).toEqual([]);
    expect(failureMessages(room.events)).toEqual([]);
  });

  it("keeps a checkpointed room's history whole after a decline, so its next turn runs normally", async () => {
    const model = new ScriptedChatModel((request) => request === 1 ? calls(decline) : { text: "Pixel it is." });
    const adapter = new LangGraphAdapter({ llm: model, checkpointer: new MemorySaver() });
    await adapter.onStarted("helper", "assistant");
    const room = recordingRoom();

    await adapter.onEvent(turnInput(room.tools, makeMessage("FYI: the walk is at noon.")));
    expect(model.requests).toBe(1);

    await adapter.onEvent({ ...turnInput(room.tools, { ...makeMessage("What is my dog called?"), id: "msg-2" }), isSessionBootstrap: false });

    expect(model.requests).toBe(2);
    expect(model.inputs[1]?.slice(-3)).toEqual(["ai", "tool", "human"]);
    expect(room.messages.map((message) => message.content)).toEqual(["Pixel it is."]);
    expect(failureMessages(room.events)).toEqual([]);
  });

  it("honors recursionLimit", async () => {
    const { room, turn } = await runTurn(() => calls(send), { recursionLimit: 7 });
    await expectTurnFailed(turn);

    expect(failureMessages(room.events)).toEqual([expect.stringContaining("Recursion limit of 7 reached")]);
  });

  it("leaves a graphFactory graph's loop to the graph", async () => {
    const model = new ScriptedChatModel((request) => request === 1 ? calls(decline) : done);
    const adapter = new LangGraphAdapter({ graphFactory: (tools) => createReactAgent({ llm: model, tools: tools as never }) });
    await adapter.onStarted("helper", "assistant");
    const room = recordingRoom();
    await adapter.onEvent(turnInput(room.tools));

    expect(model.requests).toBe(2);
    expect(room.messages).toEqual([]);
    expect(failureMessages(room.events)).toEqual([]);
  });
});
