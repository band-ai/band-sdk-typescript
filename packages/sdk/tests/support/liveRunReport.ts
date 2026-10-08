import { z } from "zod";
import type { TestResult } from "vitest/node";

import { SCORECARD_STATUS, type ScorecardRow } from "../baseline/toolkit/scorecard";

/** The states read from Vitest, shared by both reporters. */
export const TEST_STATE = { passed: "passed", failed: "failed", skipped: "skipped", pending: "pending" } as const satisfies Record<string, TestResult["state"]>;

export const LIVE_REPORT_ENV = "BAND_E2E_LIVE_REPORT_JSON";
export const LIVE_LANES = {
  sdk: { name: "SDK baseline", step: "Run the live baseline", file: "sdk-live.json" },
  plugin: { name: "Claude Code plugin", step: "Run the Claude Code plugin live lane", file: "plugin-live.json" },
} as const;

const nonempty = z.string().min(1);
const duration = z.number().finite().nonnegative();
export const reportedErrorSchema = z.object({ message: z.string(), stack: z.string().optional() }).strict();
const testSchema = z.object({
  id: nonempty,
  name: nonempty,
  fullName: nonempty,
  parent: z.discriminatedUnion("type", [z.object({ type: z.literal("suite"), name: nonempty }).strict(), z.object({ type: z.literal("module") }).strict()]),
  state: z.enum(Object.values(TEST_STATE)),
  mode: z.enum(["run", "skip", "todo", "only"]),
  filtered: z.boolean(),
  note: z.string().optional(),
  durationMs: duration,
  retryCount: z.number().int().nonnegative(),
  repeatCount: z.number().int().nonnegative(),
  flaky: z.boolean(),
  errors: z.array(reportedErrorSchema),
}).strict();
export const liveRunSchema = z.object({
  version: z.literal(1),
  lane: z.enum(["sdk", "plugin"]),
  reason: z.enum(["passed", "failed", "interrupted"]),
  modules: z.array(z.object({
    file: nonempty,
    errors: z.array(reportedErrorSchema),
    suites: z.array(z.object({ name: nonempty, fullName: nonempty, errors: z.array(reportedErrorSchema) }).strict()),
    tests: z.array(testSchema),
  }).strict()),
  unhandledErrors: z.array(reportedErrorSchema),
}).strict();

export type LiveRun = z.infer<typeof liveRunSchema>;
export type LiveTest = LiveRun["modules"][number]["tests"][number];
export type LiveLane = keyof typeof LIVE_LANES;

export const workflowMetadataSchema = z.object({
  run: z.object({ id: z.number().int().positive(), run_attempt: z.number().int().positive(), head_sha: nonempty, status: nonempty }),
  jobs: z.array(z.object({
    name: nonempty, run_id: z.number().int().positive(), head_sha: nonempty, status: nonempty, conclusion: z.string().nullable(),
    steps: z.array(z.object({ name: nonempty, number: z.number().int().positive(), status: nonempty, conclusion: z.string().nullable() })),
  })),
});

export const matrixSchema = z.array(z.object({
  scenario: nonempty,
  adapter: nonempty,
  outcome: z.discriminatedUnion("status", [
    z.object({ status: z.literal(SCORECARD_STATUS.pass), durationMs: duration }).strict(),
    z.object({ status: z.literal(SCORECARD_STATUS.fail), durationMs: duration, error: z.string() }).strict(),
    z.object({ status: z.literal(SCORECARD_STATUS.na), reason: nonempty }).strict(),
    z.object({ status: z.literal(SCORECARD_STATUS.skip), reason: nonempty }).strict(),
  ]),
}).strict()).min(1);

export function isFiltered(test: LiveTest): boolean {
  return test.filtered;
}

export function liveCounts(run: LiveRun) {
  const tests = run.modules.flatMap((module) => module.tests);
  return {
    passed: tests.filter((test) => test.state === TEST_STATE.passed).length,
    failed: tests.filter((test) => test.state === TEST_STATE.failed).length,
    excluded: tests.filter((test) => test.state === TEST_STATE.skipped && !isFiltered(test)).length,
    filtered: tests.filter(isFiltered).length,
    pending: tests.filter((test) => test.state === TEST_STATE.pending).length,
  };
}

