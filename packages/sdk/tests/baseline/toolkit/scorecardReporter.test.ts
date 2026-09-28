import { describe, expect, it } from "vitest";
import type { TestResult } from "vitest/node";

import { scorecardRows, type ReportedTest } from "./scorecardReporter";

/** A finished test as vitest reports it, titled the way `perAdapter` titles it. */
function reported(suite: string, name: string, result: TestResult, duration = 42): ReportedTest {
  return {
    name,
    parent: { type: "suite", name: suite },
    result: () => result,
    diagnostic: () => ({ duration }),
  };
}

const passed: TestResult = { state: "passed", errors: undefined };

describe("scorecardRows", () => {
  it("reads the scenario from the suite and the adapter from the test", () => {
    expect(scorecardRows(reported("platform.repliesToMention", "anthropic", passed))).toEqual([
      { scenario: "platform.repliesToMention", adapter: "anthropic", outcome: { status: "pass", durationMs: 42 } },
    ]);
  });

  it("gives each adapter of a shared cast its own row", () => {
    const rows = scorecardRows(reported("behavior.multiAgentCollaboration", "anthropic + google-adk", passed));
    expect(rows.map((row) => row.adapter)).toEqual(["anthropic", "google-adk"]);
  });

  it("records a failure with its error messages", () => {
    const failed: TestResult = { state: "failed", errors: [{ message: "no reply within 5ms" } as never] };
    expect(scorecardRows(reported("platform.repliesToMention", "gemini", failed))[0]?.outcome).toEqual({
      status: "fail",
      error: "no reply within 5ms",
      durationMs: 42,
    });
  });

  it("records a pending adapter as N/A with its registry reason", () => {
    const skipped: TestResult = { state: "skipped", errors: undefined, note: "anything" };
    expect(scorecardRows(reported("platform.repliesToMention", "letta", skipped))[0]?.outcome).toEqual({
      status: "na",
      reason: "needs a Letta server provisioned in CI",
    });
  });

  it("records an opt-in skip with its note, and leaves a filtered-out test out", () => {
    const optIn: TestResult = { state: "skipped", errors: undefined, note: "set RUN_CODEX_ACP_E2E=1" };
    const filtered: TestResult = { state: "skipped", errors: undefined, note: undefined };

    expect(scorecardRows(reported("adapters.codexAcpSmoke", "anthropic", optIn))[0]?.outcome).toEqual({
      status: "skip",
      reason: "set RUN_CODEX_ACP_E2E=1",
    });
    expect(scorecardRows(reported("platform.repliesToMention", "anthropic", filtered))).toEqual([]);
  });

  it.each([
    { name: "a test outside any suite", test: { ...reported("x", "anthropic", passed), parent: { type: "module" as const } } },
    { name: "a suite that is not a scenario id", test: reported("ToolCallingAdapter", "anthropic", passed) },
    { name: "a test that is not an adapter id", test: reported("platform.repliesToMention", "some other case", passed) },
  ])("ignores $name", ({ test }) => {
    expect(scorecardRows(test)).toEqual([]);
  });
});
