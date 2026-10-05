/**
 * A message that needs no answer ends the turn through band_no_reply: the
 * delivery is PROCESSED, the call is recorded as a tool_call event, and nothing
 * reaches the room, neither a message nor a missing-reply error.
 */
import { expect } from "vitest";

import { NO_REPLY_TOOL_NAME } from "../../../../src/contracts/toolSchemas";
import { assertToolFired } from "../../toolkit/assertMessages";
import { eventsFrom, MESSAGE_TYPE, toolCalls } from "../../toolkit/observeMessages";
import { perAdapter } from "../../toolkit/perAdapter";
import { CAPABILITY, CATEGORY, scenarioId } from "../../toolkit/registry";
import { takeTurn } from "../samples/turns";

const FYI = "FYI only: the nightly deploy finished cleanly. No reply is needed, please don't answer this.";

perAdapter(
  scenarioId(CATEGORY.behavior, "noReply"),
  async ({ agent, room }) => {
    await takeTurn(room, agent, FYI);

    assertToolFired(await toolCalls(room, agent), NO_REPLY_TOOL_NAME);
    expect(await eventsFrom(room, MESSAGE_TYPE.Text, agent), "the agent's room messages").toEqual([]);
    expect(await eventsFrom(room, MESSAGE_TYPE.Error, agent), "the agent's error events").toEqual([]);
  },
  {
    // The builders that can report the Band tools' calls, which is the decline's only trace.
    supports: [CAPABILITY.customTools],
    build: (spec, options) => spec.build({ ...options, reportToolCalls: true }),
  },
);
