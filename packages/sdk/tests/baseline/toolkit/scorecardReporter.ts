/**
 * The one wiring point between vitest and the scorecard: at run end, reads every finished test, file or suite error
 * and unhandled error and writes the scorecard. A `<scenario> > <adapter>` test (the title `perAdapter` gives it, or
 * `<scenario> > <adapter> + <adapter>` for a shared cast) is one row per adapter; a failure with no adapter is a
 * `(no adapter)` cell, and one no scenario owns is the `(general)` row. Neither `perAdapter.ts` nor `scorecard.ts`
 * knows about the other.
 */
import type { Reporter, SerializedError, TestModule, TestResult } from "vitest/node";

import { ADAPTER_IDS, registry, type AdapterId } from "./adapters";
import { CAST_SEPARATOR, CATEGORIES, scenarioIdFromModulePath, type AdapterRegistry, type ScenarioId } from "./registry";
import {
  GENERAL_SCENARIO,
  NO_ADAPTER,
  SCORECARD_STATUS,
  merge,
  writeScorecard,
  type ScorecardOutcome,
  type ScorecardRow,
} from "./scorecard";

/** What vitest reports a test's parent as. */
export const TEST_PARENT = { suite: "suite", module: "module" } as const;

/** What the reporter reads of an error: vitest's `TestError` and `SerializedError` both fit. */
export interface ReportedError {
  message: string;
}

/** The slice of vitest's `TestCase` a scorecard row is read from. */
export interface ReportedTest {
  name: string;
  fullName: string;
  module: { relativeModuleId: string };
  parent: { type: typeof TEST_PARENT.suite; name: string } | { type: typeof TEST_PARENT.module };
  result(): TestResult;
  diagnostic(): { duration: number } | undefined;
}

/** The slice of vitest's `TestSuite` an error row is read from. */
export interface ReportedSuite {
  name: string;
  fullName: string;
  errors(): ReadonlyArray<ReportedError>;
}

/** The slice of vitest's `TestModule` (a test file) a scorecard is read from. */
export interface ReportedModule {
  relativeModuleId: string;
  errors(): ReadonlyArray<ReportedError>;
  children: { allTests(): Iterable<ReportedTest>; allSuites(): Iterable<ReportedSuite> };
}

/** vitest's test states, named once. */
export const TEST_STATE = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  pending: "pending",
} as const satisfies Record<string, TestResult["state"]>;

/** Joins a file to what failed in it; the separator vitest itself uses in a test's `fullName`. */
export const SOURCE_SEPARATOR = " > ";

/** The duration of a failure that has no test behind it. */
export const NO_TEST_DURATION_MS = 0;

const SCENARIO_ID = new RegExp(`^(${CATEGORIES.join("|")})\\.\\S+$`);

function isScenarioId(name: string): name is ScenarioId {
  return SCENARIO_ID.test(name);
}

function isAdapterId(name: string): name is AdapterId {
  return (ADAPTER_IDS as readonly string[]).includes(name);
}

/** The roster a scorecard reads why an adapter did not run from. */
export type ScorecardRoster = Pick<AdapterRegistry<AdapterId>, "get">;

/** A failed outcome; `source` says where the errors came from when no test title does. */
function failure(errors: ReadonlyArray<ReportedError> | undefined, durationMs: number, source?: string): ScorecardOutcome {
  const messages = (errors ?? []).map((error) => error.message).join("\n");
  return { status: SCORECARD_STATUS.fail, error: source ? `${source}: ${messages}` : messages, durationMs };
}

/** The `(no adapter)` row for errors raised outside any test; none when there are none. */
function failureRows(scenario: ScorecardRow["scenario"], errors: ReadonlyArray<ReportedError>, source?: string): ScorecardRow[] {
  return errors.length > 0 ? [{ scenario, adapter: NO_ADAPTER, outcome: failure(errors, NO_TEST_DURATION_MS, source) }] : [];
}

const durationOf = (test: ReportedTest) => test.diagnostic()?.duration ?? NO_TEST_DURATION_MS;

const inModule = (relativeModuleId: string, name: string) => `${relativeModuleId}${SOURCE_SEPARATOR}${name}`;

/**
 * The scenario id a file is named after, from `<category>/<name>.test.ts`; `(general)` outside that layout.
 * A file that defines several scenarios has no cell of that id, which still names the file.
 */
