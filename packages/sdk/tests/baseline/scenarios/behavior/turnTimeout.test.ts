/**
 * A tool-calling adapter's turn is bounded. A model call that never answers
 * fails its own message when the turn budget runs out, instead of holding the
 * room's queue, and the message behind it still runs. The model is a fake: what
 * is under test is the runtime and the platform's delivery state, not a provider.
 */
import { describe, expect, it } from "vitest";

import type { ToolCallingModel } from "../../../../src/adapters";
import { OpenAIAdapter } from "../../../../src/index";
import { Agents } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

const SCENARIO = scenarioId(CATEGORY.behavior, "turnTimeout");

/** Long enough that a healthy fake turn never meets it, short enough to see it fire in a test. */
const TURN_TIMEOUT_MS = 3_000;
const TIMEOUT_FAILURE = "timed out";
const REPLY = "back to normal";

/** A model whose first call hangs until it is aborted and whose every later call answers. */
function hangsOnce(): ToolCallingModel {
  let calls = 0;
  return {
    complete: (_request, options) => {
      calls += 1;
      if (calls > 1) {
        return Promise.resolve({ text: REPLY });
      }
      return new Promise<never>((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      });
    },
  };
}

describe(SCENARIO, () => {
  it("fails the message whose turn hangs and still runs the one behind it", async () => {
    await using identity = await Agents.provision(SCENARIO, "hangs");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);
    await using _running = await Agents.runAs(identity, new OpenAIAdapter({ model: hangsOnce(), turnTimeoutMs: TURN_TIMEOUT_MS }));

    const first = await Rooms.sendMention(room, identity, "This turn hangs.");
    const last = await Rooms.sendMention(room, identity, "This one must not wait for it.");
    const delivery = observeAgent(identity, room);

    const failed = await delivery.untilStatus(first, DELIVERY_STATUS.failed);
    assertDeliveryStatus(failed, DELIVERY_STATUS.failed);
    expect(failed.error).toContain(TIMEOUT_FAILURE);
    assertDeliveryStatus(await delivery.untilProcessed(last), DELIVERY_STATUS.processed);
  });
});
