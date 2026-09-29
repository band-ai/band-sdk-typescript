/**
 * The scenario × adapter scorecard: pass / fail / skip / N/A in one artifact.
 * Pure data, merge, and rendering — how a run's outcomes are collected is
 * `scorecardReporter.ts`'s job.
 *
 * Written once, when the run ends: a cancelled or timed-out run leaves no
 * scorecard at all, the same as band-sdk-python's.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AdapterId } from "./adapters";
import type { ScenarioId } from "./registry";

/** Where to write the scorecard JSON; unset writes nothing. Named as in band-sdk-python. */
export const SCORECARD_JSON_ENV = "BAND_E2E_SCORECARD_JSON";

/**
 * `na` — the adapter is registered but deliberately not run (pending);
 * `skip` — collected, but an opt-in gate kept it from running this time.
 */
export const SCORECARD_STATUS = { pass: "pass", fail: "fail", skip: "skip", na: "na" } as const;

export type ScorecardOutcome =
  | { status: typeof SCORECARD_STATUS.pass; durationMs: number }
  | { status: typeof SCORECARD_STATUS.fail; error: string; durationMs: number }
  | { status: typeof SCORECARD_STATUS.skip; reason: string }
  | { status: typeof SCORECARD_STATUS.na; reason: string };

export type ScorecardStatus = ScorecardOutcome["status"];

/**
 * Reserved labels, both starting with `(` so the grid's code-point sort puts them first: the column for a result with
 * no roster adapter behind it, and the row for a failure no scenario can own (an unhandled error, a file outside
 * `scenarios/<category>/`).
 */
export const NO_ADAPTER = "(no adapter)";
export const GENERAL_SCENARIO = "(general)";

export interface ScorecardRow {
  scenario: ScenarioId | typeof GENERAL_SCENARIO;
  adapter: AdapterId | typeof NO_ADAPTER;
  outcome: ScorecardOutcome;
}

/** A real outcome beats a stale skip when scorecards are merged. */
const RANK: Record<ScorecardStatus, number> = {
  [SCORECARD_STATUS.skip]: 0,
  [SCORECARD_STATUS.na]: 1,
  [SCORECARD_STATUS.pass]: 2,
  [SCORECARD_STATUS.fail]: 3,
};

const SYMBOL: Record<ScorecardStatus, string> = {
  [SCORECARD_STATUS.pass]: "✅",
  [SCORECARD_STATUS.fail]: "❌",
  [SCORECARD_STATUS.skip]: "⏭️",
  [SCORECARD_STATUS.na]: "N/A",
};

/** The grid's mark for a cell the run has no row for. */
const NO_ROW = "·";

/** The statuses that carry a reason, listed under the grid. */
const REASONED: ReadonlySet<ScorecardStatus> = new Set([SCORECARD_STATUS.na, SCORECARD_STATUS.skip]);

const cellKey = (scenario: string, adapter: string) => `${scenario}\u0000${adapter}`;

const byCell = (a: ScorecardRow, b: ScorecardRow) =>
  a.scenario.localeCompare(b.scenario) || a.adapter.localeCompare(b.adapter);

/** Unions scorecards, keeping each cell's highest-ranked outcome; of equal ranks, the first row wins. */
export function merge(...scorecards: ScorecardRow[][]): ScorecardRow[] {
  const best = new Map<string, ScorecardRow>();
  for (const row of scorecards.flat()) {
    const key = cellKey(row.scenario, row.adapter);
    const current = best.get(key);
    if (!current || RANK[row.outcome.status] > RANK[current.outcome.status]) {
      best.set(key, row);
    }
  }
  return [...best.values()].sort(byCell);
}

/** A pivot grid (scenario × adapter) plus the N/A and skip reasons. Failure details stay in the JSON. */
export function toMarkdown(rows: ScorecardRow[]): string {
  const scenarios = [...new Set(rows.map((row) => row.scenario))].sort();
  const adapters = [...new Set(rows.map((row) => row.adapter))].sort();
  const status = new Map(rows.map((row) => [cellKey(row.scenario, row.adapter), row.outcome.status]));
  const symbolAt = (scenario: string, adapter: string) => {
    const cell = status.get(cellKey(scenario, adapter));
    return cell ? SYMBOL[cell] : NO_ROW;
  };

  const lines = [
    `| scenario | ${adapters.join(" | ")} |`,
    `| --- ${"| --- ".repeat(adapters.length)}|`,
    ...scenarios.map((scenario) => `| ${scenario} | ${adapters.map((adapter) => symbolAt(scenario, adapter)).join(" | ")} |`),
  ];

  const reasoned = rows.filter((row) => REASONED.has(row.outcome.status)).sort(byCell);
  if (reasoned.length > 0) {
    lines.push("", "**N/A and skip reasons**", "");
    for (const row of reasoned) {
      const { reason } = row.outcome as { reason: string };
      lines.push(`- \`${row.scenario}\` / \`${row.adapter}\` — ${SYMBOL[row.outcome.status]} ${reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Where the markdown grid is written, beside the JSON. */
export function markdownPath(jsonPath: string): string {
  return jsonPath.replace(/\.json$/, "") + ".md";
}

/**
 * Writes the scorecard as JSON to `$BAND_E2E_SCORECARD_JSON`, with its markdown
 * grid beside it (`.md`). Returns the JSON path, or null when the variable is unset.
 */
export function writeScorecard(rows: ScorecardRow[], env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env[SCORECARD_JSON_ENV];
  if (!path) {
    return null;
  }
  const sorted = [...rows].sort(byCell);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
  writeFileSync(markdownPath(path), toMarkdown(sorted));
  return path;
}
