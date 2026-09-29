/**
 * A tool-calling adapter's turn is bounded, through the real platform runtime.
 * A model call that never answers fails its own message when the turn budget
 * runs out, instead of holding the room's queue, and the message behind it
 * still runs.
 */
import { describe, expect, it } from "vitest";

import { ToolCallingAdapter } from "../../src/adapters/tool-calling";
import { FAILURE_EVENT_TYPE } from "../../src/contracts/protocols";
import { FAILURE_CODE_TIMEOUT } from "../../src/core/providerFailure";
import { SHORT_TURN_TIMEOUT_MS, hangsOnce } from "../testUtils";
import { AGENT_ID, BandPlatform, person } from "./support/bandPlatform";

const USER = "user-1";
const REPLY = "back to normal";

describe("A tool-calling turn that hangs", () => {
  it("fails its own message and still runs the one behind it", async () => {
    const { model, hung } = hangsOnce(REPLY);
    const adapter = new ToolCallingAdapter({ model, toolFormat: "openai", turnTimeoutMs: SHORT_TURN_TIMEOUT_MS });
    await using session = await BandPlatform.join(adapter, [person(USER)]);
    const { room } = session;

    const first = await room.say(USER, `@[[${AGENT_ID}]] this turn hangs`);
    const last = await room.say(USER, `@[[${AGENT_ID}]] this one must not wait for it`);

    expect(await room.outcome(first)).toBe("failed");
    expect(await room.outcome(last)).toBe("processed");
    expect(hung.signal?.aborted).toBe(true);
    expect(room.messages.map((posted) => posted.content)).toEqual([REPLY]);
    expect(room.events(FAILURE_EVENT_TYPE).map((posted) => posted.metadata?.failure)).toEqual([
      expect.objectContaining({ code: FAILURE_CODE_TIMEOUT }),
    ]);
  });
});