/** Execution integrity is stricter than the last attempt's test state. */
export function laneProblems(run: LiveRun): string[] {
  const problems: string[] = [];
  if (run.reason !== "passed") problems.push(`run ended ${run.reason}`);
  const seenModules = new Set<string>();
  const seenTests = new Set<string>();
  const seenNames = new Set<string>();
  for (const module of run.modules) {
    if (seenModules.has(module.file)) problems.push(`duplicate module ${module.file}`);
    seenModules.add(module.file);
    for (const error of module.errors) problems.push(`${module.file}: ${error.message}`);
    for (const suite of module.suites) for (const error of suite.errors) problems.push(`${module.file} > ${suite.fullName}: ${error.message}`);
    for (const test of module.tests) {
      const identity = `${module.file} > ${test.fullName}`;
      if (seenTests.has(test.id)) problems.push(`duplicate test ${identity}`);
      seenTests.add(test.id);
      if (seenNames.has(identity)) problems.push(`duplicate test identity ${identity}`);
      seenNames.add(identity);
      if (test.filtered && (test.state !== TEST_STATE.skipped || test.note)) problems.push(`${identity}: contradictory filtered result`);
      if (test.state === TEST_STATE.failed || test.state === TEST_STATE.pending) problems.push(`${identity}: ${test.state}`);
      for (const error of test.errors) problems.push(`${identity}: ${error.message}`);
      if (test.retryCount || test.repeatCount || test.flaky) problems.push(`${identity}: first-attempt evidence rejected (retries ${test.retryCount}, repeats ${test.repeatCount}, flaky ${test.flaky})`);
    }
  }
  for (const error of run.unhandledErrors) problems.push(`unhandled: ${error.message}`);
  const counts = liveCounts(run);
  if (counts.passed + counts.failed === 0) problems.push("no executed tests");
  return problems;
}

const cellKey = (row: { scenario: string; adapter: string }) => `${row.scenario}\u0000${row.adapter}`;

/** Compare against the same selected-test projection that writes the SDK matrix. */
export function matrixProblems(matrix: z.infer<typeof matrixSchema>, expected: ScorecardRow[]): string[] {
  const problems: string[] = [];
  const cells = new Map<string, typeof matrix[number]>();
  for (const row of matrix) {
    const key = cellKey(row);
    if (cells.has(key)) problems.push(`duplicate matrix cell ${row.scenario} / ${row.adapter}`);
    cells.set(key, row);
  }
  for (const row of expected) {
    const actual = cells.get(cellKey(row));
    if (!actual) problems.push(`missing matrix cell ${row.scenario} / ${row.adapter}`);
    else if (Object.entries(row.outcome).some(([key, value]) => actual.outcome[key as keyof typeof actual.outcome] !== value)) problems.push(`contradictory matrix cell ${row.scenario} / ${row.adapter}`);
    cells.delete(cellKey(row));
  }
  for (const row of cells.values()) problems.push(`unexpected matrix cell ${row.scenario} / ${row.adapter}`);
  return problems;
}

export function validateLiveEvidence(
  evidence: { sdk: unknown; plugin: unknown; matrix: unknown },
  outcomes: Partial<Record<LiveLane, string>>,
  project: (run: LiveRun) => ScorecardRow[],
) {
  const problems: string[] = [];
  const lanes: Partial<Record<LiveLane, LiveRun>> = {};
  for (const lane of Object.keys(LIVE_LANES) as LiveLane[]) {
    const parsed = liveRunSchema.safeParse(evidence[lane]);
    if (!parsed.success) problems.push(`${LIVE_LANES[lane].name}: missing or malformed evidence (${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")})`);
    else if (parsed.data.lane !== lane) problems.push(`${LIVE_LANES[lane].name}: wrong lane identity`);
    else {
      lanes[lane] = parsed.data;
      problems.push(...laneProblems(parsed.data).map((problem) => `${LIVE_LANES[lane].name}: ${problem}`));
    }
    if (outcomes[lane] !== "success") problems.push(`${LIVE_LANES[lane].name}: test step ${outcomes[lane] ?? "unknown"}`);
  }
  const matrix = matrixSchema.safeParse(evidence.matrix);
  if (!matrix.success) problems.push("SDK matrix: missing, empty or malformed evidence");
  else if (lanes.sdk) {
    for (const module of lanes.sdk.modules) for (const test of module.tests) {
      if (isFiltered(test)) continue;
      const projected = project({ ...lanes.sdk, modules: [{ ...module, errors: [], suites: [], tests: [test] }], unhandledErrors: [] });
      if (projected.length === 0) problems.push(`SDK matrix: selected test has no projected cell (${module.file} > ${test.fullName})`);
    }
    problems.push(...matrixProblems(matrix.data, project(lanes.sdk)).map((problem) => `SDK matrix: ${problem}`));
  }
  else problems.push("SDK matrix: selected-test completeness cannot be verified without SDK lane evidence");
  return { lanes, matrix: matrix.success ? matrix.data : null, problems };
}
