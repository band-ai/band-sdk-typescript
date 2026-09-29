import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestResult } from "vitest/node";

import { ADAPTER, type AdapterId } from "./adapters";
import { fakeSpec } from "./fakeSpec";
import { AdapterRegistry, CAST_SEPARATOR, CATEGORY, scenarioId } from "./registry";
import {
  GENERAL_SCENARIO,
  NO_ADAPTER,
  SCORECARD_JSON_ENV,
  SCORECARD_STATUS,
  type ScorecardOutcome,
  type ScorecardRow,
} from "./scorecard";
import ScorecardReporter, {
  NO_TEST_DURATION_MS,
  SOURCE_SEPARATOR,
  TEST_PARENT,
  TEST_STATE,
  errorRows,
  runRows,
  scorecardRows,
  type ReportedModule,
  type ReportedSuite,
  type ReportedTest,
} from "./scorecardReporter";

const REPLIES = scenarioId(CATEGORY.platform, "repliesToMention");
const REPLIES_FILE = "tests/baseline/scenarios/platform/repliesToMention.test.ts";
const RECONNECT = scenarioId(CATEGORY.behavior, "reconnect");
const RECONNECT_FILE = "tests/baseline/scenarios/behavior/reconnect.test.ts";
const BEHAVIOUR_TITLE = "keeps going";
const DURATION_MS = 42;
const FAILURE = "no reply within 5ms";
const HOOK_FAILURE = "afterAll blew up";
const UNHANDLED_FAILURE = "stray rejection";
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

/** A finished test as vitest reports it, titled the way `perAdapter` titles it, in the replies scenario's file. */
function reported(suite: string, name: string, result: TestResult): ReportedTest {
  return {
    name,
    fullName: `${suite}${SOURCE_SEPARATOR}${name}`,
    module: { relativeModuleId: REPLIES_FILE },
    parent: { type: TEST_PARENT.suite, name: suite },
    result: () => result,
    diagnostic: () => ({ duration: DURATION_MS }),
  };
}

const toErrors = (messages: string[]) => messages.map((message) => ({ message }));

/** A suite as vitest reports it; its errors are the ones its own hooks threw. */
const reportedSuite = (name: string, errors: string[] = []): ReportedSuite => ({
  name,
  fullName: name,
  errors: () => toErrors(errors),
});

/** A test file as vitest reports it. */
function reportedModule(
  relativeModuleId: string,
  { errors = [], suites = [], tests = [] }: { errors?: string[]; suites?: ReportedSuite[]; tests?: ReportedTest[] } = {},
): ReportedModule {
  return {
    relativeModuleId,
    errors: () => toErrors(errors),
    children: { allTests: () => tests, allSuites: () => suites },
  };
}

const passed: TestResult = { state: TEST_STATE.passed, errors: undefined };
const failed: TestResult = { state: TEST_STATE.failed, errors: toErrors([FAILURE]) };
const skipped = (note?: string): TestResult => ({ state: TEST_STATE.skipped, errors: undefined, note });

const PASS: ScorecardOutcome = { status: SCORECARD_STATUS.pass, durationMs: DURATION_MS };
const failWith = (error: string, durationMs = NO_TEST_DURATION_MS): ScorecardOutcome => ({
  status: SCORECARD_STATUS.fail,
  error,
  durationMs,
});
const noAdapter = (scenario: ScorecardRow["scenario"], outcome: ScorecardOutcome): ScorecardRow => ({
  scenario,
  adapter: NO_ADAPTER,
  outcome,
});

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

  describe("a test in a scenario whose title is not an adapter", () => {
    const rows = (result: TestResult) => scorecardRows(reported(REPLIES, BEHAVIOUR_TITLE, result), roster);

    it("passes in the (no adapter) column", () => {
      expect(rows(passed)).toEqual([noAdapter(REPLIES, PASS)]);
    });

    it("fails there, naming the test", () => {
      expect(rows(failed)).toEqual([noAdapter(REPLIES, failWith(`${BEHAVIOUR_TITLE}: ${FAILURE}`, DURATION_MS))]);
    });

    it("is skipped with its note, never N/A, and leaves a filtered-out test out", () => {
      expect(rows(skipped(OPT_IN_NOTE))).toEqual([noAdapter(REPLIES, { status: SCORECARD_STATUS.skip, reason: OPT_IN_NOTE })]);
      expect(rows(skipped())).toEqual([]);
    });
  });

  describe.each([
    {
      name: "a test outside any suite",
      make: (result: TestResult): ReportedTest => ({
        ...reported(REPLIES, ADAPTER.anthropic, result),
        fullName: ADAPTER.anthropic,
        parent: { type: TEST_PARENT.module },
      }),
    },
    {
      name: "a suite that is not a scenario id",
      make: (result: TestResult) => reported("ToolCallingAdapter", ADAPTER.anthropic, result),
    },
  ])("$name", ({ make }) => {
    it("has nothing to report once it passed", () => {
      expect(scorecardRows(make(passed), roster)).toEqual([]);
    });

    it("fails its file's cell once it failed", () => {
      const test = make(failed);
      expect(scorecardRows(test, roster)).toEqual([
        noAdapter(REPLIES, failWith(`${REPLIES_FILE}${SOURCE_SEPARATOR}${test.fullName}: ${FAILURE}`, DURATION_MS)),
      ]);
    });
  });
});

