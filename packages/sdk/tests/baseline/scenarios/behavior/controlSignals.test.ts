/**
 * The platform's control pushes reach the runtime and govern the active turn:
 * STOP cancels it and PLAY replays the same message from /next; INTERRUPT
 * cancels it and consumes the message, so it never completes.
 *
 * Neither can be exercised yet, so both fail loudly, never skip: the TS
 * runtime handles only `supersede` on `agent_control`, and the REST client
 * has no user endpoint to send stop, play or interrupt. Once both exist, each
 * test drives a deterministic handler that runs until cancelled.
 */
import { describe, it } from "vitest";

import { CATEGORY, scenarioId } from "../../toolkit/registry";

const UNSUPPORTED =
  "the TS runtime does not handle stop, play or interrupt control signals, and @band-ai/rest-client has no endpoint to send them";

const cannotRun = (): never => {
  throw new Error(`cannot run: ${UNSUPPORTED}`);
};

describe(scenarioId(CATEGORY.behavior, "controlSignals"), () => {
  it("stop cancels the active turn, then play replays its message", cannotRun);
  it("interrupt cancels the active turn and consumes its message", cannotRun);
});
