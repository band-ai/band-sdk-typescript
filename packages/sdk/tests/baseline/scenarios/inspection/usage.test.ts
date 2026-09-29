/**
 * Per-turn token usage, once the SDK reports it. The ported tests will assert
 * what band-sdk-python's usage smokes do:
 *
 * - a turn records nonzero input and output tokens;
 * - exactly one usage event is recorded per turn;
 * - input plus cached tokens are at least 20, and the total is under 100 000;
 * - across two turns, the second turn's output is smaller than the first's, so
 *   usage is per turn and not cumulative.
 *
 * None of that can be exercised yet, so both tests fail loudly, never skip: the
 * TS SDK does not report per-turn token usage, so there is nothing to read back.
 */
import { describe, it } from "vitest";

import { CATEGORY, scenarioId } from "../../toolkit/registry";

const UNSUPPORTED = "the TS SDK does not report per-turn token usage";

const cannotRun = (): never => {
  throw new Error(`cannot run: ${UNSUPPORTED}`);
};

describe(scenarioId(CATEGORY.inspection, "usage"), () => {
  it("records one per-turn usage event with nonzero input and output", cannotRun);
  it("reports per-turn, not cumulative, usage across turns", cannotRun);
});