describe("errorRows", () => {
  it.each<{ name: string; file: string; scenario: ScorecardRow["scenario"] }>([
    { name: "a scenario file", file: RECONNECT_FILE, scenario: RECONNECT },
    { name: "the same file under the repo root", file: `packages/sdk/${RECONNECT_FILE}`, scenario: RECONNECT },
    { name: "a file under samples", file: "tests/baseline/scenarios/samples/markers.test.ts", scenario: GENERAL_SCENARIO },
    { name: "a file directly under scenarios", file: "tests/baseline/scenarios/loose.test.ts", scenario: GENERAL_SCENARIO },
  ])("fails the cell $name is named after, or (general) outside the layout, when it fails to load", ({ file, scenario }) => {
    expect(errorRows(reportedModule(file, { errors: [FAILURE] }))).toEqual([noAdapter(scenario, failWith(`${file}: ${FAILURE}`))]);
  });

  it.each([
    { name: "a suite named as a scenario id", suite: REPLIES, scenario: REPLIES },
    { name: "any other suite", suite: "nested group", scenario: RECONNECT },
  ])("fails the cell $name maps to when its hook errors", ({ suite, scenario }) => {
    const module = reportedModule(RECONNECT_FILE, { suites: [reportedSuite(suite, [HOOK_FAILURE])] });
    const error = `${RECONNECT_FILE}${SOURCE_SEPARATOR}${suite}: ${HOOK_FAILURE}`;
    expect(errorRows(module)).toEqual([noAdapter(scenario, failWith(error))]);
  });

  it("has nothing to report when neither the file nor its suites errored", () => {
    expect(errorRows(reportedModule(REPLIES_FILE, { suites: [reportedSuite(REPLIES)] }))).toEqual([]);
  });
});

describe("runRows", () => {
  it("keeps one row per cell, the fail winning, with module errors and unhandled errors in the grid", () => {
    const plain = reportedModule(REPLIES_FILE, {
      tests: [reported(REPLIES, BEHAVIOUR_TITLE, failed), reported(REPLIES, "checks another thing", passed)],
    });
    const broken = reportedModule(RECONNECT_FILE, { errors: [FAILURE] });

    expect(runRows([plain, broken], toErrors([UNHANDLED_FAILURE, FAILURE]), roster)).toEqual([
      noAdapter(GENERAL_SCENARIO, failWith(`${UNHANDLED_FAILURE}\n${FAILURE}`)),
      noAdapter(RECONNECT, failWith(`${RECONNECT_FILE}: ${FAILURE}`)),
      noAdapter(REPLIES, failWith(`${BEHAVIOUR_TITLE}: ${FAILURE}`, DURATION_MS)),
    ]);
  });

  it("keeps a hook's error text over a failing test's in the same cell", () => {
    const module = reportedModule(REPLIES_FILE, {
      suites: [reportedSuite(REPLIES, [HOOK_FAILURE])],
      tests: [reported(REPLIES, BEHAVIOUR_TITLE, failed)],
    });
    expect(runRows([module], [], roster)).toEqual([
      noAdapter(REPLIES, failWith(`${REPLIES_FILE}${SOURCE_SEPARATOR}${REPLIES}: ${HOOK_FAILURE}`)),
    ]);
  });
});

describe("ScorecardReporter.onTestRunEnd", () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes the module's rows and the unhandled errors to the scorecard", () => {
    dir = mkdtempSync(join(tmpdir(), "scorecard-reporter-"));
    const path = join(dir, "scorecard.json");
    // vitest builds a reporter as `new Reporter(options)`, so the environment is the only way in.
    vi.stubEnv(SCORECARD_JSON_ENV, path);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const module = reportedModule(RECONNECT_FILE, { tests: [reported(RECONNECT, BEHAVIOUR_TITLE, passed)] });

    new ScorecardReporter().onTestRunEnd([module], toErrors([UNHANDLED_FAILURE]));

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([
      noAdapter(GENERAL_SCENARIO, failWith(UNHANDLED_FAILURE)),
      noAdapter(RECONNECT, PASS),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(path));
  });
});
