/**
 * The built-in graph's tool loop on the installed `@langchain/langgraph`: the
 * real `createReactAgent` and `tool()` run the adapter's Band tools against a
 * scripted chat model, so LangGraph itself decides when the run ends.
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LangGraphAdapter } from "../src/adapters/langgraph";
import { NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import { HistoryProvider } from "../src/runtime/types";
import type { CustomToolDef } from "../src/runtime/tools/customTools";
import { failureMessages, recordingRoom, SENDER } from "./helpers/recordingRoom";
import { expectTurnFailed, makeMessage, MISSING_REPLY } from "./testUtils";
import { turnInput } from "./turnOutcomeContract";

type ToolCall = { name: string; args: Record<string, unknown> };

/** A chat model answering its n-th request (from 1) with `script(n)`, counting the requests. */
class ScriptedChatModel extends BaseChatModel {
  public requests = 0;

  public constructor(private readonly script: (request: number) => AIMessage) {
    super({});
  }

  public _llmType(): string {
    return "scripted";
  }

  // createReactAgent binds the tools; the script already knows which ones it calls.
  public override bindTools(): this {
    return this;
  }

  public async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.requests += 1;
    return { generations: [{ text: "", message: this.script(this.requests) }] };
  }
}

const calling = (...calls: ToolCall[]) => new AIMessage({
  content: "",
  tool_calls: calls.map((call, index) => ({ ...call, id: `call-${index}`, type: "tool_call" as const })),
});
const decline: ToolCall = { name: NO_REPLY_TOOL_NAME, args: { reason: "FYI" } };
const send: ToolCall = { name: SEND_MESSAGE_TOOL_NAME, args: { content: "Noted.", mentions: [SENDER.handle] } };
const EARLIER_REPLY = "Pixel is a good name.";
/** A room whose earlier turn the agent already answered, replayed into the graph's state. */
const answeredBefore = new HistoryProvider([
  { id: "earlier-ask", content: "My dog is named Pixel.", sender_type: "User", sender_name: "Jane" },
  { id: "earlier-reply", content: EARLIER_REPLY, sender_type: "Agent", sender_name: "helper" },
]);

async function runTurn(
  script: (request: number) => AIMessage,
  options: { customTools?: CustomToolDef[]; history?: HistoryProvider } = {},
) {
  const llm = new ScriptedChatModel(script);
  const adapter = new LangGraphAdapter({ llm, customTools: options.customTools });
  await adapter.onStarted("helper", "assistant");
  const room = recordingRoom();
  const turn = adapter.onEvent(turnInput(room.tools, makeMessage("Also remember: Pixel likes walks."), options.history));
  return { llm, room, turn };
}

describe("LangGraph built-in graph tool loop", () => {
  it("ends the graph at a decline, so a model that would decline again is not asked", async () => {
    const { llm, room, turn } = await runTurn(() => calling(decline));
    await turn;

    expect(llm.requests).toBe(1);
    expect(room.messages).toEqual([]);
    expect(failureMessages(room.events)).toEqual([]);
  });

  it("runs every call of the round that declines, then ends", async () => {
    const { llm, room, turn } = await runTurn(() => calling(send, decline));
    await turn;

    expect(llm.requests).toBe(1);
    expect(room.messages.map((message) => message.content)).toEqual(["Noted."]);
  });

  it("keeps going after a send, and relays no closing text on top of it", async () => {
    const { llm, room, turn } = await runTurn((request) => request === 1 ? calling(send) : new AIMessage("I sent it."));
    await turn;

    expect(llm.requests).toBe(2);
    expect(room.messages.map((message) => message.content)).toEqual(["Noted."]);
  });

  it("never relays an earlier turn's reply as this turn's, when this turn ends without text", async () => {
    const { room, turn } = await runTurn(() => new AIMessage(""), { history: answeredBefore });
    await expectTurnFailed(turn);

    expect(room.messages.map((message) => message.content)).not.toContain(EARLIER_REPLY);
    expect(room.events.map((event) => event.content)).toContain(MISSING_REPLY.content);
  });

  describe("a custom decline tool", () => {
    const skip = (handler: CustomToolDef["handler"]): CustomToolDef => ({
      name: "skip_turn", schema: z.object({}), effect: "decline", handler,
    });

    it("ends the graph when it succeeds", async () => {
      const { llm, turn } = await runTurn(() => calling({ name: "skip_turn", args: {} }), { customTools: [skip(() => "skipped")] });
      await turn;

      expect(llm.requests).toBe(1);
    });

    // returnDirect is fixed on the tool: a failed decline ends the graph too, and nothing earlier is relayed.
    it("ends the graph even when it fails, reporting the missing reply rather than relaying old text", async () => {
      const { llm, room, turn } = await runTurn(
        () => calling({ name: "skip_turn", args: {} }),
        { customTools: [skip(() => ({ ok: false, message: "refused" }))], history: answeredBefore },
      );
      await expectTurnFailed(turn);

      expect(llm.requests).toBe(1);
      expect(room.messages.map((message) => message.content)).not.toContain(EARLIER_REPLY);
      expect(room.events.map((event) => event.content)).toContain(MISSING_REPLY.content);
    });
  });

  it("leaves a caller's graphFactory tools without returnDirect", async () => {
    let received: unknown[] = [];
    const adapter = new LangGraphAdapter({
      graphFactory: (tools) => {
        received = tools;
        return { invoke: async () => ({ messages: [] }) };
      },
    });
    await adapter.onStarted("helper", "assistant");
    const room = recordingRoom();
    await expectTurnFailed(adapter.onEvent(turnInput(room.tools)));

    const noReply = received.find((tool) => (tool as { name?: unknown }).name === NO_REPLY_TOOL_NAME) as { returnDirect?: unknown };
    expect(noReply).toBeDefined();
    expect(noReply.returnDirect).toBe(false);
  });
});