function moduleScenario(relativeModuleId: string): ScorecardRow["scenario"] {
  const candidate = scenarioIdFromModulePath(relativeModuleId);
  return isScenarioId(candidate) ? candidate : GENERAL_SCENARIO;
}

function outcome(adapter: ScorecardRow["adapter"], test: ReportedTest, roster: ScorecardRoster): ScorecardOutcome | null {
  const result = test.result();
  const durationMs = durationOf(test);
  switch (result.state) {
    case TEST_STATE.passed:
      return { status: SCORECARD_STATUS.pass, durationMs };
    case TEST_STATE.failed:
      return failure(result.errors, durationMs, adapter === NO_ADAPTER ? test.name : undefined);
    case TEST_STATE.skipped: {
      // A test filtered out of this run (`-t`, a path) is skipped with no note: it did not run, so no row.
      if (!result.note) return null;
      // A cell with no adapter is not in the roster.
      const spec = adapter === NO_ADAPTER ? undefined : roster.get(adapter);
      const notRun = spec?.pending ?? spec?.bespokeOnly;
      return notRun ? { status: SCORECARD_STATUS.na, reason: notRun } : { status: SCORECARD_STATUS.skip, reason: result.note };
    }
    case TEST_STATE.pending:
      return null;
  }
}

/** A failed test no scenario cell owns fails its file's cell; one that passed or was skipped has nothing to report. */
function unmappedRows(test: ReportedTest): ScorecardRow[] {
  const result = test.result();
  if (result.state !== TEST_STATE.failed) return [];
  const { relativeModuleId } = test.module;
  const outcome = failure(result.errors, durationOf(test), inModule(relativeModuleId, test.fullName));
  return [{ scenario: moduleScenario(relativeModuleId), adapter: NO_ADAPTER, outcome }];
}

/**
 * The scorecard rows for a finished test: one per adapter in its cast, or one `(no adapter)` row under any other title.
 * None when it did not run; a failed test outside any scenario suite fails its file's cell.
 */
export function scorecardRows(test: ReportedTest, roster: ScorecardRoster = registry): ScorecardRow[] {
  const { parent } = test;
  if (parent.type !== TEST_PARENT.suite || !isScenarioId(parent.name)) {
    return unmappedRows(test);
  }
  const scenario = parent.name;
  const cast = test.name.split(CAST_SEPARATOR);
  const adapters: ScorecardRow["adapter"][] = cast.every(isAdapterId) ? cast : [NO_ADAPTER];
  return adapters.flatMap((adapter) => {
    const result = outcome(adapter, test, roster);
    return result ? [{ scenario, adapter, outcome: result }] : [];
  });
}

/** Rows for a file or suite that errored outside any test: a load failure, a throwing hook, an empty suite. */
export function errorRows(module: ReportedModule): ScorecardRow[] {
  const { relativeModuleId } = module;
  const fileScenario = moduleScenario(relativeModuleId);
  return [
    ...failureRows(fileScenario, module.errors(), relativeModuleId),
    ...[...module.children.allSuites()].flatMap((suite) => {
      const scenario = isScenarioId(suite.name) ? suite.name : fileScenario;
      return failureRows(scenario, suite.errors(), inModule(relativeModuleId, suite.fullName));
    }),
  ];
}

/**
 * Every row of a finished run. Structural errors are merged before test rows so hook failures are recorded before
 * adapterless test failures in the same cell; `merge` keeps the worst rank per cell and joins equal `fail` messages.
 */
export function runRows(
  modules: ReadonlyArray<ReportedModule>,
  unhandledErrors: ReadonlyArray<ReportedError>,
  roster: ScorecardRoster = registry,
): ScorecardRow[] {
  return merge(
    modules.flatMap((module) => errorRows(module)),
    modules.flatMap((module) => [...module.children.allTests()].flatMap((test) => scorecardRows(test, roster))),
    // Errors raised outside every test, which vitest still exits non-zero on.
    failureRows(GENERAL_SCENARIO, unhandledErrors),
  );
}

export default class ScorecardReporter implements Reporter {
  public onTestRunEnd(testModules: ReadonlyArray<TestModule>, unhandledErrors: ReadonlyArray<SerializedError>): void {
    const rows = runRows(testModules, unhandledErrors);
    const path = writeScorecard(rows);
    if (path) {
      console.warn(`baseline scorecard: ${rows.length} row(s) written to ${path}`);
    }
  }
}
