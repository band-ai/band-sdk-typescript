/**
 * Which text in a graph's final state is this turn's answer: only what follows
 * this turn's input. Earlier turns replayed into the state are not, whether the
 * state holds LangChain messages (the real `createReactAgent`) or a caller's
 * graph hands back the adapter's input as tuples, role records or serialized
 * messages, the shapes the adapter reads an answer from.
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";

import { LangGraphAdapter, type LangGraphAdapterOptions } from "../src/adapters/langgraph";
import { HistoryProvider } from "../src/runtime/types";
import { recordingRoom } from "./helpers/recordingRoom";
import { expectTurnFailed, makeMessage, MISSING_REPLY } from "./testUtils";
import { turnInput } from "./turnOutcomeContract";

/** A chat model that answers every request with `reply`. */
class FixedChatModel extends BaseChatModel {
  public constructor(private readonly reply: string) {
    super({});
  }

  public _llmType(): string {
    return "fixed";
  }

  public override bindTools(): this {
    return this;
  }

  public async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    return { generations: [{ text: this.reply, message: new AIMessage(this.reply) }] };
  }
}

const EARLIER_REPLY = "Pixel is a good name.";
/** A room whose earlier turn the agent already answered, replayed into the graph's state. */
const answeredBefore = new HistoryProvider([
  { id: "earlier-ask", content: "My dog is named Pixel.", sender_type: "User", sender_name: "Jane" },
  { id: "earlier-reply", content: EARLIER_REPLY, sender_type: "Agent", sender_name: "helper" },
]);

type Tuple = [role: string, content: string];
/** The adapter's `[role, content]` input, as a graph's state may hold it. */
const asRoleRecord = ([role, content]: Tuple) => ({ role, content });
const asSerialized = ([role, content]: Tuple) => ({
  lc: 1, type: "constructor", id: ["langchain_core", "messages", role === "assistant" ? "AIMessage" : "HumanMessage"], kwargs: { content },
});

/** A caller's graph that hands back the adapter's input in `shape`, plus `appended` after this turn's input. */
const echoGraph = (shape: (message: Tuple) => unknown = (message) => message, ...appended: unknown[]) => ({
  invoke: async (input: Record<string, unknown>) => ({ messages: [...(input.messages as Tuple[]).map(shape), ...appended] }),
});

async function runTurn(options: LangGraphAdapterOptions) {
  const adapter = new LangGraphAdapter(options);
  await adapter.onStarted("helper", "assistant");
  const room = recordingRoom();
  const turn = adapter.onEvent(turnInput(room.tools, makeMessage("Also remember: Pixel likes walks."), answeredBefore));
  return { room, turn };
}

describe("LangGraph reply boundary", () => {
  it.each([
    ["the built-in graph's LangChain messages", { llm: new FixedChatModel("") }],
    ["a caller's graph returning the adapter's tuples", { graphFactory: () => echoGraph() }],
    ["a caller's graph returning role records", { graphFactory: () => echoGraph(asRoleRecord) }],
    ["a caller's graph returning serialized LangChain messages", { graphFactory: () => echoGraph(asSerialized) }],
  ])("never relays an earlier turn's reply as this turn's, in %s", async (_shape, options) => {
    const { room, turn } = await runTurn(options);
    await expectTurnFailed(turn);

    expect(room.messages.map((message) => message.content)).not.toContain(EARLIER_REPLY);
    expect(room.events.map((event) => event.content)).toContain(MISSING_REPLY.content);
  });

  it("relays the answer that follows this turn's input", async () => {
    const { room, turn } = await runTurn({ graphFactory: () => echoGraph(undefined, ["assistant", "Walks noted."]) });
    await turn;

    expect(room.messages.map((message) => message.content)).toEqual(["Walks noted."]);
  });
});
