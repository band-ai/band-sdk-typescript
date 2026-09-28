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

import type { AdapterId, ScenarioId } from "./registry";

/** Where to write the scorecard JSON; unset writes nothing. Named as in band-sdk-python. */
export const SCORECARD_JSON_ENV = "BAND_E2E_SCORECARD_JSON";

/**
 * `na` — the adapter is registered but deliberately not run (pending);
 * `skip` — collected, but an opt-in gate kept it from running this time.
 */
export type ScorecardOutcome =
  | { status: "pass"; durationMs: number }
  | { status: "fail"; error: string; durationMs: number }
  | { status: "skip"; reason: string }
  | { status: "na"; reason: string };

export type ScorecardStatus = ScorecardOutcome["status"];

export interface ScorecardRow {
  scenario: ScenarioId;
  adapter: AdapterId;
  outcome: ScorecardOutcome;
}

/** A real outcome beats a stale skip when scorecards are merged. */
const RANK: Record<ScorecardStatus, number> = { skip: 0, na: 1, pass: 2, fail: 3 };

const SYMBOL: Record<ScorecardStatus, string> = { pass: "✅", fail: "❌", skip: "⏭️", na: "N/A" };

const byCell = (a: ScorecardRow, b: ScorecardRow) =>
  a.scenario.localeCompare(b.scenario) || a.adapter.localeCompare(b.adapter);

/** Unions scorecards, keeping each cell's highest-ranked outcome. */
export function merge(...scorecards: ScorecardRow[][]): ScorecardRow[] {
  const best = new Map<string, ScorecardRow>();
  for (const row of scorecards.flat()) {
    const key = `${row.scenario}\u0000${row.adapter}`;
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
  const status = new Map(rows.map((row) => [`${row.scenario}\u0000${row.adapter}`, row.outcome.status]));
  const symbolAt = (scenario: string, adapter: string) => {
    const cell = status.get(`${scenario}\u0000${adapter}`);
    return cell ? SYMBOL[cell] : "·";
  };

  const lines = [
    `| scenario | ${adapters.join(" | ")} |`,
    `| --- ${"| --- ".repeat(adapters.length)}|`,
    ...scenarios.map((scenario) => `| ${scenario} | ${adapters.map((adapter) => symbolAt(scenario, adapter)).join(" | ")} |`),
  ];

  const reasoned = rows.filter((row) => row.outcome.status === "na" || row.outcome.status === "skip").sort(byCell);
  if (reasoned.length > 0) {
    lines.push("", "**N/A and skip reasons**", "");
    for (const row of reasoned) {
      const { reason } = row.outcome as { reason: string };
      lines.push(`- \`${row.scenario}\` / \`${row.adapter}\` — ${SYMBOL[row.outcome.status]} ${reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
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
  writeFileSync(path.replace(/\.json$/, "") + ".md", toMarkdown(sorted));
  return path;
}
