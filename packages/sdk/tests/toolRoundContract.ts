import { describe, expect, it } from "vitest";
import { z } from "zod";

import { NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import type { CustomToolDef } from "../src/runtime/tools/customTools";
import { SENDER } from "./helpers/recordingRoom";

/** One tool call a scripted model makes. */
export interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
}

/** What a scripted model answers one request with: tool calls, or closing text. */
export type ScriptedStep = { calls: ScriptedCall[] } | { text: string };

/** What one turn did: model requests, posted message contents, and reported failure messages. */
export interface RoundRun {
  requests: number;
  messages: string[];
  failures: string[];
}

/**
 * Runs one turn through the adapter on a `recordingRoom()`, its model
 * answering its n-th request (from 1) with `script(n)`.
 */
export type RunRounds = (script: (request: number) => ScriptedStep, customTools: CustomToolDef[]) => Promise<RoundRun>;

export const decline: ScriptedCall = { name: NO_REPLY_TOOL_NAME, args: { reason: "FYI" } };
export const send: ScriptedCall = { name: SEND_MESSAGE_TOOL_NAME, args: { content: "Noted.", mentions: [SENDER.handle] } };
/** A send the platform rejects: nobody in the room has this handle. */
const failedSend: ScriptedCall = { name: SEND_MESSAGE_TOOL_NAME, args: { content: "Noted.", mentions: ["@nobody"] } };
export const calls = (...scripted: ScriptedCall[]): ScriptedStep => ({ calls: scripted });
export const done: ScriptedStep = { text: "done" };

const customTool = (name: string, effect: CustomToolDef["effect"], handler: CustomToolDef["handler"]): CustomToolDef => ({
  name, schema: z.object({}), effect, handler,
});
const skip = (handler: CustomToolDef["handler"]) => customTool("skip_turn", "decline", handler);
const skipCall: ScriptedCall = { name: "skip_turn", args: {} };
const explode = customTool("explode", "act", () => {
  throw new Error("boom");
});
const explodeCall: ScriptedCall = { name: "explode", args: {} };

/**
 * README.md's turn-outcome round rule, owed by every tool loop the SDK drives:
 * a round ends the turn once a decline landed in it and no call beside it
 * failed; otherwise the model is asked again and sees what happened.
 */
export function describeToolRoundContract(adapter: string, run: RunRounds): void {
  describe(`tool round rule: ${adapter}`, () => {
    it("ends at a decline, so a model that would decline again is not asked", async () => {
      expect(await run(() => calls(decline), [])).toEqual({ requests: 1, messages: [], failures: [] });
    });

    it("runs every call of the round that declines, then ends", async () => {
      expect(await run(() => calls(send, decline), [])).toEqual({ requests: 1, messages: ["Noted."], failures: [] });
    });

    it("runs the calls after the decline in its round too", async () => {
      expect(await run(() => calls(decline, send), [])).toEqual({ requests: 1, messages: ["Noted."], failures: [] });
    });

    it("keeps going after a send, and relays no closing text on top of it", async () => {
      const result = await run((request) => request === 1 ? calls(send) : done, []);
      expect(result).toEqual({ requests: 2, messages: ["Noted."], failures: [] });
    });

    it("asks the model again when a call beside the decline failed", async () => {
      const result = await run((request) => request === 1 ? calls(failedSend, decline) : request === 2 ? calls(send) : done, []);
      expect(result).toEqual({ requests: 3, messages: ["Noted."], failures: [] });
    });

    it("asks the model again when a call after the decline failed", async () => {
      const result = await run((request) => request === 1 ? calls(decline, failedSend) : request === 2 ? calls(send) : done, []);
      expect(result).toEqual({ requests: 3, messages: ["Noted."], failures: [] });
    });

    it("ends at a later round that only declines, once the failed one is behind it", async () => {
      const result = await run((request) => calls(...(request === 1 ? [failedSend, decline] : [decline])), []);
      expect(result).toEqual({ requests: 2, messages: [], failures: [] });
    });

    it("asks the model again when a call beside the decline threw", async () => {
      const result = await run((request) => request === 1 ? calls(explodeCall, decline) : request === 2 ? calls(send) : done, [explode]);
      expect(result).toEqual({ requests: 3, messages: ["Noted."], failures: [] });
    });

    describe("a custom decline tool", () => {
      it("ends the turn when it succeeds", async () => {
        expect((await run(() => calls(skipCall), [skip(() => "skipped")])).requests).toBe(1);
      });

      it("lets the model carry on when it fails", async () => {
        const result = await run(
          (request) => request === 1 ? calls(skipCall) : request === 2 ? calls(send) : done,
          [skip(() => ({ ok: false, message: "refused" }))],
        );
        expect(result).toEqual({ requests: 3, messages: ["Noted."], failures: [] });
      });

      // `Turn` judges the handler's own output, and a JSON string is not a failure to it.
      it("ends the turn when it returns a JSON string that reads like a failure", async () => {
        const result = await run((request) => request === 1 ? calls(skipCall) : calls(send), [skip(() => '{"ok":false,"message":"nothing to add"}')]);
        expect(result.requests).toBe(1);
      });
    });
  });
}
