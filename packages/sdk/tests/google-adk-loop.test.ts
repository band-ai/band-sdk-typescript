/**
 * The tool loop on the installed `@google/adk`: a real `LlmAgent` and
 * `InMemoryRunner` run the adapter's `FunctionTool`s against a scripted model,
 * so ADK itself decides when the run ends.
 */
import {
  BaseLlm,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
  stringifyContent,
} from "@google/adk";
import { z } from "zod";
import { createDeferred } from "../src/core/deferred";
import { describe, expect, it } from "vitest";

import { GoogleADKAdapter, type GoogleADKAdapterOptions } from "../src/adapters/google-adk";
import { DEFAULT_MAX_TOOL_ROUNDS } from "../src/adapters/shared/toolRounds";
import { NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import { failureMessages, recordingRoom, SENDER } from "./helpers/recordingRoom";
import { describeToolRoundContract } from "./toolRoundContract";
import { expectTurnFailed, makeMessage } from "./testUtils";
import { turnInput } from "./turnOutcomeContract";

// `src/types/google-adk.d.ts` declares the module untyped, so a model response's parts are typed here.
type Part = { text: string } | { functionCall: { name: string; args: Record<string, unknown> } };

const call = (name: string, args: Record<string, unknown> = {}): Part => ({ functionCall: { name, args } });
const send = (content: string) => call(SEND_MESSAGE_TOOL_NAME, { content, mentions: [SENDER.handle] });
const decline = call(NO_REPLY_TOOL_NAME, { reason: "FYI" });

/** A model that answers its n-th request (from 1) with `script(n)`, and counts the requests. */
class ScriptedModel extends BaseLlm {
  public requests = 0;

  public constructor(private readonly script: (request: number) => Part[]) {
    super({ model: "scripted" });
  }

  public async *generateContentAsync(): AsyncGenerator<{ content: { role: "model"; parts: Part[] } }, void> {
    this.requests += 1;
    yield { content: { role: "model", parts: this.script(this.requests) } };
  }

  public async connect(): Promise<never> {
    throw new Error("the scripted model has no live connection");
  }
}

/** The adapter's SDK seam, backed by the real ADK runner and `model`. */
function realAdk(model: ScriptedModel): NonNullable<GoogleADKAdapterOptions["sdkFactory"]> {
  return async () => ({
    createModel: () => model,
    createAgent: (params) => new LlmAgent({ ...params, model }),
    createFunctionTool: (params) => new FunctionTool(params),
    createRunner: (params) => new InMemoryRunner(params),
    isFinalResponse,
    getFunctionCalls,
    getFunctionResponses,
    stringifyContent,
  });
}

async function runTurn(script: (request: number) => Part[], options: GoogleADKAdapterOptions = {}) {
  const model = new ScriptedModel(script);
  const adapter = new GoogleADKAdapter({ ...options, sdkFactory: realAdk(model) });
  await adapter.onStarted("helper", "assistant");
  const room = recordingRoom();
  const turn = adapter.onEvent(turnInput(room.tools, makeMessage("Remember: my dog is named Pixel.")));
  return { model, room, turn };
}

describeToolRoundContract("GoogleADKAdapter (real ADK runner)", async (script, additionalTools) => {
  const { model, room, turn } = await runTurn((request) => {
    const step = script(request);
    return "text" in step ? [{ text: step.text }] : step.calls.map((scripted) => call(scripted.name, scripted.args));
  }, { additionalTools });
  await turn;
  return { requests: model.requests, messages: room.messages.map((message) => message.content), failures: failureMessages(room.events) };
});

describe("Google ADK tool loop", () => {
  it("reports every call of the round that declines before it ends", async () => {
    const { model, room, turn } = await runTurn(() => [send("Noted."), decline], { enableExecutionReporting: true });
    await turn;

    expect(model.requests).toBe(1);
    expect(room.events.map((event) => event.messageType)).toEqual(["tool_call", "tool_call", "tool_result", "tool_result"]);
  });

  it("waits for a slow sibling after a successful decline before finishing the real runner", async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const { model, turn } = await runTurn(() => [decline, call("slow")], {
      additionalTools: [{ name: "slow", schema: z.object({}), handler: async () => {
        started.resolve();
        await finish.promise;
        return "finished";
      } }],
    });
    let ended = false;
    void turn.then(() => { ended = true; });
    try {
      await started.promise;
      expect(model.requests).toBe(1);
      expect(ended).toBe(false);
    } finally {
      finish.resolve();
    }
    await turn;
    expect(ended).toBe(true);
    expect(model.requests).toBe(1);
  });

  it("observes split results from the real runner without counting duplicates as a completed roster", async () => {
    const firstResult = createDeferred<void>();
    const releaseSibling = createDeferred<void>();
    const model = new ScriptedModel(() => [decline, send("sibling")]);
    const factory = realAdk(model);
    const adapter = new GoogleADKAdapter({ sdkFactory: async () => {
      const sdk = await factory();
      return { ...sdk, createRunner: (params) => {
        const runner = sdk.createRunner(params);
        return { sessionService: runner.sessionService, runAsync: async function* (request) {
          for await (const event of runner.runAsync(request)) {
            const responses = getFunctionResponses(event);
            if (responses.length < 2) { yield event; continue; }
            const responseEvent = (parts: unknown[]) => ({ ...event as Record<string, unknown>, content: { role: "user", parts } });
            yield responseEvent([{ functionResponse: responses[0] }]);
            yield responseEvent([{ functionResponse: responses[0] }, { functionResponse: { id: "foreign", name: "foreign", response: {} } }]);
            firstResult.resolve();
            await releaseSibling.promise;
            yield responseEvent([{ functionResponse: responses[1] }]);
          }
        } };
      } };
    } });
    const room = recordingRoom();
    const turn = adapter.onEvent(turnInput(room.tools));
    let ended = false;
    void turn.then(() => { ended = true; });
    try {
      await firstResult.promise;
      expect(ended).toBe(false);
      expect(model.requests).toBe(1);
    } finally {
      releaseSibling.resolve();
    }
    await turn;
    expect(model.requests).toBe(1);
    expect(room.messages.map((message) => message.content)).toEqual(["sibling"]);
  });

  it("stops a model that never stops calling tools, without running or reporting the round past the cap", async () => {
    const { model, room, turn } = await runTurn(() => [send("Still working.")], { enableExecutionReporting: true });
    await expectTurnFailed(turn);

    expect(model.requests).toBe(DEFAULT_MAX_TOOL_ROUNDS + 1);
    expect(room.messages).toHaveLength(DEFAULT_MAX_TOOL_ROUNDS);
    expect(room.events.filter((event) => event.messageType === "tool_call")).toHaveLength(DEFAULT_MAX_TOOL_ROUNDS);
    expect(failureMessages(room.events)).toEqual([`Stopped tool loop after ${DEFAULT_MAX_TOOL_ROUNDS} rounds to prevent infinite recursion.`]);
  });

  it("honors maxToolRounds", async () => {
    const { model, room, turn } = await runTurn(() => [send("Still working.")], { maxToolRounds: 2 });
    await expectTurnFailed(turn);

    expect(model.requests).toBe(3);
    expect(room.messages).toHaveLength(2);
  });
});
