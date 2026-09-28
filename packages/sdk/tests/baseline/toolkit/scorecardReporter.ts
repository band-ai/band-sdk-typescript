/**
 * The one wiring point between vitest and the scorecard: reads every finished
 * `<scenario> > <adapter>` test (the title `perAdapter` gives it, or
 * `<scenario> > <adapter> + <adapter>` for a shared cast, one row each) at run
 * end and writes the scorecard. Neither `perAdapter.ts` nor `scorecard.ts` knows
 * about the other.
 */
import type { Reporter, TestModule, TestResult } from "vitest/node";

import "./adapters";
import { ADAPTER_IDS, CAST_SEPARATOR, CATEGORIES, registry, type AdapterId, type ScenarioId } from "./registry";
import { writeScorecard, type ScorecardOutcome, type ScorecardRow } from "./scorecard";

/** The slice of vitest's `TestCase` a scorecard row is read from. */
export interface ReportedTest {
  name: string;
  parent: { type: "suite"; name: string } | { type: "module" };
  result(): TestResult;
  diagnostic(): { duration: number } | undefined;
}

const SCENARIO_ID = new RegExp(`^(${CATEGORIES.join("|")})\\.\\S+$`);

function isScenarioId(name: string): name is ScenarioId {
  return SCENARIO_ID.test(name);
}

function isAdapterId(name: string): name is AdapterId {
  return (ADAPTER_IDS as readonly string[]).includes(name);
}

function outcome(adapter: AdapterId, test: ReportedTest): ScorecardOutcome | null {
  const result = test.result();
  const durationMs = test.diagnostic()?.duration ?? 0;
  switch (result.state) {
    case "passed":
      return { status: "pass", durationMs };
    case "failed":
      return { status: "fail", error: result.errors.map((error) => error.message).join("\n"), durationMs };
    case "skipped": {
      // A test filtered out of this run (`-t`, a path) is skipped with no note: it did not run, so no row.
      if (!result.note) return null;
      const pending = registry.specs({ include: [adapter], includePending: true })[0]?.pending;
      return pending ? { status: "na", reason: pending } : { status: "skip", reason: result.note };
    }
    case "pending":
      return null;
  }
}

/** The scorecard rows for a finished test — one per adapter in its cast — or none when it is not a scenario cell or did not run. */
export function scorecardRows(test: ReportedTest): ScorecardRow[] {
  const cast = test.name.split(CAST_SEPARATOR);
  if (test.parent.type !== "suite" || !isScenarioId(test.parent.name) || !cast.every(isAdapterId)) {
    return [];
  }
  const scenario = test.parent.name;
  return cast.flatMap((adapter) => {
    const result = outcome(adapter, test);
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
