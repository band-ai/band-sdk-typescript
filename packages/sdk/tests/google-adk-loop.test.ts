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
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GoogleADKAdapter, type GoogleADKAdapterOptions } from "../src/adapters/google-adk";
import { DEFAULT_MAX_TOOL_ROUNDS } from "../src/adapters/shared/toolRounds";
import { NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import type { CustomToolDef } from "../src/runtime/tools/customTools";
import { failureMessages, recordingRoom, SENDER } from "./helpers/recordingRoom";
import { expectTurnFailed, makeMessage } from "./testUtils";
import { turnInput } from "./turnOutcomeContract";

// `src/types/google-adk.d.ts` declares the module untyped, so a model response's parts are typed here.
type Part = { text: string } | { functionCall: { name: string; args: Record<string, unknown> } };

const call = (name: string, args: Record<string, unknown> = {}): Part => ({ functionCall: { name, args } });
const text = (value: string): Part => ({ text: value });
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

describe("Google ADK tool loop", () => {
  it("ends the run at a decline, so a model that would decline again is not asked", async () => {
    const { model, room, turn } = await runTurn(() => [decline]);
    await turn;

    expect(model.requests).toBe(1);
    expect(room.messages).toEqual([]);
    expect(failureMessages(room.events)).toEqual([]);
  });

  it("runs and reports every call of the round that declines, then ends", async () => {
    const { model, room, turn } = await runTurn(() => [send("Noted."), decline], { enableExecutionReporting: true });
    await turn;

    expect(model.requests).toBe(1);
    expect(room.messages.map((message) => message.content)).toEqual(["Noted."]);
    expect(room.events.map((event) => event.messageType)).toEqual(["tool_call", "tool_call", "tool_result", "tool_result"]);
  });

  it("asks the model again when a call beside the decline failed, so it sees the failure", async () => {
    const { model, room, turn } = await runTurn(
      (request) => request === 1
        ? [call(SEND_MESSAGE_TOOL_NAME, { content: "Noted.", mentions: ["@nobody"] }), decline]
        : request === 2 ? [send("Noted.")] : [text("done")],
    );
    await turn;

    expect(model.requests).toBe(3);
    expect(room.messages.map((message) => message.content)).toEqual(["Noted."]);
  });

  it("keeps going after a send, and relays no closing text on top of it", async () => {
    const { model, room, turn } = await runTurn((request) => request === 1 ? [send("Noted.")] : [text("I sent it.")]);
    await turn;

    expect(model.requests).toBe(2);
    expect(room.messages.map((message) => message.content)).toEqual(["Noted."]);
  });

  describe("a custom decline tool", () => {
    const skip = (handler: CustomToolDef["handler"]): CustomToolDef => ({
      name: "skip_turn", schema: z.object({}), effect: "decline", handler,
    });

    it("ends the run when it succeeds", async () => {
      const { model, turn } = await runTurn(() => [call("skip_turn")], { additionalTools: [skip(() => "skipped")] });
      await turn;

      expect(model.requests).toBe(1);
    });

    it("lets the model carry on when it fails", async () => {
      const { model, room, turn } = await runTurn(
        (request) => request === 1 ? [call("skip_turn")] : request === 2 ? [send("Noted.")] : [text("done")],
        { additionalTools: [skip(() => ({ ok: false, message: "refused" }))] },
      );
      await turn;

      expect(model.requests).toBe(3);
      expect(room.messages.map((message) => message.content)).toEqual(["Noted."]);
    });
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
