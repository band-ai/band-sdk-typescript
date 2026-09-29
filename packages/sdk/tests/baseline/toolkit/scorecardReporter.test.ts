import { describe, expect, it } from "vitest";
import type { TestResult } from "vitest/node";

import { ADAPTER, type AdapterId } from "./adapters";
import { fakeSpec } from "./fakeSpec";
import { AdapterRegistry, CAST_SEPARATOR, CATEGORY, scenarioId } from "./registry";
import { SCORECARD_STATUS } from "./scorecard";
import { TEST_PARENT, TEST_STATE, scorecardRows, type ReportedTest } from "./scorecardReporter";

const REPLIES = scenarioId(CATEGORY.platform, "repliesToMention");
const DURATION_MS = 42;
const FAILURE = "no reply within 5ms";
const OPT_IN_NOTE = "set RUN_CODEX_ACP_E2E=1";
const PENDING_REASON = "needs a server";
const BESPOKE_REASON = "has no Band tools";

const PENDING = ADAPTER.letta;
const BESPOKE = ADAPTER.parlant;
const roster = new AdapterRegistry<AdapterId>([
  fakeSpec(ADAPTER.anthropic),
  fakeSpec(ADAPTER.gemini),
  fakeSpec(ADAPTER.googleAdk),
  fakeSpec(PENDING, { pending: PENDING_REASON }),
  fakeSpec(BESPOKE, { bespokeOnly: BESPOKE_REASON }),
]);

/** A finished test as vitest reports it, titled the way `perAdapter` titles it. */
function reported(suite: string, name: string, result: TestResult): ReportedTest {
  return {
    name,
    parent: { type: TEST_PARENT.suite, name: suite },
    result: () => result,
    diagnostic: () => ({ duration: DURATION_MS }),
  };
}

const passed: TestResult = { state: TEST_STATE.passed, errors: undefined };
const skipped = (note?: string): TestResult => ({ state: TEST_STATE.skipped, errors: undefined, note });

describe("scorecardRows", () => {
  it("reads the scenario from the suite and the adapter from the test", () => {
    expect(scorecardRows(reported(REPLIES, ADAPTER.anthropic, passed), roster)).toEqual([
      { scenario: REPLIES, adapter: ADAPTER.anthropic, outcome: { status: SCORECARD_STATUS.pass, durationMs: DURATION_MS } },
    ]);
  });

  it("gives each adapter of a shared cast its own row", () => {
    const cast = [ADAPTER.anthropic, ADAPTER.googleAdk];
    const rows = scorecardRows(reported(scenarioId(CATEGORY.behavior, "multiAgentCollaboration"), cast.join(CAST_SEPARATOR), passed), roster);
    expect(rows.map((row) => row.adapter)).toEqual(cast);
  });

  it("records a failure with its error messages", () => {
    const failed: TestResult = { state: TEST_STATE.failed, errors: [{ message: FAILURE } as never] };
    expect(scorecardRows(reported(REPLIES, ADAPTER.gemini, failed), roster)[0]?.outcome).toEqual({
      status: SCORECARD_STATUS.fail,
      error: FAILURE,
      durationMs: DURATION_MS,
    });
  });

  it("records a pending adapter as N/A with its registry reason", () => {
    expect(scorecardRows(reported(REPLIES, PENDING, skipped("anything")), roster)[0]?.outcome).toEqual({
      status: SCORECARD_STATUS.na,
      reason: PENDING_REASON,
    });
  });

  it("records a bespoke-only adapter in a fan-out as N/A with its registry reason", () => {
    expect(scorecardRows(reported(REPLIES, BESPOKE, skipped("anything")), roster)[0]?.outcome).toEqual({
      status: SCORECARD_STATUS.na,
      reason: BESPOKE_REASON,
    });
  });

  it("records an opt-in skip with its note, and leaves a filtered-out test out", () => {
    expect(scorecardRows(reported(scenarioId(CATEGORY.adapters, "codexAcpSmoke"), ADAPTER.anthropic, skipped(OPT_IN_NOTE)), roster)[0]?.outcome).toEqual({
      status: SCORECARD_STATUS.skip,
      reason: OPT_IN_NOTE,
    });
    expect(scorecardRows(reported(REPLIES, ADAPTER.anthropic, skipped()), roster)).toEqual([]);
    expect(scorecardRows(reported(REPLIES, PENDING, skipped()), roster), "a filtered-out pending adapter").toEqual([]);
  });

  it.each([
    {
      name: "a test outside any suite",
      test: { ...reported(REPLIES, ADAPTER.anthropic, passed), parent: { type: TEST_PARENT.module } },
    },
    { name: "a suite that is not a scenario id", test: reported("ToolCallingAdapter", ADAPTER.anthropic, passed) },
    { name: "a test that is not an adapter id", test: reported(REPLIES, "some other case", passed) },
  ])("ignores $name", ({ test }) => {
    expect(scorecardRows(test, roster)).toEqual([]);
  });
});
