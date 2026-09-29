/**
 * The one wiring point between vitest and the scorecard: reads every finished
 * `<scenario> > <adapter>` test (the title `perAdapter` gives it, or
 * `<scenario> > <adapter> + <adapter>` for a shared cast, one row each) at run
 * end and writes the scorecard. Neither `perAdapter.ts` nor `scorecard.ts` knows
 * about the other.
 */
import type { Reporter, TestModule, TestResult } from "vitest/node";

import { ADAPTER_IDS, registry, type AdapterId } from "./adapters";
import { CAST_SEPARATOR, CATEGORIES, type AdapterRegistry, type ScenarioId } from "./registry";
import { SCORECARD_STATUS, writeScorecard, type ScorecardOutcome, type ScorecardRow } from "./scorecard";

/** What vitest reports a test's parent as. */
export const TEST_PARENT = { suite: "suite", module: "module" } as const;

/** The slice of vitest's `TestCase` a scorecard row is read from. */
export interface ReportedTest {
  name: string;
  parent: { type: typeof TEST_PARENT.suite; name: string } | { type: typeof TEST_PARENT.module };
  result(): TestResult;
  diagnostic(): { duration: number } | undefined;
}

/** vitest's test states, named once. */
export const TEST_STATE = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  pending: "pending",
} as const satisfies Record<string, TestResult["state"]>;

const SCENARIO_ID = new RegExp(`^(${CATEGORIES.join("|")})\\.\\S+$`);

function isScenarioId(name: string): name is ScenarioId {
  return SCENARIO_ID.test(name);
}

function isAdapterId(name: string): name is AdapterId {
  return (ADAPTER_IDS as readonly string[]).includes(name);
}

/** The roster a scorecard reads why an adapter did not run from. */
export type ScorecardRoster = Pick<AdapterRegistry<AdapterId>, "get">;

function outcome(adapter: AdapterId, test: ReportedTest, roster: ScorecardRoster): ScorecardOutcome | null {
  const result = test.result();
  const durationMs = test.diagnostic()?.duration ?? 0;
  switch (result.state) {
    case TEST_STATE.passed:
      return { status: SCORECARD_STATUS.pass, durationMs };
    case TEST_STATE.failed:
      return { status: SCORECARD_STATUS.fail, error: result.errors.map((error) => error.message).join("\n"), durationMs };
    case TEST_STATE.skipped: {
      // A test filtered out of this run (`-t`, a path) is skipped with no note: it did not run, so no row.
      if (!result.note) return null;
      const { pending, bespokeOnly } = roster.get(adapter);
      const notRun = pending ?? bespokeOnly;
      return notRun ? { status: SCORECARD_STATUS.na, reason: notRun } : { status: SCORECARD_STATUS.skip, reason: result.note };
    }
    case TEST_STATE.pending:
      return null;
  }
}

/** The scorecard rows for a finished test — one per adapter in its cast — or none when it is not a scenario cell or did not run. */
export function scorecardRows(test: ReportedTest, roster: ScorecardRoster = registry): ScorecardRow[] {
  const cast = test.name.split(CAST_SEPARATOR);
  if (test.parent.type !== TEST_PARENT.suite || !isScenarioId(test.parent.name) || !cast.every(isAdapterId)) {
    return [];
  }
  const scenario = test.parent.name;
  return cast.flatMap((adapter) => {
    const result = outcome(adapter, test, roster);
    return result ? [{ scenario, adapter, outcome: result }] : [];
  });
}

export default class ScorecardReporter implements Reporter {
  public onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const rows = testModules
      .flatMap((module) => [...module.children.allTests()])
      .flatMap((test) => scorecardRows(test));
    const path = writeScorecard(rows);
    if (path) {
      console.warn(`baseline scorecard: ${rows.length} row(s) written to ${path}`);
    }
  }
}
